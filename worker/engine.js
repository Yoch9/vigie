// Cœur de Vigie version Cloudflare : état dans D1, une exécution planifiée par minute.
//
// Contraintes de l'offre gratuite qui dictent la conception :
//  - 50 sous-requêtes par exécution (fetch, sockets ET requêtes D1) -> lectures/écritures D1 groupées
//    en un seul batch, au plus MAX_CHECKS vérifications par minute ;
//  - 6 connexions simultanées -> vérifications par paquets de 6 ;
//  - 100 000 lignes écrites par jour -> une seule écriture par vérification (table hours), l'état n'est
//    réécrit que lorsqu'il change ;
//  - 10 ms de CPU -> peu de JSON à décoder (seules les dernières heures de battements sont lues).
import { runCheck } from './checks.js';
import { NOTIFIER_TYPES as ALL_TYPES, senders } from '../shared/notifiers.js';
import { InputError, sanitizeMonitor, sanitizeNotifier, maskNotifier, str } from '../shared/validate.js';

export { InputError };

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_CHECKS = 40;
const CONCURRENCY = 6;
const UP = 1;
const DOWN = 0;

// pas de SMTP dans un Worker : e-mail via l'API Brevo ou Resend
export const NOTIFIER_TYPES = Object.fromEntries(Object.entries(ALL_TYPES).filter(([k]) => k !== 'email'));

const CAPS = {
  platform: 'cloudflare',
  live: false,
  monitorTypes: ['http', 'keyword', 'tcp', 'dns', 'push'],
  minInterval: 60,
  intervalStep: 60,
  maxRetryInterval: 30,
  tlsOptions: false,
};

// --- Accès D1 ----------------------------------------------------------------

const parseRows = (rows) => rows.map((r) => JSON.parse(r.data));

async function loadConfig(db) {
  const [monitors, notifiers, state, meta] = await db.batch([
    db.prepare('SELECT data FROM monitors ORDER BY created_at'),
    db.prepare('SELECT data FROM notifiers'),
    db.prepare('SELECT monitor_id, data FROM state'),
    db.prepare('SELECT key, value FROM meta'),
  ]);
  return {
    monitors: parseRows(monitors.results),
    notifiers: parseRows(notifiers.results),
    state: Object.fromEntries(state.results.map((r) => [r.monitor_id, JSON.parse(r.data)])),
    meta: Object.fromEntries(meta.results.map((r) => [r.key, r.value])),
  };
}

const newState = () => ({ status: 'unknown', lastChange: null, lastNotifiedAt: null, lastPushAt: null });

const setMeta = (db, key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value));

const saveMonitor = (db, m) =>
  db.prepare('INSERT INTO monitors (id, data, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = excluded.data').bind(m.id, JSON.stringify(m), m.createdAt);

const saveState = (db, id, st) =>
  db.prepare('INSERT INTO state (monitor_id, data) VALUES (?1, ?2) ON CONFLICT(monitor_id) DO UPDATE SET data = excluded.data').bind(id, JSON.stringify(st));

const insertEvent = (db, m, kind, msg, t = Date.now()) =>
  db.prepare('INSERT INTO events (t, monitor_id, name, kind, msg) VALUES (?1, ?2, ?3, ?4, ?5)').bind(t, m?.id ?? null, m?.name ?? 'Vigie', kind, String(msg).slice(0, 500));

// Battement : [horodatage, code (1 up / 0 down), ms, message], ajouté à la ligne de l'heure en cours.
function insertBeat(db, m, t, code, ms, msg) {
  const hour = Math.floor(t / HOUR) * HOUR;
  const okMs = code === UP && ms !== null ? ms : null;
  return db
    .prepare(
      `INSERT INTO hours (monitor_id, hour, up, total, sum_ms, n_ms, beats) VALUES (?1, ?2, ?3, 1, ?4, ?5, json_array(json(?6)))
       ON CONFLICT(monitor_id, hour) DO UPDATE SET
         up = up + excluded.up, total = total + 1, sum_ms = sum_ms + excluded.sum_ms, n_ms = n_ms + excluded.n_ms,
         beats = json_insert(COALESCE(beats, '[]'), '$[#]', json(?6))`,
    )
    .bind(m.id, hour, code === DOWN ? 0 : 1, okMs ?? 0, okMs === null ? 0 : 1, JSON.stringify([t, code, ms, String(msg).slice(0, 300)]));
}

