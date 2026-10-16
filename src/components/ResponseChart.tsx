import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtMs } from '../lib/api';

export interface ChartPoint {
  t: number;
  ms: number | null;
  /** part des vérifications en échec sur ce point (0 = tout bon, 1 = tout DOWN) */
  downRatio: number;
  /** nombre de vérifications agrégées (1 pour un battement brut) */
  count: number;
}

const H = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 48 };

function niceMax(v: number) {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Temps de réponse dans le temps ; les périodes d'indisponibilité sont surlignées en rouge. */
export default function ResponseChart({ points, from, to, hourly }: { points: ChartPoint[]; from: number; to: number; hourly: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { path, yMax, ticks, xTicks, x, y } = useMemo(() => {
    const vals = points.map((p) => p.ms).filter((v): v is number => v !== null).sort((a, b) => a - b);
    // échelle calée sur le 98e centile pour qu'un pic isolé n'écrase pas la courbe
    const ref = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.98))] * 1.15 : 100;
    const yMax = niceMax(ref);
    const iw = width - PAD.left - PAD.right;
    const ih = H - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + ((t - from) / Math.max(1, to - from)) * iw;
    const y = (v: number) => PAD.top + ih - (Math.min(v, yMax) / yMax) * ih;

    let path = '';
    let pen = false;
    for (const p of points) {
      if (p.ms === null) {
        pen = false;
        continue;
      }
      path += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.ms).toFixed(1)}`;
      pen = true;
    }
    const ticks = [0, yMax / 2, yMax];
    const span = to - from;
    const step = span <= 2 * 3_600_000 ? 15 * 60_000 : span <= 7 * 3_600_000 ? 3_600_000 : span <= 26 * 3_600_000 ? 4 * 3_600_000 : span <= 8 * 86_400_000 ? 86_400_000 : 7 * 86_400_000;
    const xTicks: number[] = [];
    const tzOffset = new Date().getTimezoneOffset() * 60_000;
    for (let t = Math.ceil((from - tzOffset) / step) * step + tzOffset; t <= to; t += step) xTicks.push(t);
    return { path, yMax, ticks, xTicks, x, y };
  }, [points, width, from, to]);

  const fmtTick = (t: number) =>
    to - from > 30 * 3_600_000
      ? new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
      : new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    if (!points.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = from + ((e.clientX - rect.left) / rect.width) * (to - from);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
    setHover(best);
  }

  const bandW = hourly ? Math.max(2, x(from + 3_600_000) - x(from)) : 0;
  const hp = hover !== null ? points[hover] : null;

  return (
    <div ref={wrap} className="relative">
      <svg width={width} height={H} className="block select-none" role="img" aria-label="Temps de réponse">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} className="stroke-slate-200 dark:stroke-slate-800" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-slate-500 text-[11px] tabular-nums">
              {v >= 1000 ? `${v / 1000} s` : `${v} ms`}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor="middle" className="fill-slate-500 text-[11px] tabular-nums">
            {fmtTick(t)}
          </text>
        ))}

        {/* indisponibilités */}
        {points.map((p, i) => {
          if (p.downRatio <= 0) return null;
          const w = hourly ? bandW : Math.max(3, i + 1 < points.length ? x(points[i + 1].t) - x(p.t) : 3);
          return (
            <rect
              key={p.t}
              x={x(p.t) - (hourly ? 0 : 1)}
              y={PAD.top}
              width={w}
              height={H - PAD.top - PAD.bottom}
              fill="var(--critical)"
              opacity={0.12 + 0.4 * p.downRatio}
            />
          );
        })}

        <path d={path} fill="none" stroke="#3a7bd5" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {hp && (
          <g pointerEvents="none">
            <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.top} y2={H - PAD.bottom} className="stroke-slate-400 dark:stroke-slate-500" strokeWidth={1} />
            {hp.ms !== null && <circle cx={x(hp.t)} cy={y(hp.ms)} r={4.5} fill="#3a7bd5" className="stroke-white dark:stroke-slate-900" strokeWidth={2} />}
          </g>
        )}
        <rect
          x={PAD.left}
          y={0}
          width={Math.max(0, width - PAD.left - PAD.right)}
          height={H}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>

      {hp && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-800"
          style={{ left: Math.min(Math.max(x(hp.t) - 70, 0), width - 150), width: 150 }}
        >
          <div className="font-semibold tabular-nums text-slate-900 dark:text-slate-50">{hp.ms === null ? 'Pas de mesure' : fmtMs(hp.ms)}</div>
          <div className="text-slate-500 dark:text-slate-400">
            {new Date(hp.t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: hourly ? undefined : '2-digit' })}
          </div>
          {hp.downRatio > 0 && (
            <div className="mt-0.5 font-medium text-red-700 dark:text-red-400">
              {hourly ? `${Math.round(hp.downRatio * 100)} % d'échecs sur ${hp.count}` : 'DOWN'}
            </div>
          )}
        </div>
      )}
      {!points.length && <div className="absolute inset-0 grid place-items-center text-sm text-slate-500">Pas encore de données</div>}
      <span className="sr-only">Maximum affiché : {yMax} ms</span>
    </div>
  );
}
