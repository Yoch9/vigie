// Point d'entrée du Worker Cloudflare : API JSON (même interface que le serveur Node), URL de push,
// fichiers de l'interface et exécution planifiée chaque minute.
//
// Secrets (wrangler secret put …) : VIGIE_USER, VIGIE_PASSWORD — le compte de l'interface, obligatoire.
// Les fichiers de l'interface sont publics (ils ne contiennent aucune donnée) ; toute l'API est protégée.
import * as engine from './engine.js';
import * as session from '../shared/session.js';

const json = (status, payload) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

async function readBody(request) {
  const text = await request.text();
  if (text.length > 1_000_000) throw new engine.InputError('Requête trop volumineuse');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new engine.InputError('JSON invalide');
  }
}

// --- Connexion -----------------------------------------------------------------

const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'local';

const isSecure = (url) => url.protocol === 'https:';

async function loggedIn(request, env) {
  return session.verifySession(session.readCookie(request.headers.get('Cookie')), env.VIGIE_USER, env.VIGIE_PASSWORD);
}

async function login(request, env, url) {
  const db = env.DB;
  const ip = clientIp(request);
  const now = Date.now();
  const row = await db.prepare('SELECT n, since FROM login_failures WHERE ip = ?1').bind(ip).first();
  if (row && now - row.since < session.WINDOW && row.n >= session.MAX_FAILURES) {
    return json(429, { error: 'Trop de tentatives : réessayez dans quelques minutes.' });
  }
  const { username, password } = await readBody(request);
  if (!(await session.checkCredentials(username ?? '', password ?? '', env.VIGIE_USER, env.VIGIE_PASSWORD))) {
    // une écriture D1 par échec seulement ; le compteur repart de zéro après la fenêtre
    await db
      .prepare(
        `INSERT INTO login_failures (ip, n, since) VALUES (?1, 1, ?2)
         ON CONFLICT(ip) DO UPDATE SET n = CASE WHEN ?2 - since > ?3 THEN 1 ELSE n + 1 END,
                                        since = CASE WHEN ?2 - since > ?3 THEN ?2 ELSE since END`,
      )
      .bind(ip, now, session.WINDOW)
      .run();
    await new Promise((r) => setTimeout(r, 800)); // ralentit les essais en rafale
    return json(401, { error: 'Identifiant ou mot de passe incorrect' });
  }
  if (row) await db.prepare('DELETE FROM login_failures WHERE ip = ?1').bind(ip).run();
  const token = await session.createSession(env.VIGIE_USER, env.VIGIE_PASSWORD);
  return new Response(JSON.stringify({ ok: true, user: env.VIGIE_USER }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': session.sessionCookie(token, isSecure(url)) },
  });
}

async function route(request, env, url) {
  const { pathname, searchParams } = url;
  const method = request.method;
  let m;

  if (pathname === '/api/state' && method === 'GET') return json(200, await engine.getState(env));
  if (pathname === '/api/version' && method === 'GET') return json(200, await engine.getVersion(env));
  if (pathname === '/api/events' && method === 'GET') {
    return json(200, await engine.getEvents(env, searchParams.get('monitor'), Number(searchParams.get('limit')) || 200));
  }

  if (pathname === '/api/monitors' && method === 'POST') return json(201, await engine.upsertMonitor(env, await readBody(request)));
  if ((m = pathname.match(/^\/api\/monitors\/([\w-]+)(?:\/(\w+))?$/))) {
    const [, id, action] = m;
    let result;
    if (!action && method === 'PUT') result = await engine.upsertMonitor(env, await readBody(request), id);
    else if (!action && method === 'DELETE') result = (await engine.deleteMonitor(env, id)) && { ok: true };
    else if (action === 'pause' && method === 'POST') result = await engine.setActive(env, id, false);
    else if (action === 'resume' && method === 'POST') result = await engine.setActive(env, id, true);
    else if (action === 'check' && method === 'POST') result = await engine.checkNow(env, id);
    else if (action === 'heartbeats' && method === 'GET') result = await engine.getHeartbeats(env, id, searchParams.get('range') || '24h');
    else return json(405, { error: 'Méthode non autorisée' });
    return result ? json(200, result) : json(404, { error: 'Sonde introuvable' });
  }

  if (pathname === '/api/notifiers' && method === 'POST') return json(201, await engine.upsertNotifier(env, await readBody(request)));
  if (pathname === '/api/notifiers/test' && method === 'POST') {
    try {
      await engine.testNotifier(env, await readBody(request));
    } catch (err) {
      if (err instanceof engine.InputError) throw err;
      return json(502, { error: err.message });
    }
    return json(200, { ok: true });
  }
  if ((m = pathname.match(/^\/api\/notifiers\/([\w-]+)$/))) {
    let result;
    if (method === 'PUT') result = await engine.upsertNotifier(env, await readBody(request), m[1]);
    else if (method === 'DELETE') result = (await engine.deleteNotifier(env, m[1])) && { ok: true };
    else return json(405, { error: 'Méthode non autorisée' });
    return result ? json(200, result) : json(404, { error: 'Canal introuvable' });
  }

  return json(404, { error: 'Route inconnue' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      // Routes publiques : santé et URL de push (appelées par des scripts / cron)
      if (url.pathname === '/api/health') return json(200, { ok: true });
      const pushMatch = url.pathname.match(/^\/api\/push\/([a-f0-9]{32})$/);
      if (pushMatch) {
        const m = await engine.push(env, pushMatch[1], Object.fromEntries(url.searchParams));
        return m ? json(200, { ok: true }) : json(404, { ok: false, error: 'Jeton inconnu' });
      }

      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

      if (!env.VIGIE_USER || !env.VIGIE_PASSWORD) {
        return json(503, { error: 'Vigie : définissez les secrets VIGIE_USER et VIGIE_PASSWORD (wrangler secret put).' });
      }
      if (url.pathname === '/api/login' && request.method === 'POST') return await login(request, env, url);
      if (url.pathname === '/api/logout' && request.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': session.sessionCookie('', isSecure(url)) },
        });
      }
      if (!(await loggedIn(request, env))) return json(401, { error: 'Connexion requise', login: true });
      if (url.pathname === '/api/me') return json(200, { user: env.VIGIE_USER });
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof engine.InputError) return json(400, { error: err.message });
      console.error(err);
      return json(500, { error: 'Erreur interne' });
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      engine.scheduled(env, controller.scheduledTime).catch((err) => {
        console.error('[vigie] exécution planifiée en échec :', err?.stack || err);
        throw err;
      }),
    );
  },
};
