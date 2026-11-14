import { slopeFromHeights } from '../lib/layers';
import type { NearbyRequest, NearbyResponse, ApiSite, CalendarRequest, CalendarResult, ScenarioCompareRequest, ScenarioCompareResponse, Heightmap, HorizonProfile, LayerGrid, LayerId, LayerInfo, SimulationRequest, SimulationResult, TerrainPoint } from './types';
import { SITES } from '../data/sites';
import { mockCalendar, mockCompare, mockHeightmap, mockHorizon, mockSimulation, mockTerrainPoint, mockLayerGrid, mockNearby } from './mocks';

import { ApiError, BASE, TIMEOUT, get, post } from './http';

export { ApiError, clearApiCache } from './http';

const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true';

/**
 * live    — VITE_API_URL is set: real backend.
 * mock    — no backend, VITE_USE_MOCKS=true: generated data, always labelled in the UI.
 * offline — no backend, no mocks: endpoints resolve to null and the UI shows "—".
 */
export const apiMode: 'live' | 'mock' | 'offline' = BASE ? 'live' : USE_MOCKS ? 'mock' : 'offline';

export async function getTerrainPoint(lat: number, lon: number, signal?: AbortSignal): Promise<TerrainPoint | null> {
  if (apiMode === 'live') return get<TerrainPoint>('/terrain/point', { lat, lon }, { signal, timeoutMs: TIMEOUT.terrain, cacheIf: (p) => p.complete !== false });
  if (apiMode === 'mock') return mockTerrainPoint(lat, lon);
  return null;
}

/** Elevation first, fast: one small DEM export instead of /terrain/point's 5 samples + PSR lookup. */
export interface QuickTerrain {
  elevationM: number;
  /** Approximate (5 km / 16 px grid, ~300 m cells). /terrain/point gives the precise value. */
  slopeDeg: number | null;
  demResolutionM: number | null;
  source: 'heightmap' | 'point';
}

const QUICK_SIZE_KM = 5;
const QUICK_RES = 16;

