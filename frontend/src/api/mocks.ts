import type { CalendarRequest, CalendarResult, Heightmap, HorizonProfile, LayerGrid, LayerId, NearbyRequest, NearbyResponse, SourcesMeta, ValidationResult, ScenarioCompareRequest, ScenarioCompareResponse, SimulationRequest, SimulationResult, TerrainPoint } from './types';
import { slopeFromHeights } from '../lib/layers';
import { DEFAULT_HARDWARE, DEFAULT_WEIGHTS, calculateCase, interpolateHorizon } from '../lib/simModel';

/** Small deterministic PRNG so the same point always gives the same mock terrain. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function seedFrom(lat: number, lon: number) {
  return Math.round((lat + 90) * 1000) * 7919 + Math.round((lon + 180) * 1000);
}

export function mockTerrainPoint(lat: number, lon: number): TerrainPoint {
  const r = rng(seedFrom(lat, lon));
  return {
    lat,
    lon,
    elevationM: Math.round(1500 + r() * 800),
    slopeDeg: null, // mirrors the real backend today
    demCoverage: lat <= -80,
    demResolutionM: 100,
    inPermanentShadow: null, // mirrors the real backend today
    nearestSite: null,
  };
}

/** Synthetic cratered terrain. Only for building the UI without a backend — always shown as MOCK DATA. */
export function mockHeightmap(lat: number, lon: number, sizeKm = 20, res = 256): Heightmap {
  const r = rng(seedFrom(lat, lon));
  const craters = Array.from({ length: 40 }, () => ({
    x: r() * sizeKm,
    y: r() * sizeKm,
    radius: 0.2 + Math.pow(r(), 3) * sizeKm * 0.35,
  }));
  const ridgeAngle = r() * Math.PI;
  const heights: number[][] = [];
  let min = Infinity;
  let max = -Infinity;
  const cell = sizeKm / res;
  for (let row = 0; row < res; row++) {
    const line: number[] = [];
    for (let col = 0; col < res; col++) {
      const x = col * cell;
      const y = row * cell;
      // gentle regional slope + a ridge through the middle
      const along = (x - sizeKm / 2) * Math.cos(ridgeAngle) + (y - sizeKm / 2) * Math.sin(ridgeAngle);
      const across = -(x - sizeKm / 2) * Math.sin(ridgeAngle) + (y - sizeKm / 2) * Math.cos(ridgeAngle);
      let h = 300 * Math.exp(-(across * across) / (2 * (sizeKm / 6) ** 2)) + along * 8;
      for (const c of craters) {
        const d = Math.hypot(x - c.x, y - c.y) / c.radius;
        const depth = c.radius * 180; // m
        if (d < 1) h -= depth * (1 - d * d);
        else if (d < 1.5) h += depth * 0.25 * Math.cos(((d - 1) / 0.5) * (Math.PI / 2));
      }
      line.push(h);
      if (h < min) min = h;
      if (h > max) max = h;
    }
    heights.push(line);
  }
  const center = heights[res >> 1][res >> 1];
  const rel = heights.map((line) => line.map((h) => h - center));
  return {
    lat,
    lon,
    sizeKm,
    res,
    originElevationM: null,
    minElevationM: min - center,
    maxElevationM: max - center,
    heightsM: rel,
    northUp: true,
    demVersion: 'MOCK',
    mock: true,
  };
}

/* ---------- Mock horizon + simulation (MOCK mode only) ---------- */

export function mockHorizon(lat: number, lon: number, heightM = 2): HorizonProfile {
  const r = rng(seedFrom(lat, lon) + 17);
  const bumps = Array.from({ length: 5 }, () => ({ az: r() * 360, width: 15 + r() * 40, height: 0.3 + r() * 1.0 }));
  const azimuthDeg: number[] = [];
  const elevationDeg: number[] = [];
  const distanceKm: number[] = [];
  for (let i = 0; i < 720; i++) {
    const az = i * 0.5;
    let el = 0.1 + 0.1 * Math.sin((az * Math.PI) / 30);
    for (const b of bumps) {
      const d = Math.min(Math.abs(az - b.az), 360 - Math.abs(az - b.az));
      el += b.height * Math.exp(-(d * d) / (2 * b.width * b.width));
    }
    azimuthDeg.push(az);
    elevationDeg.push(+el.toFixed(3));
    // Higher horizon = nearer ridge (a few km for big walls, tens of km for low distant hills).
    distanceKm.push(+(8 + 60 * Math.exp(-el * 1.2) + 10 * Math.sin((az * Math.PI) / 45) ** 2).toFixed(2));
  }
  return { lat, lon, heightM, binDeg: 0.5, maxDistanceKm: 150, azimuthDeg, elevationDeg, distanceKm, observerElevationM: -1200, features: [], demVersion: 'MOCK', mock: true };
}

