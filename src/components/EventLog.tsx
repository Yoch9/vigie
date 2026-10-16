import { AlertTriangle, ArrowDown, ArrowUp, BellOff, Pause, Play } from 'lucide-react';
import { fmtDateTime, type VigieEvent } from '../lib/api';

const KIND = {
  down: { Icon: ArrowDown, color: 'var(--critical)', label: 'DOWN' },
  up: { Icon: ArrowUp, color: 'var(--good)', label: 'UP' },
  cert: { Icon: AlertTriangle, color: 'var(--warning)', label: 'Certificat' },
  pause: { Icon: Pause, color: 'var(--paused)', label: 'Pause' },
  resume: { Icon: Play, color: 'var(--paused)', label: 'Reprise' },
  'notify-error': { Icon: BellOff, color: 'var(--warning)', label: 'Alerte non envoyée' },
} as const;

export default function EventLog({ events, showName, onSelect }: { events: VigieEvent[]; showName?: boolean; onSelect?: (id: string) => void }) {
  if (!events.length) return <p className="px-4 py-6 text-center text-sm text-slate-500">Aucun événement pour l'instant.</p>;
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {events.map((e, i) => {
        const k = KIND[e.kind] ?? KIND.pause;
        return (
          <li key={`${e.t}-${i}`} className="flex items-start gap-3 px-4 py-2.5 text-sm">
            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-white" style={{ background: k.color }}>
              <k.Icon size={12} strokeWidth={3} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{k.label}</span>
                {showName && e.monitorId && (
                  <button className="truncate font-medium text-emerald-700 hover:underline dark:text-emerald-400" onClick={() => onSelect?.(e.monitorId!)}>
                    {e.name}
                  </button>
                )}
                <span className="text-xs tabular-nums text-slate-500">{fmtDateTime(e.t)}</span>
              </div>
              <p className="break-words text-slate-600 dark:text-slate-400">{e.msg}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
