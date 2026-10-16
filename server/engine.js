// Cœur de Vigie : planification des sondes, calcul des états, historique et déclenchement des alertes.
import { runCheck } from './checks.js';
import { send, NOTIFIER_TYPES } from './notify.js';
import { InputError, sanitizeMonitor as validateMonitor, sanitizeNotifier as validateNotifier, maskNotifier, str } from '../shared/validate.js';
import { loadConfig, saveConfig, loadHistory, saveHistory } from './store.js';

const HOUR = 3_600_000;
const RAW_RETENTION = 26 * HOUR; // battements individuels conservés ~1 jour
const HOURLY_RETENTION = 90 * 24 * HOUR; // agrégats horaires conservés 90 jours
const MAX_EVENTS = 1000;

// Codes des battements : [horodatage, code, ms, message]
export const UP = 1;
export const DOWN = 0;
export const PENDING = 2;

const config = loadConfig();
const history = loadHistory();
const timers = new Map(); // id sonde -> timeout
const running = new Set(); // id des sondes en cours de vérification
let dirty = false;
let listener = () => {};

export function onEvent(fn) {
  listener = fn;
}

function emit(type, data) {
  listener(type, data);
}

// --- Validation des saisies ----------------------------------------------------

const caps = () => ({
  monitorTypes: ['http', 'keyword', 'tcp', 'ping', 'dns', 'push'],
  minInterval: 10,
  tlsOptions: true,
  notifierIds: config.notifiers.map((n) => n.id),
});

export { InputError };

// --- Historique -----------------------------------------------------------------

function stateOf(id) {
  return (history.state[id] ??= { status: 'unknown', failures: 0, lastChange: null, lastNotifiedAt: null, lastPushAt: null, certAlertDay: null });
}

function record(m, code, ms, msg) {
  const now = Date.now();
  const beat = [now, code, ms, msg];
  (history.beats[m.id] ??= []).push(beat);

  const hour = Math.floor(now / HOUR) * HOUR;
  const buckets = (history.hourly[m.id] ??= []);
  let b = buckets[buckets.length - 1];
  if (!b || b[0] !== hour) buckets.push((b = [hour, 0, 0, 0, 0])); // [heure, nb up, total, somme ms, nb ms]
  b[2]++;
  if (code !== DOWN) b[1]++;
  if (ms !== null && code === UP) {
    b[3] += ms;
    b[4]++;
  }
  dirty = true;
  return beat;
}

function addEvent(m, kind, msg) {
  const ev = { t: Date.now(), monitorId: m?.id ?? null, name: m?.name ?? 'Vigie', kind, msg };
  history.events.unshift(ev);
  if (history.events.length > MAX_EVENTS) history.events.length = MAX_EVENTS;
  dirty = true;
  emit('event', ev);
}

function prune() {
  const now = Date.now();
  const ids = new Set(config.monitors.map((m) => m.id));
  for (const key of ['beats', 'hourly', 'state']) {
    for (const id of Object.keys(history[key])) if (!ids.has(id)) delete history[key][id];
  }
  for (const beats of Object.values(history.beats)) {
    const i = beats.findIndex((b) => b[0] >= now - RAW_RETENTION);
    if (i > 0) beats.splice(0, i);
    else if (i === -1) beats.length = 0;
  }
  for (const buckets of Object.values(history.hourly)) {
    const i = buckets.findIndex((b) => b[0] >= now - HOURLY_RETENTION);
    if (i > 0) buckets.splice(0, i);
    else if (i === -1) buckets.length = 0;
  }
}

export function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    saveHistory(history);
  } catch (err) {
    console.error('[history] sauvegarde impossible :', err.message);
  }
}

setInterval(() => {
  prune();
  flush();
}, 30_000).unref();

// --- Statistiques pour l'interface -----------------------------------------------

function uptime(id, since) {
  let up = 0;
  let total = 0;
  for (const b of history.hourly[id] ?? []) {
    if (b[0] + HOUR <= since) continue;
    up += b[1];
    total += b[2];
  }
  return total ? up / total : null;
}

function summary(m) {
  const st = stateOf(m.id);
  const beats = history.beats[m.id] ?? [];
  const now = Date.now();
  const day = beats.filter((b) => b[0] >= now - 24 * HOUR);
  const upDay = day.filter((b) => b[1] !== DOWN).length;
  const msDay = day.filter((b) => b[1] === UP && b[2] !== null);
  return {
    status: m.active ? st.status : 'paused',
    lastChange: st.lastChange,
    lastBeat: beats[beats.length - 1] ?? null,
    recent: beats.slice(-60).map((b) => [b[0], b[1], b[2], b[3]]),
    uptime24: day.length ? upDay / day.length : null,
    uptime7d: uptime(m.id, now - 7 * 24 * HOUR),
    uptime30d: uptime(m.id, now - 30 * 24 * HOUR),
    avgMs24: msDay.length ? Math.round(msDay.reduce((s, b) => s + b[2], 0) / msDay.length) : null,
    cert: st.cert ?? null,
    lastPushAt: st.lastPushAt,
  };
}