/** Plausible polar-ish geometry: Sun circles the sky once per synodic month, Earth wobbles with libration. */
export function mockSimulation(req: SimulationRequest): SimulationResult {
  const lat = 'lat' in req.site ? req.site.lat : -89.45;
  const lon = 'lon' in req.site ? req.site.lon : -137.3;
  const n = Math.round((req.windowDays * 1440) / req.stepMin);
  const phase0 = (req as SimulationRequest & { phaseOffsetDays?: number }).phaseOffsetDays ?? 0;
  const colat = 90 - Math.abs(lat);
  const sunAz: number[] = [], sunEl: number[] = [], earthAz: number[] = [], earthEl: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = (i * req.stepMin) / 1440 + phase0;
    const phase = (2 * Math.PI * d) / 29.53;
    sunAz.push(((120 + (360 * d) / 29.53) % 360 + 360) % 360);
    sunEl.push(colat * Math.cos(phase + 0.4) * (colat > 10 ? 1 : 0.4) + 1.2 * Math.sin(phase * 0.08 + 1));
    const lib = (2 * Math.PI * d) / 27.3;
    // Earth hangs near the sub-Earth point (0°, 0°) and wobbles with libration.
    const toEarthDeg = (Math.acos(Math.cos((lat * Math.PI) / 180) * Math.cos((lon * Math.PI) / 180)) * 180) / Math.PI;
    earthAz.push(((7 * Math.sin(lib)) % 360 + 360) % 360);
    earthEl.push(90 - toEarthDeg + 6.5 * Math.sin(lib + 1.1));
  }
  const real = req.horizonModel === 'real';
  const hz = real ? mockHorizon(lat, lon) : null;
  const sunMask = sunAz.map((a) => (hz ? interpolateHorizon(hz.azimuthDeg, hz.elevationDeg, a) : 0));
  const earthMask = earthAz.map((a) => (hz ? interpolateHorizon(hz.azimuthDeg, hz.elevationDeg, a) : 0));
  const hardware = { ...DEFAULT_HARDWARE, ...req.hardware };
  const weights = { ...DEFAULT_WEIGHTS, ...req.weights };
  const landingMs = Date.parse(req.landingTime);
  const base = { landingMs, missionDays: req.missionDays, windowDays: req.windowDays, stepMin: req.stepMin, sunAz, sunEl, earthAz, earthEl, hardware, weights };
  const actual = calculateCase({ ...base, sunMask, earthMask });
  const flat = calculateCase({ ...base, sunMask: sunMask.map(() => 0), earthMask: earthMask.map(() => 0) });
  return {
    id: `mock_${seedFrom(lat, lon).toString(36)}_${req.horizonModel}_${landingMs.toString(36)}_${req.missionDays}`,
    createdAt: new Date().toISOString(),
    input: { ...req, hardware, weights },
    site: { name: undefined, lat, lon, elevationM: null },
    ...actual,
    summary: { ...actual.summary, flatHorizonSuccessPct: flat.summary.successPct },
    mock: true,
  };
}

/** Mock calendar: one mock simulation per landing day, hourly samples (like the backend). */
export function mockCalendar(req: CalendarRequest): CalendarResult {
  const lat = 'lat' in req.site ? req.site.lat : -89.45;
  const lon = 'lon' in req.site ? req.site.lon : -137.3;
  const from = Date.parse(`${req.from}T${req.landingTimeOfDay.replace('Z', '')}Z`);
  const to = Date.parse(`${req.to}T00:00:00Z`);
  const days: CalendarResult['days'] = [];
  for (let ms = from; ms <= to + 86_400_000 - 1; ms += 86_400_000) {
    const date = new Date(ms).toISOString().slice(0, 10);
    // Shift the mock sky by the landing date so days differ.
    const offsetDays = (ms - Date.parse('2027-01-01T00:00:00Z')) / 86_400_000;
    const sim = mockSimulation({
      site: { lat, lon },
      landingTime: new Date(ms).toISOString(),
      missionDays: req.missionDays,
      windowDays: req.missionDays,
      stepMin: 60,
      horizonModel: req.horizonModel,
      hardware: req.hardware,
      phaseOffsetDays: offsetDays,
    } as SimulationRequest & { phaseOffsetDays: number });
    days.push({
      date,
      successPct: sim.summary.successPct,
      minSocPct: sim.summary.minSocPct,
      earthVisiblePct: sim.summary.earthVisiblePct,
      longestNightH: sim.summary.longestNightH,
    });
  }
  const best = days.reduce((a, b) => (b.successPct > a.successPct ? b : a), days[0]);
  const byMonth = new Map<string, typeof days>();
  for (const d of days) byMonth.set(d.date.slice(0, 7), [...(byMonth.get(d.date.slice(0, 7)) ?? []), d]);
  const months = [...byMonth.entries()].map(([month, ds]) => ({
    month,
    goodDays: ds.filter((d) => d.successPct >= 80).length,
    bestPct: Math.max(...ds.map((d) => d.successPct)),
  }));
  return { days, best: { date: best.date, successPct: best.successPct }, months, mock: true };
}