// --- Alertes -------------------------------------------------------------------

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

function describeTarget(m) {
  if (m.type === 'tcp') return `${m.target}:${m.port}`;
  if (m.type === 'push') return 'sonde passive (push)';
  if (m.type === 'dns') return `${m.target} (${m.dnsType})`;
  return m.target;
}

// Collecte les écritures et les alertes d'une exécution, envoyées ensuite en une fois.
class Run {
  constructor(env, cfg) {
    this.env = env;
    this.db = env.DB;
    this.cfg = cfg;
    this.writes = [];
    this.alerts = [];
  }

  fmtDate(t) {
    return new Date(t).toLocaleString('fr-FR', { timeZone: this.env.TIMEZONE || 'Europe/Paris' });
  }

  event(m, kind, msg) {
    this.writes.push(insertEvent(this.db, m, kind, msg));
  }

  alert(m, kind, title, text) {
    for (const n of this.cfg.notifiers.filter((x) => m.notifierIds.includes(x.id))) this.alerts.push({ m, n, msg: { kind, title, text, monitor: m } });
  }

  // Applique le résultat d'une vérification : battement, transitions UP/DOWN, alertes.
  apply(m, r, t = Date.now()) {
    const st = (this.cfg.state[m.id] ??= newState());
    const before = JSON.stringify(st);
    const prev = st.status;
    const status = r.ok ? 'up' : 'down';
    this.writes.push(insertBeat(this.db, m, t, r.ok ? UP : DOWN, r.ms ?? null, r.msg ?? ''));

    if (status === 'down' && prev !== 'down') {
      st.lastChange = t;
      st.lastNotifiedAt = t;
      this.event(m, 'down', r.msg);
      this.alert(m, 'down', `🔴 ${m.name} est DOWN`, `${describeTarget(m)}\nRaison : ${r.msg}\nDepuis : ${this.fmtDate(t)}`);
    } else if (status === 'up' && prev === 'down') {
      const downFor = st.lastChange ? ` après ${duration(t - st.lastChange)} d'indisponibilité` : '';
      st.lastChange = t;
      this.event(m, 'up', `${r.msg}${downFor}`);
      this.alert(m, 'up', `🟢 ${m.name} est de nouveau UP`, `${describeTarget(m)}\n${r.msg}${downFor}`);
    } else if (status === 'up' && !st.lastChange) {
      st.lastChange = t;
      this.event(m, 'up', `Sonde opérationnelle : ${r.msg}`);
    } else if (status === 'down' && m.resendEvery > 0 && t - (st.lastNotifiedAt ?? 0) >= m.resendEvery * MIN - 5000) {
      st.lastNotifiedAt = t;
      this.alert(m, 'down', `🔴 ${m.name} est toujours DOWN`, `${describeTarget(m)}\nRaison : ${r.msg}\nDown depuis ${duration(t - st.lastChange)}`);
    }
    st.status = status;
    if (JSON.stringify(st) !== before) this.writes.push(saveState(this.db, m.id, st));
  }

  async commit() {
    // les échecs d'envoi sont journalisés dans le même batch que le reste
    await Promise.all(
      this.alerts.map(async ({ m, n, msg }) => {
        try {
          await senders[n.type](n, msg);
        } catch (err) {
          console.error(`[notify] ${n.name} : ${err.message}`);
          this.event(m, 'notify-error', `Échec d'envoi via « ${n.name} » : ${err.message}`);
        }
      }),
    );
    this.writes.push(setMeta(this.db, 'lastRun', Date.now()));
    await this.db.batch(this.writes);
  }
}