export async function getQuickTerrain(lat: number, lon: number, signal?: AbortSignal): Promise<QuickTerrain | null> {
  if (apiMode === 'offline') return null;
  try {
    const hm =
      apiMode === 'live'
        ? await get<Heightmap>('/terrain/heightmap', { lat, lon, sizeKm: QUICK_SIZE_KM, res: QUICK_RES, format: 'json' }, { signal, timeoutMs: TIMEOUT.terrain })
        : mockHeightmap(lat, lon, QUICK_SIZE_KM, QUICK_RES);
    if (hm.originElevationM != null) {
      return { elevationM: hm.originElevationM, slopeDeg: centreSlope(hm.heightsM, QUICK_SIZE_KM), demResolutionM: hm.demResolutionM ?? null, source: 'heightmap' };
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    // Outside DEM coverage or the backend is timing out: /terrain/point would fail the same way.
    if (e instanceof ApiError && (e.code === 'OUT_OF_DEM_COVERAGE' || e.code === 'CLIENT_TIMEOUT' || e.status === 504)) throw e;
    console.warn('Quick heightmap failed, falling back to /terrain/point', e);
  }
  const p = await getTerrainPoint(lat, lon, signal);
  return p?.elevationM != null ? { elevationM: p.elevationM, slopeDeg: p.slopeDeg, demResolutionM: p.demResolutionM, source: 'point' } : null;
}

/** Mean Horn slope of the 4 cells around the grid centre (the landing point sits on their shared corner). */
function centreSlope(heightsM: number[][], sizeKm: number): number | null {
  const g = slopeFromHeights(heightsM, sizeKm);
  const m = heightsM.length / 2;
  const vals = [g[m - 1]?.[m - 1], g[m - 1]?.[m], g[m]?.[m - 1], g[m]?.[m]].filter((v): v is number => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

export async function getHeightmap(lat: number, lon: number, sizeKm: number, res = 256, signal?: AbortSignal): Promise<Heightmap | null> {
  if (apiMode === 'live') {
    try {
      return await get<Heightmap>('/terrain/heightmap', { lat, lon, sizeKm, res, format: 'json' }, { signal, timeoutMs: TIMEOUT.terrain });
    } catch (e) {
      // Endpoint not built yet on the backend → keep the UI usable, clearly labelled.
      if (e instanceof ApiError && e.status === 404) {
        return { ...mockHeightmap(lat, lon, sizeKm, res), fallbackReason: 'backend has no /terrain/heightmap yet' };
      }
      throw e;
    }
  }
  if (apiMode === 'mock') return mockHeightmap(lat, lon, sizeKm, res);
  return null;
}

export interface SitesResult {
  items: ApiSite[];
  source: 'backend' | 'local';
}

/** Site catalog from the backend; falls back to the bundled list if there is no backend or it fails. */
export async function getSites(signal?: AbortSignal): Promise<SitesResult> {
  const local: SitesResult = { items: SITES.map((s) => ({ ...s, coordsVerified: false })), source: 'local' };
  if (apiMode !== 'live') return local;
  try {
    const res = await get<{ items: ApiSite[]; total: number }>('/sites', {}, { signal });
    return { items: res.items, source: 'backend' };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    console.warn('GET /sites failed, using the bundled catalog', e);
    return local;
  }
}

/** Layer list. Layers the backend does not serve yet come back with tileUrl = null. */
export const DEFAULT_LAYERS: LayerInfo[] = [
  { id: 'illumination', name: 'Sunlight (avg.)', source: 'PGDA', tileUrl: null },
  { id: 'earth-visibility', name: 'Earth visibility', source: 'PGDA', tileUrl: null },
  { id: 'psr', name: 'Permanent shadow', source: 'PGDA', tileUrl: null },
  { id: 'slope', name: 'Slope > 10°', source: 'LOLA', tileUrl: null },
];

/** Layers with a grid on the backend, used when /layers does not say so explicitly. */
export const GRID_LAYERS: ReadonlySet<LayerId> = new Set<LayerId>(['illumination', 'earth-visibility', 'slope', 'psr']);

export function layerHasGrid(l: LayerInfo): boolean {
  if (apiMode === 'offline') return false;
  return l.grid ?? GRID_LAYERS.has(l.id);
}

/** Overlay grid aligned 1:1 with getHeightmap(lat, lon, sizeKm, res). null = no backend. */
export async function getLayerGrid(id: LayerId, lat: number, lon: number, sizeKm: number, res = 256, signal?: AbortSignal): Promise<LayerGrid | null> {
  if (apiMode === 'live') return get<LayerGrid>(`/layers/${id}/grid`, { lat, lon, sizeKm, res }, { signal, timeoutMs: TIMEOUT.terrain });
  if (apiMode === 'mock') return mockLayerGrid(id, lat, lon, sizeKm, res);
  return null;
}

export async function getLayers(signal?: AbortSignal): Promise<LayerInfo[]> {
  if (apiMode !== 'live') return DEFAULT_LAYERS;
  try {
    const res = await get<{ layers: LayerInfo[] }>('/layers', {}, { signal });
    return DEFAULT_LAYERS.map((d) => res.layers.find((l) => l.id === d.id) ?? d);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return DEFAULT_LAYERS; // endpoint not built yet
    throw e;
  }
}

/* ---------- Horizon & simulations ---------- */

/** Terrain horizon around the point. null = flat model / outside DEM coverage / no backend. */
export async function getHorizon(lat: number, lon: number, heightM = 2, signal?: AbortSignal): Promise<HorizonProfile | null> {
  if (apiMode === 'live') {
    try {
      return await get<HorizonProfile>('/horizon', { lat, lon, heightM, binDeg: 0.5 }, { signal, timeoutMs: TIMEOUT.horizon });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'OUT_OF_DEM_COVERAGE') return null;
      throw e;
    }
  }
  if (apiMode === 'mock') return mockHorizon(lat, lon, heightM);
  return null;
}

const mockStore = new Map<string, SimulationResult>();

/** POST /simulations. The first run for a new site can take ~40 s on the backend (DEM download). */
export async function createSimulation(req: SimulationRequest, signal?: AbortSignal): Promise<SimulationResult> {
  if (apiMode === 'live') return post<SimulationResult>('/simulations', req, { signal, timeoutMs: TIMEOUT.simulation, retries: 1 });
  if (apiMode === 'mock') {
    await new Promise((r) => setTimeout(r, 900)); // feel the loading state
    const res = mockSimulation(req);
    mockStore.set(res.id, res);
    return res;
  }
  throw new ApiError('BACKEND_OFFLINE', 'No backend configured. Set VITE_API_URL or VITE_USE_MOCKS=true in .env.local.');
}

/** GET /simulations/{id}. Results live in backend memory — 404 after a backend restart. */
export async function getSimulation(id: string, signal?: AbortSignal): Promise<SimulationResult> {
  if (apiMode === 'live') return get<SimulationResult>(`/simulations/${encodeURIComponent(id)}`, {}, { signal, timeoutMs: TIMEOUT.simulation });
  const hit = mockStore.get(id);
  if (hit) return hit;
  throw new ApiError('NOT_FOUND', 'Simulation not found (mock results are kept only until reload).', 404);
}

/** POST /calendar — one score per landing day. Synchronous on the backend: a full year can take a while. */
export async function getCalendar(req: CalendarRequest, signal?: AbortSignal): Promise<CalendarResult> {
  if (apiMode === 'live') return post<CalendarResult>('/calendar', req, { signal, timeoutMs: TIMEOUT.heavy });
  if (apiMode === 'mock') {
    await new Promise((r) => setTimeout(r, 500));
    return mockCalendar(req);
  }
  throw new ApiError('BACKEND_OFFLINE', 'No backend configured. Set VITE_API_URL or VITE_USE_MOCKS=true in .env.local.');
}

/** POST /scenarios/compare — 2–4 simulations in parallel on the backend (can take tens of seconds). */
export async function compareScenarios(req: ScenarioCompareRequest, signal?: AbortSignal): Promise<ScenarioCompareResponse> {
  if (apiMode === 'live') return post<ScenarioCompareResponse>('/scenarios/compare', req, { signal, timeoutMs: TIMEOUT.heavy });
  if (apiMode === 'mock') {
    await new Promise((r) => setTimeout(r, 800));
    const res = mockCompare(req);
    // Keep full mock simulations so "Open simulation" works in mock mode too.
    req.scenarios.forEach((sc, i) => {
      const offsetDays = (Date.parse(sc.landingTime) - Date.parse('2027-01-01T00:00:00Z')) / 86_400_000;
      const sim = mockSimulation({ ...sc, includeTimeseries: true, phaseOffsetDays: offsetDays } as SimulationRequest & { phaseOffsetDays: number });
      mockStore.set(res.results[i].simulationId, { ...sim, id: res.results[i].simulationId });
    });
    return res;
  }
  throw new ApiError('BACKEND_OFFLINE', 'No backend configured. Set VITE_API_URL or VITE_USE_MOCKS=true in .env.local.');
}

/** POST /nearby — synchronous, simulates the centre + up to 4 points (can take a while on a cold cache). */
export async function getNearby(req: NearbyRequest, signal?: AbortSignal): Promise<NearbyResponse> {
  if (apiMode === 'live') return post<NearbyResponse>('/nearby', req, { signal, timeoutMs: TIMEOUT.heavy, retries: 1 });
  if (apiMode === 'mock') {
    await new Promise((r) => setTimeout(r, 900));
    return mockNearby(req);
  }
  throw new ApiError('BACKEND_OFFLINE', 'No backend configured. Set VITE_API_URL or VITE_USE_MOCKS=true in .env.local.');
}
