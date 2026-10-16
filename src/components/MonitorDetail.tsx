import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Pause, Pencil, Play, RefreshCw, Trash2 } from 'lucide-react';
import ResponseChart, { type ChartPoint } from './ResponseChart';
import EventLog from './EventLog';
import { HeartbeatBar, StatusBadge } from './Status';
import { ago, api, describeTarget, fmtMs, pct, TYPE_LABELS, type Monitor, type VigieEvent } from '../lib/api';

const RANGES = [
  ['1h', '1 h', 3_600_000],
  ['6h', '6 h', 6 * 3_600_000],
  ['24h', '24 h', 24 * 3_600_000],
  ['7d', '7 j', 7 * 86_400_000],
  ['30d', '30 j', 30 * 86_400_000],
  ['90d', '90 j', 90 * 86_400_000],
] as const;

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export default function MonitorDetail({
  monitor: m,
  tick,
  refreshKey,
  onEdit,
  onDeleted,
}: {
  monitor: Monitor;
  tick: number;
  refreshKey: number;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number][0]>('24h');
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [hourly, setHourly] = useState(false);
  const [events, setEvents] = useState<VigieEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const span = RANGES.find((r) => r[0] === range)![2];
  const lastT = m.lastBeat?.[0];

  useEffect(() => {
    let alive = true;
    api.heartbeats(m.id, range).then((r) => {
      if (!alive) return;
      setHourly(r.kind === 'hourly');
      setPoints(
        r.kind === 'raw'
          ? r.points.map((b) => ({ t: b[0], ms: b[1] === 1 ? b[2] : null, downRatio: b[1] === 0 ? 1 : 0, count: 1 }))
          : r.points.map((b) => ({ t: b[0], ms: b[4] ? b[3] / b[4] : null, downRatio: b[2] ? (b[2] - b[1]) / b[2] : 0, count: b[2] })),
      );
    });
    return () => {
      alive = false;
    };
  }, [m.id, range, lastT]);

  useEffect(() => {
    api.events(m.id, 30).then(setEvents);
  }, [m.id, m.status, refreshKey]);

  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  void tick; // change toutes les 15 s : force le recalcul des durées affichées
  const now = Date.now();
  const pushUrl = m.pushToken ? `${location.origin}/api/push/${m.pushToken}` : '';
  const last = m.lastBeat;

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold">{m.name}</h2>
              <StatusBadge status={m.status} large />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-slate-500">
              <span>{TYPE_LABELS[m.type]}</span>
              <span>·</span>
              {m.type === 'http' || m.type === 'keyword' ? (
                <a href={m.target} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 truncate hover:text-emerald-600">
                  {m.target} <ExternalLink size={12} />
                </a>
              ) : (
                <span className="truncate">{describeTarget(m)}</span>
              )}
              {m.group && (
                <>
                  <span>·</span>
                  <span>{m.group}</span>
                </>
              )}
            </div>
            {m.status !== 'paused' && m.lastChange && (
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                {m.status === 'down' ? 'DOWN' : 'En service'} depuis {ago(m.lastChange, now)}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {m.type !== 'push' && m.active && (
              <button className="btn-ghost" disabled={busy} onClick={act(() => api.checkNow(m.id))}>
                <RefreshCw size={15} className={busy ? 'animate-spin' : ''} /> Vérifier
              </button>
            )}
            {m.active ? (
              <button className="btn-ghost" onClick={act(() => api.pause(m.id))}>
                <Pause size={15} /> Pause
              </button>
            ) : (
              <button className="btn-ghost" onClick={act(() => api.resume(m.id))}>
                <Play size={15} /> Reprendre
              </button>
            )}
            <button className="btn-ghost" onClick={onEdit}>
              <Pencil size={15} /> Modifier
            </button>
            <button
              className="btn-danger"
              onClick={() => confirm(`Supprimer « ${m.name} » et tout son historique ?`) && api.deleteMonitor(m.id).then(onDeleted)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>
        {last && (
          <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-slate-950 dark:text-slate-400">
            Dernière vérification il y a {ago(last[0], now)} : {last[3]}
          </p>
        )}
        {pushUrl && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            <span className="text-slate-500">URL de push :</span>
            <code className="min-w-0 flex-1 truncate rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">{pushUrl}</code>
            <button className="btn-ghost !p-1.5" onClick={() => navigator.clipboard.writeText(pushUrl)} aria-label="Copier l'URL de push">
              <Copy size={14} />
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <Tile label="Réponse (actuelle)" value={fmtMs(last && last[1] === 1 ? last[2] : null)} />
        <Tile label="Réponse moyenne" value={fmtMs(m.avgMs24)} sub="24 h" />
        <Tile label="Disponibilité 24 h" value={pct(m.uptime24)} />
        <Tile label="Disponibilité 30 j" value={pct(m.uptime30d)} sub={`7 j : ${pct(m.uptime7d)}`} />
        {m.cert ? (
          <Tile
            label="Certificat TLS"
            value={m.cert.daysLeft < 0 ? 'Expiré' : `${m.cert.daysLeft} j`}
            sub={new Date(m.cert.validTo).toLocaleDateString('fr-FR')}
          />
        ) : (
          <Tile label="Intervalle" value={`${m.interval} s`} sub={m.type === 'push' ? 'signal attendu' : `${m.retries} essai(s) avant alerte`} />
        )}
      </div>

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">Temps de réponse</h3>
          <div className="flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800" role="group" aria-label="Période">
            {RANGES.map(([k, label]) => (
              <button
                key={k}
                onClick={() => setRange(k)}
                aria-pressed={range === k}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${range === k ? 'bg-white shadow-sm dark:bg-slate-950' : 'text-slate-600 dark:text-slate-400'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <ResponseChart points={points} from={Date.now() - span} to={Date.now()} hourly={hourly} />
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-[11px] text-slate-500">
            <span>Dernières vérifications</span>
            <span>maintenant</span>
          </div>
          <HeartbeatBar beats={m.recent} slots={60} height="h-7" />
        </div>
      </div>

      <div className="card">
        <h3 className="border-b border-slate-200 px-4 py-3 font-medium dark:border-slate-800">Événements</h3>
        <EventLog events={events} />
      </div>
    </div>
  );
}
