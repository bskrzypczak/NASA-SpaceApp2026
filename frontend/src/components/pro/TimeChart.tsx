import { useEffect, useMemo, useRef, useState } from 'react';
import type { DayWindow } from '../../api/types';

export interface ChartSeries {
  name: string;
  /** CSS colour of the mark (identity only — text never uses it). */
  color: string;
  values: number[];
  /** "line" = 2 px line; "area" = filled from the bottom of the plot (terrain mask). */
  kind: 'line' | 'area';
  format?: (v: number) => string;
}

export interface RefLine {
  y: number;
  label: string;
  color: string;
}

interface TimeChartProps {
  title: string;
  days: number[];
  series: ChartSeries[];
  yMin?: number;
  yMax?: number;
  yUnit: string;
  /** Shaded spans, e.g. when the body is visible (with a text label for the legend). */
  bands?: { windows: DayWindow[]; color: string; label: string };
  refLines?: RefLine[];
  missionDays: number;
  windowDays: number;
  t: number;
  onT: (t: number) => void;
  height?: number;
}

const M = { left: 46, right: 14, top: 10, bottom: 24 };

/**
 * Small time-series chart for Pro mode: one y-axis, thin lines, recessive grid, crosshair tooltip on hover,
 * click to move the simulation clock. Shared x-axis (days since landing) across all Pro charts.
 */
