import { Vector3 } from 'three';
import type { SimTimeseries } from '../api/types';

const DEG = Math.PI / 180;

/** Local lander frame: +Y up, −Z north, +X east. az from north, clockwise. */
export function azElToVector(azDeg: number, elDeg: number, distance = 1): Vector3 {
  const az = azDeg * DEG;
  const el = elDeg * DEG;
  return new Vector3(Math.cos(el) * Math.sin(az) * distance, Math.sin(el) * distance, -Math.cos(el) * Math.cos(az) * distance);
}

/** Vertical exaggeration consistent for terrain and sky bodies: tan(el') = k·tan(el). */
export function exaggerate(elDeg: number, k: number): number {
  const e = Math.max(-80, Math.min(80, elDeg));
  return Math.atan(k * Math.tan(e * DEG)) / DEG;
}

function index(ts: SimTimeseries, tDays: number) {
  const i = (tDays * 1440) / ts.stepMin;
  const i0 = Math.max(0, Math.min(ts.day.length - 2, Math.floor(i)));
  return { i0, f: Math.min(1, Math.max(0, i - i0)) };
}

export function sampleAt(series: number[], ts: SimTimeseries, tDays: number): number {
  const { i0, f } = index(ts, tDays);
  return series[i0] + (series[i0 + 1] - series[i0]) * f;
}

/** Azimuth interpolated along the shortest arc (359° → 0°). */
export function sampleAz(series: number[], ts: SimTimeseries, tDays: number): number {
  const { i0, f } = index(ts, tDays);
  const d = ((series[i0 + 1] - series[i0] + 540) % 360) - 180;
  return (((series[i0] + d * f) % 360) + 360) % 360;
}

export function sampleBool(series: boolean[], ts: SimTimeseries, tDays: number): boolean {
  const { i0, f } = index(ts, tDays);
  return f < 0.5 ? series[i0] : series[i0 + 1];
}

/** Everything the UI needs at time t. */
export function skyAt(ts: SimTimeseries, t: number) {
  return {
    sunAz: sampleAz(ts.sunAzDeg, ts, t),
    sunEl: sampleAt(ts.sunElDeg, ts, t),
    sunMask: sampleAt(ts.sunMaskElDeg, ts, t),
    sunFrac: sampleAt(ts.sunVisibleFrac, ts, t),
    earthAz: sampleAz(ts.earthAzDeg, ts, t),
    earthEl: sampleAt(ts.earthElDeg, ts, t),
    earthMask: sampleAt(ts.earthMaskElDeg, ts, t),
    earthVisible: sampleBool(ts.earthVisible, ts, t),
    soc: sampleAt(ts.socPct, ts, t),
  };
}

export type SkyState = ReturnType<typeof skyAt>;
