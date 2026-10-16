// Vérifications actives. Chaque fonction renvoie { ok, ms, msg, cert? } et ne lève jamais d'exception.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { performance } from 'node:perf_hooks';

const USER_AGENT = 'Vigie/0.1 (uptime monitor)';
const MAX_BODY = 1024 * 1024; // 1 Mo suffit pour chercher un mot-clé
const DAY = 86_400_000;

export async function runCheck(m) {
  try {
    switch (m.type) {
      case 'http':
      case 'keyword':
        return await checkHttp(m);
      case 'tcp':
        return await checkTcp(m);
      case 'ping':
        return await checkPing(m);
      case 'dns':
        return await checkDns(m);
      default:
        return { ok: false, ms: null, msg: `Type de sonde inconnu : ${m.type}` };
    }
  } catch (err) {
    return { ok: false, ms: null, msg: errorMessage(err, m) };
  }
}

function errorMessage(err, m) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return `Délai dépassé (${m.timeout} s)`;
  const known = {
    ENOTFOUND: 'Nom introuvable (DNS)',
    EAI_AGAIN: 'Résolution DNS impossible',
    ECONNREFUSED: 'Connexion refusée',
    ECONNRESET: 'Connexion réinitialisée',
    EHOSTUNREACH: 'Hôte injoignable',
    ENETUNREACH: 'Réseau injoignable',
    ETIMEDOUT: 'Délai dépassé',
    CERT_HAS_EXPIRED: 'Certificat expiré',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Certificat auto-signé',
    SELF_SIGNED_CERT_IN_CHAIN: 'Certificat auto-signé dans la chaîne',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Chaîne de certificats incomplète',
    ERR_TLS_CERT_ALTNAME_INVALID: 'Le certificat ne correspond pas au nom',
  };
  const code = err?.code;
  if (code && known[code]) return `${known[code]} (${code})`;
  return err?.message || String(err);
}

// --- HTTP(S) -----------------------------------------------------------------

// "200-299,301" -> fonction de test
function statusMatcher(spec) {
  const parts = String(spec || '200-399')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [a, b] = s.split('-').map((n) => parseInt(n, 10));
      return [a, Number.isFinite(b) ? b : a];
    });
  return (code) => parts.some(([a, b]) => code >= a && code <= b);
}

function parseHeaders(text) {
  const headers = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return headers;
}

function certInfo(socket) {
  if (typeof socket?.getPeerCertificate !== 'function') return null;
  const c = socket.getPeerCertificate();
  if (!c || !c.valid_to) return null;
  const validTo = new Date(c.valid_to).getTime();
  return {
    validTo,
    daysLeft: Math.floor((validTo - Date.now()) / DAY),
    subject: c.subject?.CN ?? null,
    issuer: c.issuer?.O ?? c.issuer?.CN ?? null,
  };
}

function request(url, m, signal, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const wantBody = m.type === 'keyword';
    const req = lib.request(
      u,
      {
        method: m.method || 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...parseHeaders(m.headers) },
        rejectUnauthorized: !m.ignoreTls,
        agent: false, // une connexion neuve par vérification : on mesure vraiment le temps de réponse
        signal,
      },
      (res) => {
        const cert = certInfo(res.socket);
        const location = res.headers.location;
        if (m.followRedirects !== false && location && [301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('Trop de redirections'));
          return resolve(request(new URL(location, u).href, m, signal, redirectsLeft - 1));
        }
        if (!wantBody) {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode, body: '', cert, url }));
          res.on('error', reject);
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (size < MAX_BODY) chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), cert, url }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (m.body && !['GET', 'HEAD'].includes(m.method)) req.write(m.body);
    req.end();
  });
}