export function TimeChart({ title, days, series, yMin, yMax, yUnit, bands, refLines = [], missionDays, windowDays, t, onT, height = 170 }: TimeChartProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [lo, hi] = useMemo(() => {
    let a = Infinity;
    let b = -Infinity;
    for (const s of series) for (const v of s.values) if (Number.isFinite(v)) (a = Math.min(a, v)), (b = Math.max(b, v));
    for (const r of refLines) (a = Math.min(a, r.y)), (b = Math.max(b, r.y));
    const pad = (b - a) * 0.08 || 1;
    return [yMin ?? Math.floor(a - pad), yMax ?? Math.ceil(b + pad)];
  }, [series, refLines, yMin, yMax]);

  const pw = width - M.left - M.right;
  const ph = height - M.top - M.bottom;
  const x = (d: number) => M.left + (d / windowDays) * pw;
  const y = (v: number) => M.top + (1 - (v - lo) / (hi - lo)) * ph;

  // Down-sample to ~2 points per pixel so long series stay light.
  const stride = Math.max(1, Math.floor(days.length / (pw * 2)));
  const paths = series.map((s) => {
    let d = '';
    for (let i = 0; i < days.length; i += stride) d += `${d ? 'L' : 'M'}${x(days[i]).toFixed(1)},${y(Math.max(lo, Math.min(hi, s.values[i]))).toFixed(1)}`;
    if (s.kind === 'area') d += `L${x(days[Math.min(days.length - 1, Math.floor((days.length - 1) / stride) * stride)]).toFixed(1)},${y(lo)}L${x(days[0])},${y(lo)}Z`;
    return d;
  });

  const yTicks = niceTicks(lo, hi, 4);
  const xTicks: number[] = [];
  for (let d = 0; d <= windowDays + 1e-6; d += windowDays > 20 ? 5 : 2) xTicks.push(d);

  const idxAt = (d: number) => Math.max(0, Math.min(days.length - 1, Math.round((d / windowDays) * (days.length - 1))));
  const hoverIdx = hover != null ? idxAt(hover) : null;
  const tIdx = idxAt(t);

  function dayFromEvent(e: React.MouseEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(windowDays, ((e.clientX - r.left) / r.width) * windowDays));
  }

  return (
    <figure className="pro-chart" ref={wrap}>
      <figcaption className="pro-chart__head">
        <span className="pro-chart__title">{title}</span>
        <span className="pro-chart__legend">
          {series.map((s) => (
            <span key={s.name} className="pro-chart__key">
              <span className={`pro-chart__swatch${s.kind === 'area' ? ' pro-chart__swatch--area' : ''}`} style={{ background: s.color }} aria-hidden="true" />
              {s.name}
            </span>
          ))}
          {bands && (
            <span className="pro-chart__key">
              <span className="pro-chart__swatch pro-chart__swatch--band" style={{ background: bands.color }} aria-hidden="true" />
              {bands.label}
            </span>
          )}
        </span>
      </figcaption>
      <svg width={width} height={height} role="img" aria-label={`${title}, ${yUnit}, over ${windowDays} days`}>
        {bands?.windows.map((w, i) => (
          <rect key={i} x={x(w.fromDay)} y={M.top} width={Math.max(1, x(w.toDay) - x(w.fromDay))} height={ph} fill={bands.color} opacity={0.14} />
        ))}
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} className="pro-chart__grid" />
            <text x={M.left - 6} y={y(v)} className="pro-chart__tick" textAnchor="end" dominantBaseline="middle">
              {v}
              {yUnit === '%' ? '%' : yUnit === '°' ? '°' : ''}
            </text>
          </g>
        ))}
        {xTicks.map((d) => (
          <text key={d} x={x(d)} y={height - 6} className="pro-chart__tick" textAnchor="middle">
            d{d}
          </text>
        ))}
        {/* Mission end */}
        <line x1={x(missionDays)} x2={x(missionDays)} y1={M.top} y2={M.top + ph} className="pro-chart__end" />
        <text x={x(missionDays) + 4} y={M.top + 10} className="pro-chart__tick">
          mission end
        </text>
        {series.map((s, i) =>
          s.kind === 'area' ? (
            <path key={s.name} d={paths[i]} fill={s.color} opacity={0.55} />
          ) : (
            <path key={s.name} d={paths[i]} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
          ),
        )}
        {refLines.map((r) => (
          <g key={r.label}>
            <line x1={M.left} x2={width - M.right} y1={y(r.y)} y2={y(r.y)} stroke={r.color} strokeDasharray="5 4" strokeWidth={1.5} />
            <text x={width - M.right - 4} y={y(r.y) - 5} className="pro-chart__tick" textAnchor="end">
              {r.label}
            </text>
          </g>
        ))}
        {/* Simulation clock */}
        <line x1={x(t)} x2={x(t)} y1={M.top} y2={M.top + ph} className="pro-chart__now" />
        {series
          .filter((s) => s.kind === 'line')
          .map((s) => (
            <circle key={s.name} cx={x(days[tIdx])} cy={y(Math.max(lo, Math.min(hi, s.values[tIdx])))} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
          ))}
        {hoverIdx != null && <line x1={x(days[hoverIdx])} x2={x(days[hoverIdx])} y1={M.top} y2={M.top + ph} className="pro-chart__hover" />}
        {/* Hit area larger than the marks */}
        <rect
          x={M.left}
          y={0}
          width={pw}
          height={height}
          fill="transparent"
          style={{ cursor: 'crosshair' }}
          onPointerMove={(e) => setHover(dayFromEvent(e))}
          onPointerLeave={() => setHover(null)}
          onClick={(e) => onT(dayFromEvent(e))}
        />
      </svg>
      {hoverIdx != null && (
        <div className="pro-chart__tip" style={{ left: Math.min(width - 190, Math.max(0, x(days[hoverIdx]) + 10)) }} role="status">
          <strong>Day {days[hoverIdx].toFixed(2)}</strong>
          {series.map((s) => (
            <span key={s.name}>
              <span className={`pro-chart__swatch${s.kind === 'area' ? ' pro-chart__swatch--area' : ''}`} style={{ background: s.color }} aria-hidden="true" />
              {s.name}: <span className="mono">{(s.format ?? ((v: number) => `${v.toFixed(1)}${yUnit}`))(s.values[hoverIdx])}</span>
            </span>
          ))}
          <span className="muted">click to jump here</span>
        </div>
      )}
    </figure>
  );
}

function niceTicks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
