// Validation des saisies de l'interface, commune au serveur Node et au Worker Cloudflare.
// Les différences d'environnement (types de sonde disponibles, pas de l'intervalle…) passent par `caps`.

export class InputError extends Error {}

export const SECRET = '__unchanged__'; // valeur renvoyée à l'interface à la place des secrets

export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'SRV', 'PTR'];

const HOST = /^[A-Za-z0-9][A-Za-z0-9.:_-]*$/;

export const int = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
export const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * @param caps { monitorTypes, minInterval, intervalStep, maxRetryInterval, tlsOptions, notifierIds }
 */
export function sanitizeMonitor(input, previous, caps) {
  const type = input.type;
  if (!caps.monitorTypes.includes(type)) throw new InputError('Type de sonde invalide');
  const name = str(input.name, 100);
  if (!name) throw new InputError('Le nom est obligatoire');

  const step = caps.intervalStep ?? 1;
  const m = {
    id: previous?.id ?? crypto.randomUUID(),
    name,
    type,
    group: str(input.group, 60),
    target: str(input.target, 2000),
    interval: Math.round(int(input.interval, 60, caps.minInterval, 86_400) / step) * step,
    retryInterval: int(input.retryInterval, 20, 5, caps.maxRetryInterval ?? 86_400),
    timeout: int(input.timeout, 10, 1, 60),
    retries: int(input.retries, 2, 0, 10),
    resendEvery: int(input.resendEvery, 0, 0, 10_080),
    notifierIds: Array.isArray(input.notifierIds) ? input.notifierIds.filter((id) => caps.notifierIds.includes(id)) : [],
    active: previous ? previous.active : true,
    createdAt: previous?.createdAt ?? Date.now(),
  };

  if (type === 'http' || type === 'keyword') {
    let url;
    try {
      url = new URL(m.target);
    } catch {
      throw new InputError('URL invalide (ex. https://exemple.fr)');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new InputError('Seules les URL http(s) sont acceptées');
    Object.assign(m, {
      method: ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS'].includes(input.method) ? input.method : 'GET',
      acceptedStatus: /^[\d\s,-]+$/.test(input.acceptedStatus ?? '') ? str(input.acceptedStatus, 100) : '200-399',
      headers: str(input.headers, 4000),
      body: str(input.body, 10_000),
      followRedirects: input.followRedirects !== false,
    });
    if (caps.tlsOptions) {
      m.ignoreTls = Boolean(input.ignoreTls);
      m.certExpiryDays = int(input.certExpiryDays, 14, 0, 365);
    }
    if (type === 'keyword') {
      m.keyword = str(input.keyword, 500);
      m.invertKeyword = Boolean(input.invertKeyword);
      if (!m.keyword) throw new InputError('Le mot-clé est obligatoire');
    }
  } else if (type === 'tcp' || type === 'ping' || type === 'dns') {
    if (!HOST.test(m.target)) throw new InputError('Hôte ou adresse IP invalide');
    if (type === 'tcp') {
      m.port = int(input.port, 0, 0, 65_535);
      if (!m.port) throw new InputError('Port invalide');
    }
    if (type === 'ping') m.pingCount = int(input.pingCount, 1, 1, 10);
    if (type === 'dns') {
      m.dnsType = DNS_TYPES.includes(input.dnsType) ? input.dnsType : 'A';
      m.dnsServer = str(input.dnsServer, 100);
      m.dnsExpected = str(input.dnsExpected, 300);
    }
  } else if (type === 'push') {
    m.target = '';
    m.pushToken = previous?.pushToken ?? randomHex(16);
  }
  return m;
}

/** @param types sous-ensemble de NOTIFIER_TYPES disponible dans cet environnement */
export function sanitizeNotifier(input, previous, types) {
  const def = types[input.type];
  if (!def) throw new InputError('Type de notification invalide');
  const name = str(input.name, 100);
  if (!name) throw new InputError('Le nom est obligatoire');
  const n = { id: previous?.id ?? crypto.randomUUID(), name, type: input.type, isDefault: Boolean(input.isDefault) };
  for (const f of def.fields) {
    n[f] = input[f] === SECRET && previous?.type === input.type ? previous[f] : str(input[f], 2000);
  }
  for (const f of def.flags ?? []) n[f] = Boolean(input[f]);
  const missing = def.required.filter((f) => !n[f]);
  if (missing.length) throw new InputError(`Champ(s) obligatoire(s) manquant(s) : ${missing.join(', ')}`);
  return n;
}

export function maskNotifier(n, types) {
  const out = { ...n };
  for (const f of types[n.type]?.secrets ?? []) if (out[f]) out[f] = SECRET;
  return out;
}
