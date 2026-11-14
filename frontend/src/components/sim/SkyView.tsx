import { useMemo } from 'react';
import type { HorizonProfile, SimTimeseries } from '../../api/types';
import type { SkyState } from '../../lib/sky';

const W = 1440;
const H = 420;
const PAD_T = 30;
const PAD_B = 46;

/**
 * 360° panorama: x = azimuth, y = elevation (true scale, no exaggeration).
 * Grey = terrain horizon from GET /horizon; dashed tracks = Sun / Earth over the whole window.
 */
export function SkyView({ ts, sky, horizon }: { ts: SimTimeseries; sky: SkyState; horizon: HorizonProfile | null }) {
  const scale = useMemo(() => {
    const maskVals = horizon ? horizon.elevationDeg : [0];
    const lo = Math.floor(Math.min(-1, ...maskVals, ...ts.sunElDeg, ...ts.earthElDeg) - 0.5);
    const hi = Math.ceil(Math.max(2, ...maskVals, ...ts.sunElDeg, ...ts.earthElDeg) + 0.5);
    const y = (el: number) => PAD_T + ((hi - el) / (hi - lo)) * (H - PAD_T - PAD_B);
    const step = hi - lo > 40 ? 10 : hi - lo > 12 ? 2 : 1;
    const ticks: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
    return { lo, hi, y, ticks };
  }, [horizon, ts]);

  const x = (az: number) => (az / 360) * W;

  const tracks = useMemo(() => {
    const build = (az: number[], el: number[]) => {
      const parts: string[] = [];
      let cur: string[] = [];
      for (let i = 0; i < az.length; i += 3) {
        if (cur.length && Math.abs(az[i] - az[Math.max(0, i - 3)]) > 180) {
          parts.push(cur.join(' '));
          cur = [];
        }
        cur.push(`${x(az[i]).toFixed(1)},${scale.y(el[i]).toFixed(1)}`);
      }
      if (cur.length) parts.push(cur.join(' '));
      return parts;
    };
    return { sun: build(ts.sunAzDeg, ts.sunElDeg), earth: build(ts.earthAzDeg, ts.earthElDeg) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ts, scale]);

  const terrain = useMemo(() => {
    if (!horizon) return null;
    const pts = horizon.elevationDeg.map((el, i) => `${x(horizon.azimuthDeg[i]).toFixed(1)},${scale.y(el).toFixed(1)}`);
    pts.push(`${W},${scale.y(horizon.elevationDeg[0]).toFixed(1)}`);
    return { line: pts.join(' '), area: `M0,${H} L${pts.join(' L')} L${W},${H} Z` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizon, scale]);

  const sunUp = sky.sunFrac > 0;
  const chip = (az: number, el: number, label: string, cls: string, w: number) => {
    const cx = Math.max(w / 2 + 4, Math.min(W - w / 2 - 4, x(az)));
    const cy = Math.max(PAD_T + 18, scale.y(el) - 30);
    return (
      <g>
        <rect x={cx - w / 2} y={cy - 14} width={w} height={26} rx={13} className={`sky-chip ${cls}`} />
        <text x={cx} y={cy + 4} textAnchor="middle" className={`sky-chip-text ${cls}`}>
          {label}
        </text>
      </g>
    );
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="sky-view" role="img" aria-label="360 degree sky view with terrain horizon and paths of the Sun and Earth">
      {scale.ticks.map((v) => (
        <g key={v}>
          <line x1={0} x2={W} y1={scale.y(v)} y2={scale.y(v)} stroke={v === 0 ? 'rgba(255,255,255,0.55)' : '#1A2A55'} strokeDasharray={v === 0 ? '6 6' : undefined} />
          <text x={8} y={scale.y(v) - 4} className="sky-axis">
            {v > 0 ? '+' : ''}
            {v}°{v === 0 ? ' · flat horizon' : ''}
          </text>
        </g>
      ))}

      {tracks.sun.map((p, i) => (
        <polyline key={`s${i}`} points={p} fill="none" stroke="#EAFE07" strokeWidth={2} strokeDasharray="4 6" opacity={0.75} />
      ))}
      {tracks.earth.map((p, i) => (
        <polyline key={`e${i}`} points={p} fill="none" stroke="#2E96F5" strokeWidth={2} strokeDasharray="4 6" opacity={0.75} />
      ))}

      {terrain && (
        <>
          <path d={terrain.area} fill="#4A5470" />
          <polyline points={terrain.line} fill="none" stroke="#C9D6F0" strokeWidth={2} />
        </>
      )}

      <circle cx={x(sky.sunAz)} cy={scale.y(sky.sunEl)} r={11} fill="#EAFE07" stroke="#07173F" strokeWidth={2} opacity={sunUp ? 1 : 0.55} />
      <circle cx={x(sky.earthAz)} cy={scale.y(sky.earthEl)} r={9} fill="#2E96F5" stroke="#07173F" strokeWidth={2} opacity={sky.earthVisible ? 1 : 0.55} />
      {chip(sky.sunAz, sky.sunEl, `Sun ${sky.sunEl >= 0 ? '+' : ''}${sky.sunEl.toFixed(2)}°${sunUp ? '' : ' · blocked'}`, sunUp ? 'is-sun' : 'is-blocked', sunUp ? 150 : 210)}
      {chip(sky.earthAz, sky.earthEl, `Earth ${sky.earthEl >= 0 ? '+' : ''}${sky.earthEl.toFixed(2)}°${sky.earthVisible ? '' : ' · blocked'}`, sky.earthVisible ? 'is-earth' : 'is-blocked', sky.earthVisible ? 160 : 220)}

      {[0, 45, 90, 135, 180, 225, 270, 315, 360].map((a) => (
        <text key={a} x={Math.min(W - 4, Math.max(4, x(a)))} y={H - 16} textAnchor={a === 0 ? 'start' : a === 360 ? 'end' : 'middle'} className="sky-axis">
          {a === 0 || a === 360 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : ''} {a}°
        </text>
      ))}
      {!horizon && (
        <text x={W / 2} y={PAD_T + 4} textAnchor="middle" className="sky-axis">
          Flat horizon — terrain ignored
        </text>
      )}
    </svg>
  );
}
