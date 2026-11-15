/**
 * TypeScript port of the backend simulation model (backend/app/simulation.py).
 * Used for MOCK mode only — in live mode the backend is the source of truth.
 * Keep the formulas identical to the backend (README §5.3–5.5).
 */
import { REFERENCE_LANDER } from './landers';
import type { DayWindow, Hardware, ScoreFactor, ScoreWeights, SimEvent, SimSummary, SimTimeseries, Verdict } from '../api/types';

export const SUN_ANGULAR_RADIUS_DEG = 0.266;
export const EARTH_ANGULAR_RADIUS_DEG = 0.95;

/** HORIZON reference lander (VIPER-class) — same values as the backend defaults. See lib/landers.ts. */
export const DEFAULT_HARDWARE: Hardware = { ...REFERENCE_LANDER.hardware };

export const DEFAULT_WEIGHTS: ScoreWeights = { power: 0.5, comms: 0.3, night: 0.2 };

export function interpolateHorizon(azimuthDeg: number[] | null, elevationDeg: number[] | null, az: number): number {
  if (!azimuthDeg || !elevationDeg || elevationDeg.length === 0) return 0;
  if (elevationDeg.length === 1) return elevationDeg[0];
  const n = elevationDeg.length;
  const step = 360 / n;
  const pos = (((az % 360) + 360) % 360) / step;
  const lower = Math.floor(pos) % n;
  const f = pos - Math.floor(pos);
  const upper = (lower + 1) % n;
  return elevationDeg[lower] + (elevationDeg[upper] - elevationDeg[lower]) * f;
}

export function sunVisibleFraction(clearanceDeg: number): number {
  if (clearanceDeg <= -SUN_ANGULAR_RADIUS_DEG) return 0;
  if (clearanceDeg >= SUN_ANGULAR_RADIUS_DEG) return 1;
  const r = clearanceDeg / SUN_ANGULAR_RADIUS_DEG;
  const seg = Math.asin(r) + r * Math.sqrt(1 - r * r);
  return 0.5 + seg / Math.PI;
}

function crossingFraction(a: number, b: number) {
  const d = a - b;
  if (d === 0) return 0.5;
  return Math.min(1, Math.max(0, a / d));
}

export function visibilityWindows(clearances: number[], stepDays: number, endDay: number): DayWindow[] {
  const out: DayWindow[] = [];
  let visible = clearances[0] > 0;
  let start: number | null = visible ? 0 : null;
  for (let i = 1; i < clearances.length; i++) {
    const next = clearances[i] > 0;
    if (next === visible) continue;
    const day = (i - 1 + crossingFraction(clearances[i - 1], clearances[i])) * stepDays;
    if (visible && start !== null) {
      out.push({ fromDay: start, toDay: day });
      start = null;
    } else start = day;
    visible = next;
  }
  if (visible && start !== null) out.push({ fromDay: start, toDay: endDay });
  return out;
}

function longestGapHours(windows: DayWindow[], duration: number) {
  let longest = 0;
  let cursor = 0;
  for (const w of windows) {
    longest = Math.max(longest, w.fromDay - cursor);
    cursor = w.toDay;
  }
  return Math.max(longest, duration - cursor) * 24;
}

const windowPercent = (w: DayWindow[], duration: number) => (w.reduce((a, x) => a + x.toDay - x.fromDay, 0) / duration) * 100;

function transitionEvents(body: 'SUN' | 'EARTH', clear: number[], az: number[], el: number[], stepDays: number, landingMs: number): SimEvent[] {
  const ev: SimEvent[] = [];
  for (let i = 1; i < clear.length; i++) {
    const was = clear[i - 1] > 0;
    const is = clear[i] > 0;
    if (was === is) continue;
    const f = crossingFraction(clear[i - 1], clear[i]);
    const day = (i - 1 + f) * stepDays;
    const dAz = ((az[i] - az[i - 1] + 540) % 360) - 180;
    ev.push({
      type: `${body}${is ? 'RISE' : 'SET'}` as SimEvent['type'],
      time: new Date(landingMs + day * 86_400_000).toISOString().replace('.000Z', 'Z'),
      day: +day.toFixed(4),
      azDeg: +(((az[i - 1] + dAz * f) % 360 + 360) % 360).toFixed(2),
      elDeg: +(el[i - 1] + (el[i] - el[i - 1]) * f).toFixed(2),
    });
  }
  return ev;
}

function batteryHistory(frac: number[], hw: Hardware, stepH: number) {
  let e = hw.batteryWh;
  const soc = [100];
  const net = (f: number) => (f > 0 ? hw.solarW * f - hw.dayLoadW : -hw.nightLoadW);
  for (const f of frac.slice(0, -1)) {
    e = Math.min(hw.batteryWh, Math.max(0, e + net(f) * stepH));
    soc.push((e / hw.batteryWh) * 100);
  }
  const final = Math.min(hw.batteryWh, Math.max(0, e + net(frac[frac.length - 1]) * stepH));
  return { soc, finalSoc: (final / hw.batteryWh) * 100 };
}