// Vérification avec nouveaux essais immédiats : une sonde n'est DOWN qu'après `retries` échecs de plus.
async function checkWithRetries(m) {
  let r = await runCheck(m);
  for (let i = 0; i < m.retries && !r.ok; i++) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(m.retryInterval, CAPS.maxRetryInterval) * 1000));
    r = await runCheck(m);
    if (!r.ok && i === m.retries - 1) r.msg = `${r.msg} (${m.retries + 1} essais)`;
  }
  return r;
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// Répartit les sondes sur les minutes : une sonde toutes les 5 min ne tombe pas forcément à :00, :05…
function slotOffset(id, every) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % every;
}

function isDue(m, minute) {
  const every = Math.max(1, Math.round(m.interval / 60));
  return minute % every === slotOffset(m.id, every);
}

// --- Exécution planifiée (chaque minute) ---------------------------------------

export async function scheduled(env, scheduledTime) {
  const cfg = await loadConfig(env.DB);
  const run = new Run(env, cfg);
  const minute = Math.floor(scheduledTime / MIN);
  const now = Date.now();

  const due = cfg.monitors.filter((m) => m.active && isDue(m, minute));
  if (due.length > MAX_CHECKS) console.warn(`[vigie] ${due.length} sondes à vérifier, limite ${MAX_CHECKS} par minute : les suivantes attendront`);

  await pool(due.slice(0, MAX_CHECKS), CONCURRENCY, async (m) => {
    if (m.type === 'push') {
      const last = cfg.state[m.id]?.lastPushAt ?? m.createdAt;
      if (now - last > m.interval * 1000 + 30_000) run.apply(m, { ok: false, ms: null, msg: `Aucun signal depuis ${duration(now - last)}` });
      return;
    }
    run.apply(m, await checkWithRetries(m));
  });

  // maintenance horaire : purge et calcul des disponibilités 7 j / 30 j
  if (minute % 60 === 0 || !cfg.meta.uptime) {
    const db = env.DB;
    run.writes.push(
      db.prepare('UPDATE hours SET beats = NULL WHERE hour < ?1 AND beats IS NOT NULL').bind(now - 26 * HOUR),
      db.prepare('DELETE FROM hours WHERE hour < ?1').bind(now - 90 * DAY),
      db.prepare('DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET 1000)'),
      db.prepare(
        `INSERT INTO meta (key, value)
         SELECT 'uptime', COALESCE(json_group_object(monitor_id, json_array(u7, t7, u30, t30)), '{}') FROM (
           SELECT monitor_id, SUM(CASE WHEN hour >= ?1 THEN up END) u7, SUM(CASE WHEN hour >= ?1 THEN total END) t7, SUM(up) u30, SUM(total) t30
           FROM hours WHERE hour >= ?2 GROUP BY monitor_id)
         WHERE 1 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).bind(now - 7 * DAY, now - 30 * DAY),
    );
  }
  await run.commit();
}

// --- Lecture pour l'interface ----------------------------------------------------

export async function getState(env) {
  const db = env.DB;
  const now = Date.now();
  const [cfg, hours] = await Promise.all([
    loadConfig(db),
    // compteurs des 24 dernières heures ; battements seulement des 6 dernières (CPU)
    db
      .prepare('SELECT monitor_id, hour, up, total, sum_ms, n_ms, CASE WHEN hour >= ?2 THEN beats END AS beats FROM hours WHERE hour >= ?1 ORDER BY hour')
      .bind(now - 24 * HOUR, now - 6 * HOUR)
      .all(),
  ]);
  const uptime = JSON.parse(cfg.meta.uptime || '{}');
  const byMonitor = {};
  for (const r of hours.results) (byMonitor[r.monitor_id] ??= []).push(r);

  const monitors = cfg.monitors.map((m) => {
    const rows = byMonitor[m.id] ?? [];
    let up = 0, total = 0, sumMs = 0, nMs = 0;
    for (const r of rows) {
      up += r.up;
      total += r.total;
      sumMs += r.sum_ms;
      nMs += r.n_ms;
    }
    const recent = [];
    for (let i = rows.length - 1; i >= 0 && recent.length < 60; i--) if (rows[i].beats) recent.unshift(...JSON.parse(rows[i].beats));
    const st = cfg.state[m.id] ?? newState();
    const [u7, t7, u30, t30] = uptime[m.id] ?? [];
    return {
      ...m,
      status: m.active ? st.status : 'paused',
      lastChange: st.lastChange,
      lastBeat: recent[recent.length - 1] ?? null,
      recent: recent.slice(-60),
      uptime24: total ? up / total : null,
      uptime7d: t7 ? u7 / t7 : null,
      uptime30d: t30 ? u30 / t30 : null,
      avgMs24: nMs ? Math.round(sumMs / nMs) : null,
      cert: null,
      lastPushAt: st.lastPushAt,
    };
  });

  return {
    monitors,
    notifiers: cfg.notifiers.map((n) => maskNotifier(n, NOTIFIER_TYPES)),
    notifierTypes: Object.fromEntries(Object.entries(NOTIFIER_TYPES).map(([k, v]) => [k, v.label])),
    capabilities: CAPS,
    lastRun: Number(cfg.meta.lastRun) || null,
  };
}

/** Change à chaque vérification ou modification : l'interface ne recharge l'état que s'il a bougé. */
export async function getVersion(env) {
  const rows = await env.DB.prepare("SELECT key, value FROM meta WHERE key IN ('lastRun', 'config')").all();
  return Object.fromEntries(rows.results.map((r) => [r.key, Number(r.value)]));
}

export async function getHeartbeats(env, id, range) {
  const now = Date.now();
  const hoursBack = { '1h': 1, '6h': 6, '24h': 24 }[range];
  if (hoursBack) {
    const since = now - hoursBack * HOUR;
    const rows = await env.DB.prepare('SELECT beats FROM hours WHERE monitor_id = ?1 AND hour >= ?2 AND beats IS NOT NULL ORDER BY hour')
      .bind(id, Math.floor(since / HOUR) * HOUR)
      .all();
    return { kind: 'raw', points: rows.results.flatMap((r) => JSON.parse(r.beats)).filter((b) => b[0] >= since) };
  }
  const days = range === '90d' ? 90 : range === '30d' ? 30 : 7;
  const rows = await env.DB.prepare('SELECT hour, up, total, sum_ms, n_ms FROM hours WHERE monitor_id = ?1 AND hour >= ?2 ORDER BY hour')
    .bind(id, now - days * DAY)
    .raw();
  return { kind: 'hourly', points: rows };
}

export async function getEvents(env, monitorId, limit = 200) {
  const n = Math.min(500, Math.max(1, limit));
  const q = monitorId
    ? env.DB.prepare('SELECT t, monitor_id AS monitorId, name, kind, msg FROM events WHERE monitor_id = ?1 ORDER BY id DESC LIMIT ?2').bind(monitorId, n)
    : env.DB.prepare('SELECT t, monitor_id AS monitorId, name, kind, msg FROM events ORDER BY id DESC LIMIT ?1').bind(n);
  return (await q.all()).results;
}

// --- Modifications depuis l'interface ---------------------------------------------

const bump = (db) => setMeta(db, 'config', Date.now());

export async function upsertMonitor(env, input, id) {
  const cfg = await loadConfig(env.DB);
  const previous = id ? cfg.monitors.find((m) => m.id === id) : undefined;
  if (id && !previous) return null;
  const m = sanitizeMonitor(input, previous, { ...CAPS, notifierIds: cfg.notifiers.map((n) => n.id) });
  const writes = [saveMonitor(env.DB, m), bump(env.DB)];
  if (previous && previous.type !== m.type) writes.push(env.DB.prepare('DELETE FROM state WHERE monitor_id = ?1').bind(m.id));
  await env.DB.batch(writes);
  return m;
}

export async function deleteMonitor(env, id) {
  const db = env.DB;
  const res = await db.batch([
    db.prepare('DELETE FROM monitors WHERE id = ?1').bind(id),
    db.prepare('DELETE FROM state WHERE monitor_id = ?1').bind(id),
    db.prepare('DELETE FROM hours WHERE monitor_id = ?1').bind(id),
    db.prepare('DELETE FROM events WHERE monitor_id = ?1').bind(id),
    bump(db),
  ]);
  return res[0].meta.changes > 0;
}

export async function setActive(env, id, active) {
  const cfg = await loadConfig(env.DB);
  const prev = cfg.monitors.find((m) => m.id === id);
  if (!prev) return null;
  const m = { ...prev, active };
  const writes = [saveMonitor(env.DB, m), insertEvent(env.DB, m, active ? 'resume' : 'pause', active ? 'Surveillance reprise' : 'Surveillance mise en pause'), bump(env.DB)];
  if (!active) writes.push(saveState(env.DB, id, { ...(cfg.state[id] ?? newState()), status: 'unknown' }));
  await env.DB.batch(writes);
  return m;
}

export async function checkNow(env, id) {
  const cfg = await loadConfig(env.DB);
  const m = cfg.monitors.find((x) => x.id === id);
  if (!m) return null;
  if (m.type !== 'push' && m.active) {
    const run = new Run(env, cfg);
    run.apply(m, await runCheck(m)); // sans nouveaux essais : on veut le résultat tout de suite
    await run.commit();
  }
  return m;
}

export async function push(env, token, { status, msg, ping }) {
  const m = await env.DB.prepare("SELECT data FROM monitors WHERE json_extract(data, '$.pushToken') = ?1").bind(token).first();
  if (!m) return null;
  const monitor = JSON.parse(m.data);
  if (!monitor.active) return monitor;
  const cfg = await loadConfig(env.DB);
  const run = new Run(env, cfg);
  const down = String(status ?? '').toLowerCase() === 'down';
  if (!down) (cfg.state[monitor.id] ??= newState()).lastPushAt = Date.now();
  const ms = ping !== undefined && ping !== '' && Number.isFinite(Number(ping)) ? Number(ping) : null;
  run.apply(monitor, { ok: !down, ms, msg: str(msg, 300) || (down ? 'Signalé DOWN par push' : 'Signal reçu') });
  await run.commit();
  return monitor;
}

export async function upsertNotifier(env, input, id) {
  const cfg = await loadConfig(env.DB);
  const previous = id ? cfg.notifiers.find((n) => n.id === id) : undefined;
  if (id && !previous) return null;
  const n = sanitizeNotifier(input, previous, NOTIFIER_TYPES);
  const writes = [
    env.DB.prepare('INSERT INTO notifiers (id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data = excluded.data').bind(n.id, JSON.stringify(n)),
    bump(env.DB),
  ];
  if (input.applyToAll) {
    for (const m of cfg.monitors) if (!m.notifierIds.includes(n.id)) writes.push(saveMonitor(env.DB, { ...m, notifierIds: [...m.notifierIds, n.id] }));
  }
  await env.DB.batch(writes);
  return maskNotifier(n, NOTIFIER_TYPES);
}

export async function deleteNotifier(env, id) {
  const cfg = await loadConfig(env.DB);
  if (!cfg.notifiers.some((n) => n.id === id)) return false;
  const writes = [env.DB.prepare('DELETE FROM notifiers WHERE id = ?1').bind(id), bump(env.DB)];
  for (const m of cfg.monitors) {
    if (m.notifierIds.includes(id)) writes.push(saveMonitor(env.DB, { ...m, notifierIds: m.notifierIds.filter((x) => x !== id) }));
  }
  await env.DB.batch(writes);
  return true;
}

export async function testNotifier(env, input) {
  const cfg = await loadConfig(env.DB);
  const previous = cfg.notifiers.find((n) => n.id === input.id);
  const n = sanitizeNotifier(input, previous, NOTIFIER_TYPES);
  const when = new Date().toLocaleString('fr-FR', { timeZone: env.TIMEZONE || 'Europe/Paris' });
  await senders[n.type](n, {
    kind: 'test',
    title: '🔔 Test de notification Vigie',
    text: `Si vous lisez ce message, le canal « ${n.name} » fonctionne.\n${when}`,
    monitor: null,
  });
}
