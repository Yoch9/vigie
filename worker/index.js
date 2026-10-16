// Point d'entrée du Worker Cloudflare : API JSON (même interface que le serveur Node), URL de push,
// fichiers de l'interface et exécution planifiée chaque minute.
//
// Secrets (wrangler secret put …) : VIGIE_USER, VIGIE_PASSWORD — obligatoires, le Worker est public.
import * as engine from './engine.js';

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

async function digest(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

async function authorized(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)));
  } catch {
    return false;
  }
  const i = decoded.indexOf(':');
  const [u, p] = [decoded.slice(0, i), decoded.slice(i + 1)];
  // comparaison à temps constant, sur des empreintes pour avoir des longueurs égales
  const [a, b, c, d] = await Promise.all([digest(u), digest(env.VIGIE_USER), digest(p), digest(env.VIGIE_PASSWORD)]);
  return crypto.subtle.timingSafeEqual(a, b) & crypto.subtle.timingSafeEqual(c, d) ? true : false;
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

      if (!env.VIGIE_USER || !env.VIGIE_PASSWORD) {
        return new Response('Vigie : définissez les secrets VIGIE_USER et VIGIE_PASSWORD (wrangler secret put).', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
      if (!(await authorized(request, env))) {
        return new Response('Authentification requise', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="Vigie", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
      if (url.pathname.startsWith('/api/')) return await route(request, env, url);
      return env.ASSETS.fetch(request);
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
