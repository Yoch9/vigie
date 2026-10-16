// Connexion à l'interface, commune au serveur Node et au Worker Cloudflare (WebCrypto uniquement).
//
// Un seul compte, défini par VIGIE_USER / VIGIE_PASSWORD. Après connexion, le navigateur reçoit un cookie
// de session signé (HMAC) : « données.signature ». La clé de signature dérive de l'identifiant et du mot
// de passe : changer le mot de passe déconnecte donc toutes les sessions ouvertes.

export const COOKIE = 'vigie_session';
export const SESSION_DAYS = 30;

const enc = new TextEncoder();

const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// comparaison à temps constant de deux tableaux de même longueur
function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmacKey(user, password) {
  return crypto.subtle.importKey('raw', await sha256(`vigie-session:${user}:${password}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Vérifie identifiant et mot de passe saisis (sur des empreintes, pour comparer des longueurs égales). */
export async function checkCredentials(user, password, expectedUser, expectedPassword) {
  const [a, b, c, d] = await Promise.all([sha256(String(user)), sha256(expectedUser), sha256(String(password)), sha256(expectedPassword)]);
  return equal(a, b) & equal(c, d) ? true : false;
}

export async function createSession(user, password) {
  const payload = b64url(enc.encode(JSON.stringify({ u: user, exp: Date.now() + SESSION_DAYS * 86_400_000 })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(user, password), enc.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

export async function verifySession(token, user, password) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return false;
  try {
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(user, password), unb64url(sig), enc.encode(payload));
    if (!valid) return false;
    const data = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    return data.u === user && data.exp > Date.now();
  } catch {
    return false;
  }
}

export function readCookie(header, name = COOKIE) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** En-tête Set-Cookie. `token` vide = suppression. `secure` doit être faux en HTTP simple (sinon le cookie est ignoré). */
export function sessionCookie(token, secure) {
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${token ? SESSION_DAYS * 86_400 : 0}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

// Anti force brute : au-delà de MAX_FAILURES échecs depuis une même adresse en WINDOW, on refuse un moment.
export const MAX_FAILURES = 10;
export const WINDOW = 15 * 60_000;
