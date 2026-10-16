// Serveur HTTP de Vigie : API JSON, flux temps réel (SSE), URL de push et fichiers de l'interface (dist/).
//
// Variables d'environnement :
//   PORT (3001), HOST (0.0.0.0), VIGIE_DATA (./data)
//   VIGIE_USER / VIGIE_PASSWORD : compte de l'interface (page de connexion) — fortement conseillé si exposé
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from './engine.js';
import * as session from '../shared/session.js';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const USER = process.env.VIGIE_USER || '';
const PASSWORD = process.env.VIGIE_PASSWORD || '';
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const sseClients = new Set();

engine.onEvent((type, data) => {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
});

// --- Utilitaires -----------------------------------------------------------------

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new engine.InputError('Requête trop volumineuse'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new engine.InputError('JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

// --- Connexion -------------------------------------------------------------------

const AUTH = Boolean(USER && PASSWORD);
const failures = new Map(); // adresse IP -> { n, since }

// derrière un reverse proxy HTTPS, le cookie doit être marqué Secure
const isSecure = (req) => Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

async function loggedIn(req) {
  return !AUTH || session.verifySession(session.readCookie(req.headers.cookie), USER, PASSWORD);
}

async function login(req, res) {
  const ip = clientIp(req);
  const now = Date.now();
  let f = failures.get(ip);
  if (f && now - f.since > session.WINDOW) {
    failures.delete(ip);
    f = undefined;
  }
  if (f && f.n >= session.MAX_FAILURES) return json(res, 429, { error: 'Trop de tentatives : réessayez dans quelques minutes.' });
  const { username, password } = await readBody(req);
  if (!(await session.checkCredentials(username ?? '', password ?? '', USER, PASSWORD))) {
    failures.set(ip, f ? { ...f, n: f.n + 1 } : { n: 1, since: now });
    await new Promise((r) => setTimeout(r, 800)); // ralentit les essais en rafale
    return json(res, 401, { error: 'Identifiant ou mot de passe incorrect' });
  }
  failures.delete(ip);
  res.setHeader('Set-Cookie', session.sessionCookie(await session.createSession(USER, PASSWORD), isSecure(req)));
  return json(res, 200, { ok: true, user: USER });
}

function serveStatic(req, res, pathname) {
  let file = path.join(DIST, decodeURIComponent(pathname));
  if (!file.startsWith(DIST)) return json(res, 400, { error: 'Chemin invalide' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end("Interface non compilée : lancez « npm run build » (ou « npm run dev:web » en développement).");
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

// --- Routes ------------------------------------------------------------------------

async function route(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method;
  let m;

  if (pathname === '/api/state' && method === 'GET') return json(res, 200, engine.getState());

  if (pathname === '/api/stream' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }

  if (pathname === '/api/events' && method === 'GET') {
    return json(res, 200, engine.getEvents(searchParams.get('monitor'), Number(searchParams.get('limit')) || 200));
  }

  if (pathname === '/api/monitors' && method === 'POST') return json(res, 201, engine.upsertMonitor(await readBody(req)));

  if ((m = pathname.match(/^\/api\/monitors\/([\w-]+)(?:\/(\w+))?$/))) {
    const [, id, action] = m;
    let result;
    if (!action && method === 'PUT') result = engine.upsertMonitor(await readBody(req), id);
    else if (!action && method === 'DELETE') result = engine.deleteMonitor(id) && { ok: true };
    else if (action === 'pause' && method === 'POST') result = engine.setActive(id, false);
    else if (action === 'resume' && method === 'POST') result = engine.setActive(id, true);
    else if (action === 'check' && method === 'POST') result = await engine.checkNow(id);
    else if (action === 'heartbeats' && method === 'GET') result = engine.getHeartbeats(id, searchParams.get('range') || '24h');
    else return json(res, 405, { error: 'Méthode non autorisée' });
    return result ? json(res, 200, result) : json(res, 404, { error: 'Sonde introuvable' });
  }

  if (pathname === '/api/notifiers' && method === 'POST') return json(res, 201, engine.upsertNotifier(await readBody(req)));
  if (pathname === '/api/notifiers/test' && method === 'POST') {
    await engine.testNotifier(await readBody(req));
    return json(res, 200, { ok: true });
  }
  if ((m = pathname.match(/^\/api\/notifiers\/([\w-]+)$/))) {
    const id = m[1];
    let result;
    if (method === 'PUT') result = engine.upsertNotifier(await readBody(req), id);
    else if (method === 'DELETE') result = engine.deleteNotifier(id) && { ok: true };
    else return json(res, 405, { error: 'Méthode non autorisée' });
    return result ? json(res, 200, result) : json(res, 404, { error: 'Canal introuvable' });
  }

  return json(res, 404, { error: 'Route inconnue' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // Routes publiques : santé du service et URL de push (appelées par des scripts / cron)
    if (url.pathname === '/api/health') return json(res, 200, { ok: true });
    const push = url.pathname.match(/^\/api\/push\/([a-f0-9]{32})$/);
    if (push) {
      const q = Object.fromEntries(url.searchParams);
      const m = engine.push(push[1], q);
      return m ? json(res, 200, { ok: true }) : json(res, 404, { ok: false, error: 'Jeton inconnu' });
    }

    // L'interface est publique (aucune donnée dedans) ; toute l'API est protégée.
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Méthode non autorisée' });
      return serveStatic(req, res, url.pathname);
    }
    if (AUTH && url.pathname === '/api/login' && req.method === 'POST') return await login(req, res);
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', session.sessionCookie('', isSecure(req)));
      return json(res, 200, { ok: true });
    }
    if (!(await loggedIn(req))) return json(res, 401, { error: 'Connexion requise', login: true });
    if (url.pathname === '/api/me') return json(res, 200, { user: AUTH ? USER : null });
    return await route(req, res, url);
  } catch (err) {
    if (err instanceof engine.InputError) return json(res, 400, { error: err.message });
    if (url.pathname === '/api/notifiers/test') return json(res, 502, { error: err.message });
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Erreur interne' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[vigie] à l'écoute sur http://${HOST}:${PORT}`);
  if (!AUTH) console.warn('[vigie] ⚠ aucune authentification (définir VIGIE_USER et VIGIE_PASSWORD avant d’exposer le service)');
  engine.start();
});

function shutdown() {
  engine.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
