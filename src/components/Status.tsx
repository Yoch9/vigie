import { ArrowDown, ArrowUp, Clock, Pause, HelpCircle } from 'lucide-react';
import type { Beat, Status } from '../lib/api';
import { fmtDateTime, fmtMs } from '../lib/api';

export const STATUS: Record<Status, { label: string; color: string; Icon: typeof ArrowUp }> = {
  up: { label: 'UP', color: 'var(--good)', Icon: ArrowUp },
  down: { label: 'DOWN', color: 'var(--critical)', Icon: ArrowDown },
  pending: { label: 'Instable', color: 'var(--warning)', Icon: Clock },
  paused: { label: 'En pause', color: 'var(--paused)', Icon: Pause },
  unknown: { label: 'En attente', color: 'var(--paused)', Icon: HelpCircle },
};

export function StatusBadge({ status, large }: { status: Status; large?: boolean }) {
  const s = STATUS[status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full font-semibold text-white ${large ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-[11px]'}`}
      style={{ background: s.color, color: status === 'pending' ? '#1a1a19' : undefined }}
    >
      <s.Icon size={large ? 14 : 11} strokeWidth={3} aria-hidden />
      {s.label}
    </span>
  );
}

const BEAT_COLOR = ['var(--critical)', 'var(--good)', 'var(--warning)'];
const BEAT_LABEL = ['DOWN', 'UP', 'Instable'];

/** Barre des derniers battements (le plus récent à droite). */
export function HeartbeatBar({ beats, slots = 40, height = 'h-6' }: { beats: Beat[]; slots?: number; height?: string }) {
  const shown = beats.slice(-slots);
  const empty = slots - shown.length;
  return (
    <div className="flex items-stretch gap-[2px]" role="img" aria-label={`${shown.filter((b) => b[1] === 0).length} échec(s) sur les ${shown.length} dernières vérifications`}>
      {Array.from({ length: empty }, (_, i) => (
        <span key={`e${i}`} className={`${height} flex-1 rounded-[3px] bg-slate-200 dark:bg-slate-800`} />
      ))}
      {shown.map((b) => (
        <span
          key={b[0]}
          className={`${height} flex-1 rounded-[3px] transition-transform hover:scale-y-110`}
          style={{ background: BEAT_COLOR[b[1]] }}
          title={`${fmtDateTime(b[0])} — ${BEAT_LABEL[b[1]]}${b[2] !== null ? ` · ${fmtMs(b[2])}` : ''}\n${b[3]}`}
        />
      ))}
    </div>
  );
}