export function scoreSummary(minSoc: number, earthPct: number, nightH: number, w: ScoreWeights) {
  const scores = {
    power: Math.min(1, Math.max(0, (minSoc - 10) / 30)),
    comms: Math.min(1, Math.max(0, earthPct / 50)),
    night: Math.min(1, Math.max(0, 1 - (nightH - 72) / 96)),
  };
  const metrics = { power: ['minSocPct', minSoc], comms: ['earthVisiblePct', earthPct], night: ['longestNightH', nightH] } as const;
  const factors: ScoreFactor[] = (['power', 'comms', 'night'] as const).map((k) => ({
    key: k,
    metric: metrics[k][0],
    value: +metrics[k][1].toFixed(2),
    score: +scores[k].toFixed(3),
    weight: +w[k].toFixed(3),
    points: +(scores[k] * w[k] * 100).toFixed(1),
    ok: scores[k] >= 0.6,
  }));
  const weighted = w.power * scores.power + w.comms * scores.comms + w.night * scores.night;
  const successPct = Math.floor(Math.min(97, Math.max(5, 100 * weighted)) + 0.5);
  const verdict: Verdict = successPct >= 80 ? 'LIKELY' : successPct >= 60 ? 'POSSIBLE' : 'RISKY';
  return { successPct, verdict, factors };
}

export interface CaseInput {
  landingMs: number;
  missionDays: number;
  windowDays: number;
  stepMin: number;
  sunAz: number[];
  sunEl: number[];
  earthAz: number[];
  earthEl: number[];
  sunMask: number[];
  earthMask: number[];
  hardware: Hardware;
  weights: ScoreWeights;
}

/** Same as backend _calculate_case. */
export function calculateCase(c: CaseInput) {
  const stepDays = c.stepMin / 1440;
  const days = c.sunAz.map((_, i) => i * stepDays);
  const sunClear = c.sunEl.map((e, i) => e - c.sunMask[i] + SUN_ANGULAR_RADIUS_DEG);
  const earthClear = c.earthEl.map((e, i) => e - c.earthMask[i] + EARTH_ANGULAR_RADIUS_DEG);
  const sunFrac = c.sunEl.map((e, i) => sunVisibleFraction(e - c.sunMask[i]));
  const bothClear = sunClear.map((s, i) => Math.min(s, earthClear[i]));

  const windows = {
    sun: visibilityWindows(sunClear, stepDays, c.windowDays),
    earth: visibilityWindows(earthClear, stepDays, c.windowDays),
    both: visibilityWindows(bothClear, stepDays, c.windowDays),
  };
  // Mission metrics only see samples up to the mission boundary (+1), like the backend fix.
  const m = Math.round((c.missionDays * 1440) / c.stepMin) + 1;
  const mSun = visibilityWindows(sunClear.slice(0, m), stepDays, c.missionDays);
  const mEarth = visibilityWindows(earthClear.slice(0, m), stepDays, c.missionDays);
  const { soc, finalSoc } = batteryHistory(sunFrac, c.hardware, c.stepMin / 60);
  const missionSoc: [number, number][] = soc.map((v, i) => [days[i], v] as [number, number]).filter(([d]) => d <= c.missionDays);
  if (c.missionDays === c.windowDays) missionSoc.push([c.windowDays, finalSoc]);
  const [minSocDay, minSoc] = missionSoc.reduce((a, b) => (b[1] < a[1] ? b : a));
  const earthPct = windowPercent(mEarth, c.missionDays);
  const nightH = longestGapHours(mSun, c.missionDays);
  const { successPct, verdict, factors } = scoreSummary(minSoc, earthPct, nightH, c.weights);

  const events = [
    ...transitionEvents('SUN', sunClear, c.sunAz, c.sunEl, stepDays, c.landingMs),
    ...transitionEvents('EARTH', earthClear, c.earthAz, c.earthEl, stepDays, c.landingMs),
  ];
  const r = c.hardware.reservePct;
  for (let i = 1; i < soc.length; i++) {
    if (soc[i - 1] > r && r >= soc[i]) {
      const day = (i - 1 + crossingFraction(soc[i - 1] - r, soc[i] - r)) * stepDays;
      events.push({ type: 'BATTERY_LOW', time: new Date(c.landingMs + day * 86_400_000).toISOString(), day: +day.toFixed(4) });
      break;
    }
  }
  events.push({ type: 'MISSION_END', time: new Date(c.landingMs + c.missionDays * 86_400_000).toISOString(), day: c.missionDays });
  events.sort((a, b) => a.day - b.day || a.type.localeCompare(b.type));

  const summary: SimSummary = {
    successPct,
    verdict,
    sunlitPct: +windowPercent(mSun, c.missionDays).toFixed(2),
    earthVisiblePct: +earthPct.toFixed(2),
    bothPct: +windowPercent(visibilityWindows(bothClear.slice(0, m), stepDays, c.missionDays), c.missionDays).toFixed(2),
    minSocPct: +minSoc.toFixed(2),
    minSocAtDay: +minSocDay.toFixed(4),
    longestNightH: +nightH.toFixed(2),
    longestCommsGapH: +longestGapHours(mEarth, c.missionDays).toFixed(2),
    firstSunsetDay: events.find((e) => e.type === 'SUNSET')?.day ?? null,
    firstEarthsetDay: events.find((e) => e.type === 'EARTHSET')?.day ?? null,
  };
  const timeseries: SimTimeseries = {
    stepMin: c.stepMin,
    day: days,
    sunAzDeg: c.sunAz,
    sunElDeg: c.sunEl,
    sunMaskElDeg: c.sunMask,
    sunVisibleFrac: sunFrac,
    earthAzDeg: c.earthAz,
    earthElDeg: c.earthEl,
    earthMaskElDeg: c.earthMask,
    earthVisible: earthClear.map((x) => x > 0),
    socPct: soc,
  };
  return { summary, factors, events, windows, timeseries };
}
