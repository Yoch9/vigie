// Vérifications depuis le réseau Cloudflare. Chaque fonction renvoie { ok, ms, msg } et ne lève jamais d'exception.
// Pas de ping (ICMP indisponible dans un Worker) : pour un routeur, on teste un port TCP ouvert.
import { connect } from 'cloudflare:sockets';

const USER_AGENT = 'Vigie/0.1 (uptime monitor; Cloudflare Workers)';

export async function runCheck(m) {
  try {
    switch (m.type) {
      case 'http':
      case 'keyword':
        return await checkHttp(m);
      case 'tcp':
        return await checkTcp(m);
      case 'dns':
        return await checkDns(m);
      default:
        return { ok: false, ms: null, msg: `Type de sonde non disponible sur Cloudflare : ${m.type}` };
    }
  } catch (err) {
    return { ok: false, ms: null, msg: errorMessage(err, m) };
  }
}

function errorMessage(err, m) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return `Délai dépassé (${m.timeout} s)`;
  const text = String(err?.message || err);
  // messages bruts du runtime Cloudflare
  if (/^internal error/i.test(text)) return 'Échec TLS ou réseau (certificat invalide, expiré ou auto-signé ?)';
  if (/network connection lost/i.test(text)) return 'Connexion perdue (hôte injoignable)';
  return text.slice(0, 300);
}

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

async function checkHttp(m) {
  const t0 = Date.now();
  const res = await fetch(m.target, {
    method: m.method || 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...parseHeaders(m.headers) },
    body: m.body && !['GET', 'HEAD'].includes(m.method) ? m.body : undefined,
    redirect: m.followRedirects === false ? 'manual' : 'follow',
    cache: 'no-store', // jamais de réponse servie par le cache Cloudflare
    signal: AbortSignal.timeout(m.timeout * 1000),
  });
  const body = m.type === 'keyword' ? await res.text() : (await res.body?.cancel(), '');
  const ms = Date.now() - t0;

  if (!statusMatcher(m.acceptedStatus)(res.status)) {
    return { ok: false, ms, msg: `HTTP ${res.status} (attendu : ${m.acceptedStatus || '200-399'})` };
  }
  if (m.type === 'keyword' && body.includes(m.keyword) === Boolean(m.invertKeyword)) {
    return { ok: false, ms, msg: m.invertKeyword ? `Mot-clé « ${m.keyword} » présent` : `Mot-clé « ${m.keyword} » absent` };
  }
  return { ok: true, ms, msg: `HTTP ${res.status}` };
}

async function checkTcp(m) {
  const t0 = Date.now();
  const socket = connect({ hostname: m.target, port: m.port });
  let timer;
  try {
    await Promise.race([
      socket.opened,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), m.timeout * 1000);
      }),
    ]);
    return { ok: true, ms: Date.now() - t0, msg: `Port ${m.port} ouvert` };
  } catch (err) {
    return { ok: false, ms: null, msg: err?.name === 'TimeoutError' ? `Délai dépassé (${m.timeout} s)` : `Connexion impossible : ${errorMessage(err, m)}` };
  } finally {
    clearTimeout(timer);
    socket.close().catch(() => {});
  }
}

const RESOLVERS = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/resolve',
};
const RCODES = { 1: 'requête invalide', 2: 'échec du serveur (SERVFAIL)', 3: 'nom inexistant (NXDOMAIN)', 5: 'refusé' };

// DNS sur HTTPS : réponse JSON { Status, Answer: [{ type, data }] }
async function checkDns(m) {
  const t0 = Date.now();
  const url = `${RESOLVERS[m.dnsServer] ?? RESOLVERS.cloudflare}?name=${encodeURIComponent(m.target)}&type=${m.dnsType || 'A'}`;
  const res = await fetch(url, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(m.timeout * 1000) });
  const ms = Date.now() - t0;
  if (!res.ok) return { ok: false, ms: null, msg: `Résolveur DNS : HTTP ${res.status}` };
  const data = await res.json();
  if (data.Status !== 0) return { ok: false, ms, msg: `DNS : ${RCODES[data.Status] ?? `code ${data.Status}`}` };
  const values = (data.Answer ?? []).map((a) => String(a.data).replace(/^"|"$/g, ''));
  if (!values.length) return { ok: false, ms, msg: `Aucun enregistrement ${m.dnsType}` };
  if (m.dnsExpected && !values.some((v) => v.toLowerCase().includes(m.dnsExpected.toLowerCase()))) {
    return { ok: false, ms, msg: `Réponse inattendue : ${values.join(', ')}` };
  }
  return { ok: true, ms, msg: values.join(', ').slice(0, 200) };
}