export function getState() {
  return {
    monitors: config.monitors.map((m) => ({ ...m, ...summary(m) })),
    notifiers: config.notifiers.map((n) => maskNotifier(n, NOTIFIER_TYPES)),
    notifierTypes: Object.fromEntries(Object.entries(NOTIFIER_TYPES).map(([k, v]) => [k, v.label])),
    capabilities: { platform: 'node', live: true, ...caps(), notifierIds: undefined },
  };
}

export function getHeartbeats(id, range) {
  const now = Date.now();
  if (range === '24h' || range === '1h' || range === '6h') {
    const since = now - { '1h': 1, '6h': 6, '24h': 24 }[range] * HOUR;
    return { kind: 'raw', points: (history.beats[id] ?? []).filter((b) => b[0] >= since) };
  }
  const days = range === '90d' ? 90 : range === '30d' ? 30 : 7;
  const since = now - days * 24 * HOUR;
  return { kind: 'hourly', points: (history.hourly[id] ?? []).filter((b) => b[0] >= since) };
}

export function getEvents(monitorId, limit = 200) {
  const list = monitorId ? history.events.filter((e) => e.monitorId === monitorId) : history.events;
  return list.slice(0, limit);
}

// --- Alertes ----------------------------------------------------------------------

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

const fmtDate = (t) => new Date(t).toLocaleString('fr-FR', { timeZone: process.env.TZ || 'Europe/Paris' });

async function alert(m, kind, title, text) {
  const notifiers = config.notifiers.filter((n) => m.notifierIds.includes(n.id));
  const msg = { kind, title, text, monitor: m };
  await Promise.all(
    notifiers.map(async (n) => {
      try {
        await send(n, msg);
      } catch (err) {
        console.error(`[notify] ${n.name} :`, err.message);
        addEvent(m, 'notify-error', `Échec d'envoi via « ${n.name} » : ${err.message}`);
      }
    }),
  );
}

// --- Exécution des sondes -----------------------------------------------------

function handleResult(m, r) {
  const st = stateOf(m.id);
  const now = Date.now();
  const prev = st.status;
  let status;
  if (r.ok) {
    st.failures = 0;
    status = 'up';
  } else {
    st.failures++;
    status = st.failures > m.retries || prev === 'down' ? 'down' : 'pending';
  }
  const code = status === 'up' ? UP : status === 'down' ? DOWN : PENDING;
  const beat = record(m, code, r.ms ?? null, String(r.msg ?? '').slice(0, 300));
  if (r.cert) st.cert = r.cert;

  if (status === 'down' && prev !== 'down') {
    st.lastChange = now;
    st.lastNotifiedAt = now;
    addEvent(m, 'down', r.msg);
    alert(m, 'down', `🔴 ${m.name} est DOWN`, `${describeTarget(m)}
Raison : ${r.msg}
Depuis : ${fmtDate(now)}`);
  } else if (status === 'up' && prev === 'down') {
    const downFor = st.lastChange ? ` après ${duration(now - st.lastChange)} d'indisponibilité` : '';
    st.lastChange = now;
    addEvent(m, 'up', `${r.msg}${downFor}`);
    alert(m, 'up', `🟢 ${m.name} est de nouveau UP`, `${describeTarget(m)}
${r.msg}${downFor}`);
  } else if (status === 'up' && !st.lastChange) {
    st.lastChange = now;
    addEvent(m, 'up', `Sonde opérationnelle : ${r.msg}`);
  } else if (status === 'down' && m.resendEvery > 0 && now - (st.lastNotifiedAt ?? 0) >= m.resendEvery * 60_000) {
    st.lastNotifiedAt = now;
    alert(m, 'down', `🔴 ${m.name} est toujours DOWN`, `${describeTarget(m)}
Raison : ${r.msg}
Down depuis ${duration(now - st.lastChange)}`);
  }
  // un échec isolé (pending) puis un succès ne déclenche aucune alerte
  st.status = status;

  checkCert(m, st);
  emit('beat', { id: m.id, beat, monitor: { ...m, ...summary(m) } });
}

function checkCert(m, st) {
  const c = st.cert;
  if (!c || !m.certExpiryDays || !m.target?.startsWith('https:')) return;
  const today = new Date().toISOString().slice(0, 10);
  if (c.daysLeft > m.certExpiryDays || st.certAlertDay === today) return;
  st.certAlertDay = today;
  const text =
    c.daysLeft < 0
      ? `Le certificat TLS de ${m.target} a expiré le ${fmtDate(c.validTo)}.`
      : `Le certificat TLS de ${m.target} expire dans ${c.daysLeft} jour(s) (${fmtDate(c.validTo)}).`;
  addEvent(m, 'cert', text);
  alert(m, 'cert', `⚠️ Certificat de ${m.name} bientôt expiré`, text);
}