/** Mock /scenarios/compare — same recommendation rule as backend/app/scenarios.py. */
export function mockCompare(req: ScenarioCompareRequest): ScenarioCompareResponse {
  const results = req.scenarios.map((sc) => {
    const offsetDays = (Date.parse(sc.landingTime) - Date.parse('2027-01-01T00:00:00Z')) / 86_400_000;
    const sim = mockSimulation({ ...sc, includeTimeseries: false, phaseOffsetDays: offsetDays } as SimulationRequest & { phaseOffsetDays: number });
    return {
      label: sc.label,
      simulationId: sim.id,
      summary: sim.summary,
      windows: sim.windows,
      meetsRequirements: sim.summary.minSocPct >= req.requirements.minSocPct && sim.summary.earthVisiblePct >= req.requirements.minEarthVisiblePct,
    };
  });
  const eligible = results.map((r, i) => (r.meetsRequirements ? i : -1)).filter((i) => i >= 0);
  let recommendation: ScenarioCompareResponse['recommendation'] = null;
  if (eligible.length) {
    const best = Math.max(...eligible.map((i) => results[i].summary.successPct));
    const close = eligible.filter((i) => best - results[i].summary.successPct < 3);
    const baseDate = req.scenarios[0].landingTime.slice(0, 10);
    const same = close.filter((i) => req.scenarios[i].landingTime.slice(0, 10) === baseDate);
    const pool = same.length ? same : close;
    const sel = pool.reduce((a, b) => (results[b].summary.successPct > results[a].summary.successPct ? b : a));
    const score = results[sel].summary.successPct;
    recommendation = { label: results[sel].label, reason: same.length ? `Scores ${score}% on the baseline date — no launch slip needed.` : `Scores ${score}% and meets all requirements.` };
  }
  return { results, recommendation, mock: true };
}

/** Mock /layers/{id}/grid built from the mock heightmap, so overlays line up with the terrain. */
export function mockLayerGrid(id: LayerId, lat: number, lon: number, sizeKm = 20, res = 256): LayerGrid {
  const hm = mockHeightmap(lat, lon, sizeKm, res);
  let values: (number | null)[][];
  if (id === 'slope') values = slopeFromHeights(hm.heightsM, sizeKm);
  else if (id === 'psr') {
    // Deep crater floors near the pole; no coverage north of 80°S (like the real PGDA raster).
    const cut = hm.minElevationM + (hm.maxElevationM - hm.minElevationM) * 0.18;
    values = hm.heightsM.map((row) => row.map((h) => (lat > -80 ? null : h < cut ? 1 : 0)));
  } else if (id === 'illumination' || id === 'earth-visibility') {
    // PGDA averages cover 65–90° N/S; higher ground sees more Sun / Earth.
    const span = Math.max(1, hm.maxElevationM - hm.minElevationM);
    const base = id === 'illumination' ? 20 : 10;
    values = hm.heightsM.map((row) =>
      row.map((h) => (Math.abs(lat) < 65 ? null : Math.round(Math.min(100, base + ((h - hm.minElevationM) / span) * 70) * 1000) / 1000)),
    );
  } else values = hm.heightsM.map((row) => row.map(() => null));
  const flat = values.flat().filter((v): v is number => v !== null);
  return {
    layerId: id, lat, lon, sizeKm, res,
    kind: id === 'psr' ? 'mask' : 'continuous',
    unit: id === 'slope' ? 'deg' : id === 'psr' ? null : '%',
    min: flat.length ? flat.reduce((a, b) => Math.min(a, b)) : null,
    max: flat.length ? flat.reduce((a, b) => Math.max(a, b)) : null,
    values, northUp: true, source: 'mock', version: 'mock', mock: true,
  };
}