async function checkHttp(m) {
  const t0 = performance.now();
  const res = await request(m.target, m, AbortSignal.timeout(m.timeout * 1000), 5);
  const ms = Math.round(performance.now() - t0);
  const cert = res.cert;

  if (!statusMatcher(m.acceptedStatus)(res.status)) {
    return { ok: false, ms, cert, msg: `HTTP ${res.status} (attendu : ${m.acceptedStatus || '200-399'})` };
  }
  if (m.type === 'keyword') {
    const found = res.body.includes(m.keyword);
    if (found === Boolean(m.invertKeyword)) {
      return {
        ok: false,
        ms,
        cert,
        msg: m.invertKeyword ? `Mot-clé « ${m.keyword} » présent` : `Mot-clé « ${m.keyword} » absent`,
      };
    }
  }
  return { ok: true, ms, cert, msg: `HTTP ${res.status}` };
}

// --- TCP ---------------------------------------------------------------------

function checkTcp(m) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const socket = net.connect({ host: m.target, port: m.port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(m.timeout * 1000);
    socket.once('connect', () => done({ ok: true, ms: Math.round(performance.now() - t0), msg: `Port ${m.port} ouvert` }));
    socket.once('timeout', () => done({ ok: false, ms: null, msg: `Délai dépassé (${m.timeout} s)` }));
    socket.once('error', (err) => done({ ok: false, ms: null, msg: errorMessage(err, m) }));
  });
}

// --- Ping (commande système : pas besoin de droits root) ---------------------

const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9.:_-]*$/;

function checkPing(m) {
  return new Promise((resolve) => {
    if (!SAFE_HOST.test(m.target)) return resolve({ ok: false, ms: null, msg: 'Nom d’hôte invalide' });
    const count = Math.max(1, Math.min(10, m.pingCount || 1));
    const win = process.platform === 'win32';
    const args = win
      ? ['-n', String(count), '-w', String(m.timeout * 1000), m.target]
      : ['-n', '-c', String(count), '-W', String(m.timeout), m.target];

    let out = '';
    const child = spawn('ping', args, { windowsHide: true });
    const killer = setTimeout(() => child.kill(), (m.timeout * count + 3) * 1000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => {
      clearTimeout(killer);
      resolve({ ok: false, ms: null, msg: `Commande ping indisponible : ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      // Windows renvoie 0 même sur « Impossible de joindre l'hôte » : on exige une ligne avec TTL.
      const replied = code === 0 && (!win || /ttl=/i.test(out));
      const avg = out.match(/=\s*[\d.]+\/([\d.]+)\//); // Linux : rtt min/avg/max/mdev
      const one = out.match(/(?:time|temps)[=<]\s*([\d.,]+)\s*ms/i);
      const ms = avg ? Number(avg[1]) : one ? Number(one[1].replace(',', '.')) : null;
      if (replied) {
        const loss = out.match(/(\d+)% (?:packet )?(?:loss|perte)/i);
        const lossTxt = loss && loss[1] !== '0' ? `, ${loss[1]} % de perte` : '';
        resolve({ ok: true, ms: ms === null ? null : Math.round(ms * 10) / 10, msg: `Répond au ping${lossTxt}` });
      } else {
        resolve({ ok: false, ms: null, msg: 'Aucune réponse au ping' });
      }
    });
  });
}

// --- DNS ---------------------------------------------------------------------

async function checkDns(m) {
  const resolver = new Resolver({ timeout: m.timeout * 1000, tries: 1 });
  if (m.dnsServer) resolver.setServers([m.dnsServer]);
  const t0 = performance.now();
  const records = await resolver.resolve(m.target, m.dnsType || 'A');
  const ms = Math.round(performance.now() - t0);
  const values = records.map((r) =>
    typeof r === 'string' ? r : Array.isArray(r) ? r.join('') : r.exchange ?? r.value ?? r.name ?? JSON.stringify(r),
  );
  if (m.dnsExpected && !values.some((v) => v.toLowerCase().includes(m.dnsExpected.toLowerCase()))) {
    return { ok: false, ms, msg: `Réponse inattendue : ${values.join(', ') || '(vide)'}` };
  }
  return { ok: true, ms, msg: values.join(', ').slice(0, 200) || 'Aucun enregistrement' };
}
