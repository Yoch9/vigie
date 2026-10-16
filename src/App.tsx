import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Bell, List, Plus, Radar, Search } from 'lucide-react';
import { api, describeTarget, pct, type AppState, type Monitor, type VigieEvent } from './lib/api';
import { HeartbeatBar, StatusBadge, STATUS } from './components/Status';
import MonitorDetail from './components/MonitorDetail';
import MonitorForm from './components/MonitorForm';
import Notifiers from './components/Notifiers';
import EventLog from './components/EventLog';

type View = 'monitors' | 'events' | 'notifiers';

const ORDER = { down: 0, pending: 1, unknown: 2, up: 3, paused: 4 };

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('monitors');
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get('m'));
  const [editing, setEditing] = useState<Monitor | 'new' | null>(null);
  const [query, setQuery] = useState('');
  const [events, setEvents] = useState<VigieEvent[]>([]);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => {
    api.state().then(
      (s) => {
        setState(s);
        setError('');
      },
      (e) => setError(e.message),
    );
  }, []);

  const live = state?.capabilities.live;
  const [connected, setConnected] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    reload();
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [reload]);

  useEffect(() => {
    if (live === undefined) return;
    if (live) {
      // serveur Node : flux temps réel
      const es = new EventSource('/api/stream');
      es.onopen = () => setConnected(true);
      es.onerror = () => setConnected(false);
      es.addEventListener('beat', (e) => {
        const { monitor } = JSON.parse((e as MessageEvent).data) as { monitor: Monitor };
        setState((s) => s && { ...s, monitors: s.monitors.map((m) => (m.id === monitor.id ? monitor : m)) });
      });
      es.addEventListener('config', reload);
      es.addEventListener('event', (e) => setEvents((list) => [JSON.parse((e as MessageEvent).data), ...list].slice(0, 300)));
      return () => es.close();
    }
    // Worker Cloudflare : on demande toutes les 15 s si quelque chose a changé (requête très légère),
    // et seulement quand l'onglet est visible, pour ménager le quota gratuit de lectures D1.
    let last = '';
    const poll = () => {
      if (document.visibilityState !== 'visible') return;
      api.version().then(
        (v) => {
          setConnected(true);
          const key = JSON.stringify(v);
          if (last && key !== last) {
            reload();
            setRefreshKey((n) => n + 1);
          }
          last = key;
        },
        () => setConnected(false),
      );
    };
    poll();
    const t = setInterval(poll, 15_000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [live, reload]);

  useEffect(() => {
    if (view === 'events') api.events(undefined, 300).then(setEvents);
  }, [view, refreshKey]);

  const monitors = state?.monitors ?? [];
  const counts = useMemo(() => {
    const c = { up: 0, down: 0, pending: 0, paused: 0, unknown: 0 };
    for (const m of monitors) c[m.status]++;
    return c;
  }, [monitors]);

  // Titre de l'onglet : nombre de sondes DOWN visible même en arrière-plan
  useEffect(() => {
    document.title = counts.down ? `(${counts.down} DOWN) Vigie` : 'Vigie';
  }, [counts.down]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = monitors
      .filter((m) => !q || `${m.name} ${m.target} ${m.group}`.toLowerCase().includes(q))
      .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name, 'fr'));
    const map = new Map<string, Monitor[]>();
    for (const m of list) map.set(m.group || '', [...(map.get(m.group || '') ?? []), m]);
    return [...map.entries()].sort(([a], [b]) => (a ? (b ? a.localeCompare(b, 'fr') : -1) : 1));
  }, [monitors, query]);

  const current = monitors.find((m) => m.id === selected) ?? null;

  useEffect(() => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set('m', selected);
    else url.searchParams.delete('m');
    history.replaceState(null, '', url.pathname + url.search);
  }, [selected]);

  const usage = useMemo(() => {
    const u: Record<string, number> = {};
    for (const m of monitors) for (const id of m.notifierIds) u[id] = (u[id] ?? 0) + 1;
    return u;
  }, [monitors]);

  const tabs: [View, string, typeof Activity][] = [
    ['monitors', 'Sondes', Activity],
    ['events', 'Journal', List],
    ['notifiers', 'Notifications', Bell],
  ];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2 text-lg font-bold">
            <Radar className="text-emerald-600" size={22} /> Vigie
          </div>
          <nav className="flex gap-1">
            {tabs.map(([k, label, Icon]) => (
              <button key={k} onClick={() => setView(k)} className={`btn ${view === k ? 'bg-slate-100 dark:bg-slate-800' : 'btn-ghost'}`}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {(['up', 'down', 'pending', 'paused'] as const).map((s) =>
              counts[s] || s === 'up' || s === 'down' ? (
                <span key={s} className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS[s].color }} aria-hidden />
                  <span className="font-semibold tabular-nums">{counts[s]}</span>
                  <span className="text-slate-500">{STATUS[s].label}</span>
                </span>
              ) : null,
            )}
            <span
              className={`text-xs ${connected ? 'text-slate-500' : 'text-red-600'}`}
              title={live ? 'Mises à jour en temps réel' : 'Actualisé automatiquement (vérifications chaque minute sur Cloudflare)'}
            >
              {connected ? (live ? '● direct' : '● auto') : '○ hors ligne'}
            </span>
          </div>
        </div>
      </header>

      {error && <div className="bg-red-600 px-4 py-2 text-center text-sm text-white">Serveur Vigie injoignable : {error}</div>}

      <main className="mx-auto max-w-7xl px-4 py-5">
        {view === 'notifiers' && state && <Notifiers notifiers={state.notifiers} types={state.notifierTypes} usage={usage} onChange={reload} />}

        {view === 'events' && (
          <div className="card mx-auto max-w-3xl">
            <h2 className="border-b border-slate-200 px-4 py-3 font-semibold dark:border-slate-800">Journal des incidents</h2>
            <EventLog
              events={events}
              showName
              onSelect={(id) => {
                setSelected(id);
                setView('monitors');
              }}
            />
          </div>
        )}

        {view === 'monitors' && (
          <div className="grid gap-5 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
            <aside className={`space-y-3 ${current ? 'hidden lg:block' : ''}`}>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input className="input !pl-8" placeholder="Rechercher…" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <button className="btn-primary" onClick={() => setEditing('new')}>
                  <Plus size={16} /> Sonde
                </button>
              </div>

              {state && monitors.length === 0 && (
                <div className="card p-6 text-center text-sm text-slate-500">
                  <Radar className="mx-auto mb-2 text-slate-400" size={28} />
                  Aucune sonde. Ajoutez un site web, un routeur (ping), un port TCP ou un enregistrement DNS à surveiller.
                </div>
              )}

              {groups.map(([group, list]) => (
                <section key={group || '_'}>
                  {(group || groups.length > 1) && (
                    <h3 className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{group || 'Sans groupe'}</h3>
                  )}
                  <ul className="card divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">
                    {list.map((m) => (
                      <li key={m.id}>
                        <button
                          onClick={() => setSelected(m.id)}
                          className={`block w-full px-3 py-2.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60 ${
                            m.id === selected ? 'bg-emerald-50/70 dark:bg-emerald-950/30' : ''
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <StatusBadge status={m.status} />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.name}</span>
                            <span className="text-xs tabular-nums text-slate-500" title="Disponibilité sur 24 h">
                              {pct(m.uptime24)}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-xs text-slate-500">{describeTarget(m)}</div>
                          <div className="mt-1.5">
                            <HeartbeatBar beats={m.recent} slots={36} height="h-3.5" />
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </aside>

            <section className={`min-w-0 ${current ? "" : "hidden lg:block"}`}>
              {current ? (
                <>
                  <button className="btn-ghost mb-2 lg:hidden" onClick={() => setSelected(null)}>
                    ← Toutes les sondes
                  </button>
                  <MonitorDetail key={current.id} monitor={current} tick={tick} refreshKey={refreshKey} onEdit={() => setEditing(current)} onDeleted={() => setSelected(null)} />
                </>
              ) : (
                <div className="card grid h-64 place-items-center text-sm text-slate-500">
                  {monitors.length ? 'Sélectionnez une sonde pour voir son historique.' : 'Commencez par ajouter une sonde.'}
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      {editing && state && (
        <MonitorForm
          monitor={editing === 'new' ? undefined : editing}
          notifiers={state.notifiers}
          caps={state.capabilities}
          groups={[...new Set(monitors.map((m) => m.group).filter(Boolean))]}
          onClose={() => setEditing(null)}
          onSaved={(m) => {
            setEditing(null);
            setSelected(m.id);
            reload();
          }}
        />
      )}
    </div>
  );
}