/** Mock /nearby: same 3×3 layout as the backend (corners not sampled). */
export function mockNearby(req: NearbyRequest): NearbyResponse {
  const r = rng(seedFrom(req.center.lat + req.radiusKm, req.center.lon + req.goal.length));
  const centre = 45 + Math.round(r() * 30);
  const R = 1737.4;
  const dLat = (req.radiusKm / R) * (180 / Math.PI);
  const dLon = dLat / Math.max(0.01, Math.cos((req.center.lat * Math.PI) / 180));
  const successPct: (number | null)[][] = [[null, null, null], [null, centre, null], [null, null, null]];
  const excluded = [[true, false, true], [false, false, false], [true, false, true]];
  const cells: [number, number, number, number][] = [[0, 1, dLat, 0], [1, 2, 0, dLon], [2, 1, -dLat, 0], [1, 0, 0, -dLon]];
  const suggestions = [];
  for (const [row, col, la, lo] of cells) {
    if (r() < 0.2) continue; // unsafe cell
    const v = Math.max(5, Math.min(98, centre + Math.round((r() - 0.4) * 30)));
    successPct[row][col] = v;
    if (v > centre) suggestions.push({ lat: req.center.lat + la, lon: req.center.lon + lo, distanceKm: req.radiusKm, successPct: v, why: [`+${((v - centre) / 10).toFixed(1)} days of sunlight`, `+${v - centre} pp minimum battery charge`] });
  }
  for (const [row, col] of cells) if (successPct[row][col] === null) excluded[row][col] = true;
  suggestions.sort((a, b) => b.successPct - a.successPct);
  return {
    grid: { originLat: req.center.lat + dLat, originLon: req.center.lon - dLon, cellM: req.radiusKm * 1000, cols: 3, rows: 3, successPct, excluded },
    center: { successPct: centre },
    suggestions: suggestions.slice(0, req.top).map((s, i) => ({ ...s, rank: String.fromCharCode(65 + i) })),
    mock: true,
  };
}

export function mockValidation(lat: number, lon: number): ValidationResult {
  const r = rng(seedFrom(lat, lon));
  const hIll = 40 + r() * 40;
  const hEarth = 30 + r() * 50;
  const pIll = hIll + (r() - 0.5) * 6;
  const pEarth = hEarth + (r() - 0.5) * 6;
  const delta = Math.max(Math.abs(hIll - pIll), Math.abs(hEarth - pEarth));
  return {
    avgIlluminationPct: { horizon: +hIll.toFixed(2), pgda: +pIll.toFixed(2), lrocWac: null },
    earthVisibilityPct: { horizon: +hEarth.toFixed(2), pgda: +pEarth.toFixed(2) },
    deltaMaxPts: +delta.toFixed(2),
    withinTolerance: delta <= 5,
    tolerancePts: 5,
    periodStart: '2027-01-01',
    periodEnd: '2028-01-01',
    periodDays: 365,
    samplingStepHours: 1,
    heightM: 0,
    lrocWacNote: 'No full-coverage LROC WAC illumination raster available.',
    horizonDemVersion: 'MOCK',
    horizonDemResolutionM: 100,
    pgdaVersion: { illumination: 'MOCK', earthVisibility: 'MOCK' },
    mock: true,
  };
}

export const MOCK_SOURCES: SourcesMeta = {
  ephemeris: { name: 'JPL Horizons API', version: 'mock', model: 'DE441', url: 'https://ssd.jpl.nasa.gov/api/horizons.api' },
  terrain: { name: 'LRO LOLA DEM via NASA Moon Trek ImageServer', southPoleNorthPoleResolutionM: 100, globalResolutionPxPerDegree: 256, url: 'https://trek.nasa.gov/moon/' },
  permanentShadow: { name: 'LOLA Permanently Shadowed Regions map', resolutionM: 20, coverage: '80-90 degrees south', url: 'https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LPSR_80S_20MPP_ADJ.TIF' },
  lunarPolarVisibility: { name: 'LOLA Lunar Polar Illumination', source: 'NASA GSFC PGDA', averagingPeriodYears: 18.6, coverage: '65-90 degrees north and south', resolutionM: [60, 120, 240], url: 'https://pgda.gsfc.nasa.gov/products/69' },
  validationRefs: ['JPL Horizons DE441 with NASA Moon Trek LOLA horizon', 'NASA GSFC PGDA Lunar Polar Illumination'],
};
