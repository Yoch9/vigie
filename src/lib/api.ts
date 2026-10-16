export type MonitorType = 'http' | 'keyword' | 'tcp' | 'ping' | 'dns' | 'push';
export type Status = 'up' | 'down' | 'pending' | 'paused' | 'unknown';

/** [horodatage, code (1 up, 0 down, 2 en attente), ms, message] */
export type Beat = [number, 0 | 1 | 2, number | null, string];
/** [heure, nb up, total, somme ms, nb mesures] */
export type HourBucket = [number, number, number, number, number];

export interface Monitor {
  id: string;
  name: string;
  type: MonitorType;
  group: string;
  target: string;
  interval: number;
  retryInterval: number;
  timeout: number;
  retries: number;
  resendEvery: number;
  notifierIds: string[];
  active: boolean;
  createdAt: number;
  // http / keyword
  method?: string;
  acceptedStatus?: string;
  headers?: string;
  body?: string;
  ignoreTls?: boolean;
  followRedirects?: boolean;
  certExpiryDays?: number;
  keyword?: string;
  invertKeyword?: boolean;
  // tcp / ping / dns / push
  port?: number;
  pingCount?: number;
  dnsType?: string;
  dnsServer?: string;
  dnsExpected?: string;
  pushToken?: string;
  // résumé calculé par le serveur
  status: Status;
  lastChange: number | null;
  lastBeat: Beat | null;
  recent: Beat[];
  uptime24: number | null;
  uptime7d: number | null;
  uptime30d: number | null;
  avgMs24: number | null;
  cert: { validTo: number; daysLeft: number; subject: string | null; issuer: string | null } | null;
  lastPushAt: number | null;
}

export interface Notifier {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
  [field: string]: string | boolean | undefined;
}

export interface VigieEvent {
  t: number;
  monitorId: string | null;
  name: string;
  kind: 'down' | 'up' | 'cert' | 'pause' | 'resume' | 'notify-error';
  msg: string;
}

/** Ce que permet le serveur : Node (tout) ou Worker Cloudflare (pas de ping, pas d'options TLS, 1 min minimum). */
export interface Capabilities {
  platform: 'node' | 'cloudflare';
  /** flux temps réel (SSE) disponible ; sinon l'interface interroge /api/version */
  live: boolean;
  monitorTypes: MonitorType[];
  minInterval: number;
  intervalStep?: number;
  maxRetryInterval?: number;
  tlsOptions: boolean;
}

export interface AppState {
  monitors: Monitor[];
  notifiers: Notifier[];
  notifierTypes: Record<string, string>;
  capabilities: Capabilities;
}

/** Valeur renvoyée par le serveur à la place d'un secret déjà enregistré. */
export const SECRET = '__unchanged__';

/** Appelé quand le serveur répond « connexion requise » (session expirée, mot de passe changé…). */
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) onUnauthorized();
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur HTTP ${res.status}`), { status: res.status });
  return data as T;
}

export const api = {
  me: () => call<{ user: string | null }>('GET', '/api/me'),
  login: (username: string, password: string) => call<{ user: string }>('POST', '/api/login', { username, password }),
  logout: () => call('POST', '/api/logout'),
  state: () => call<AppState>('GET', '/api/state'),
  version: () => call<Record<string, number>>('GET', '/api/version'),
  events: (monitorId?: string, limit = 200) =>
    call<VigieEvent[]>('GET', `/api/events?limit=${limit}${monitorId ? `&monitor=${monitorId}` : ''}`),
  heartbeats: (id: string, range: string) =>
    call<{ kind: 'raw'; points: Beat[] } | { kind: 'hourly'; points: HourBucket[] }>(
      'GET',
      `/api/monitors/${id}/heartbeats?range=${range}`,
    ),
  saveMonitor: (m: Partial<Monitor>, id?: string) =>
    call<Monitor>(id ? 'PUT' : 'POST', id ? `/api/monitors/${id}` : '/api/monitors', m),
  deleteMonitor: (id: string) => call('DELETE', `/api/monitors/${id}`),
  pause: (id: string) => call('POST', `/api/monitors/${id}/pause`),
  resume: (id: string) => call('POST', `/api/monitors/${id}/resume`),
  checkNow: (id: string) => call<Monitor>('POST', `/api/monitors/${id}/check`),
  saveNotifier: (n: Partial<Notifier> & { applyToAll?: boolean }, id?: string) =>
    call<Notifier>(id ? 'PUT' : 'POST', id ? `/api/notifiers/${id}` : '/api/notifiers', n),
  deleteNotifier: (id: string) => call('DELETE', `/api/notifiers/${id}`),
  testNotifier: (n: Partial<Notifier>) => call('POST', '/api/notifiers/test', n),
};

// --- Formatage -------------------------------------------------------------------

export const pct = (v: number | null) =>
  v === null ? '—' : `${(Math.floor(v * 10000) / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;

export const fmtMs = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);

export const fmtDateTime = (t: number) =>
  new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function ago(t: number | null, now = Date.now()) {
  if (!t) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

export function describeTarget(m: Monitor) {
  if (m.type === 'tcp') return `${m.target}:${m.port}`;
  if (m.type === 'dns') return `${m.target} · ${m.dnsType}`;
  if (m.type === 'push') return 'Sonde passive (push)';
  return m.target;
}

export const TYPE_LABELS: Record<MonitorType, string> = {
  http: 'HTTP(S)',
  keyword: 'HTTP(S) + mot-clé',
  tcp: 'Port TCP',
  ping: 'Ping',
  dns: 'DNS',
  push: 'Push (heartbeat)',
};