async function tick(m) {
  if (running.has(m.id)) return;
  running.add(m.id);
  try {
    let result;
    if (m.type === 'push') {
      const st = stateOf(m.id);
      const last = st.lastPushAt ?? m.createdAt;
      const late = Date.now() - last;
      // pas de verdict tant qu'aucune fenêtre complète ne s'est écoulée
      result = late > m.interval * 1000 ? { ok: false, ms: null, msg: `Aucun signal depuis ${duration(late)}` } : null;
    } else {
      result = await runCheck(m);
    }
    const current = config.monitors.find((x) => x.id === m.id);
    if (result && current?.active) handleResult(current, result);
  } finally {
    running.delete(m.id);
  }
}

function schedule(m, delay) {
  clearTimeout(timers.get(m.id));
  if (!m.active) return timers.delete(m.id);
  timers.set(
    m.id,
    setTimeout(async () => {
      await tick(m);
      const current = config.monitors.find((x) => x.id === m.id);
      if (!current?.active || current !== m) return; // modifiée ou supprimée entre-temps
      const pending = stateOf(m.id).status === 'pending';
      schedule(m, (pending ? Math.min(m.retryInterval, m.interval) : m.interval) * 1000);
    }, delay),
  );
}

export function start() {
  // départs étalés pour ne pas tout lancer à la même seconde
  config.monitors.forEach((m, i) => schedule(m, 1000 + i * 300));
  console.log(`[vigie] ${config.monitors.length} sonde(s) chargée(s)`);
}

function persistConfig() {
  saveConfig(config);
  emit('config', null);
}

// --- Opérations exposées à l'API ----------------------------------------------

export function upsertMonitor(input, id) {
  const idx = id ? config.monitors.findIndex((m) => m.id === id) : -1;
  if (id && idx === -1) return null;
  const previous = idx >= 0 ? config.monitors[idx] : undefined;
  const m = validateMonitor(input, previous, caps());
  if (idx >= 0) config.monitors[idx] = m;
  else config.monitors.push(m);
  if (previous && previous.type !== m.type) delete history.state[m.id];
  persistConfig();
  schedule(m, 500);
  return m;
}

export function deleteMonitor(id) {
  const idx = config.monitors.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  clearTimeout(timers.get(id));
  timers.delete(id);
  config.monitors.splice(idx, 1);
  prune();
  persistConfig();
  return true;
}

export function setActive(id, active) {
  const idx = config.monitors.findIndex((m) => m.id === id);
  if (idx === -1) return null;
  const m = { ...config.monitors[idx], active };
  config.monitors[idx] = m;
  const st = stateOf(id);
  if (!active) {
    st.status = 'unknown';
    st.failures = 0;
  }
  addEvent(m, active ? 'resume' : 'pause', active ? 'Surveillance reprise' : 'Surveillance mise en pause');
  persistConfig();
  schedule(m, 500);
  return m;
}

export async function checkNow(id) {
  const m = config.monitors.find((x) => x.id === id);
  if (!m) return null;
  if (m.type === 'push') return { ...m, ...summary(m) };
  await tick(m);
  schedule(m, m.interval * 1000);
  return { ...m, ...summary(m) };
}

export function push(token, { status, msg, ping }) {
  const m = config.monitors.find((x) => x.type === 'push' && x.pushToken === token);
  if (!m) return null;
  if (!m.active) return m;
  const down = String(status ?? '').toLowerCase() === 'down';
  if (!down) stateOf(m.id).lastPushAt = Date.now();
  const ms = Number.isFinite(Number(ping)) && ping !== undefined && ping !== '' ? Number(ping) : null;
  handleResult(m, { ok: !down, ms, msg: str(msg, 300) || (down ? 'Signalé DOWN par push' : 'Signal reçu') });
  schedule(m, m.interval * 1000);
  return m;
}

export function upsertNotifier(input, id) {
  const idx = id ? config.notifiers.findIndex((n) => n.id === id) : -1;
  if (id && idx === -1) return null;
  const n = validateNotifier(input, idx >= 0 ? config.notifiers[idx] : undefined, NOTIFIER_TYPES);
  if (idx >= 0) config.notifiers[idx] = n;
  else config.notifiers.push(n);
  if (input.applyToAll) {
    for (const m of config.monitors) if (!m.notifierIds.includes(n.id)) m.notifierIds.push(n.id);
  }
  persistConfig();
  return maskNotifier(n, NOTIFIER_TYPES);
}

export function deleteNotifier(id) {
  const idx = config.notifiers.findIndex((n) => n.id === id);
  if (idx === -1) return false;
  config.notifiers.splice(idx, 1);
  for (const m of config.monitors) m.notifierIds = m.notifierIds.filter((x) => x !== id);
  persistConfig();
  return true;
}

// Test d'un canal : enregistré (id) ou en cours de saisie (input, secrets éventuellement masqués).
export async function testNotifier(input, id) {
  const previous = config.notifiers.find((n) => n.id === (id ?? input.id));
  const n = validateNotifier(input, previous, NOTIFIER_TYPES);
  await send(n, {
    kind: 'test',
    title: '🔔 Test de notification Vigie',
    text: `Si vous lisez ce message, le canal « ${n.name} » fonctionne.\n${fmtDate(Date.now())}`,
    monitor: null,
  });
}
