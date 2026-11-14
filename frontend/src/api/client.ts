import type { ApiErrorBody, ApiSite, Heightmap, LayerInfo, TerrainPoint } from './types';
import { SITES } from '../data/sites';
import { mockHeightmap, mockTerrainPoint } from './mocks';

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true';

/**
 * live    — VITE_API_URL is set: real backend.
 * mock    — no backend, VITE_USE_MOCKS=true: generated data, always labelled in the UI.
 * offline — no backend, no mocks: endpoints resolve to null and the UI shows "—".
 */
export const apiMode: 'live' | 'mock' | 'offline' = BASE ? 'live' : USE_MOCKS ? 'mock' : 'offline';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status?: number, public field?: string) {
    super(message);
  }
}

async function get<T>(path: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      /* not JSON */
    }
    throw new ApiError(body?.error.code ?? `HTTP_${res.status}`, body?.error.message ?? res.statusText, res.status, body?.error.field);
  }
  return (await res.json()) as T;
}

export async function getTerrainPoint(lat: number, lon: number, signal?: AbortSignal): Promise<TerrainPoint | null> {
  if (apiMode === 'live') return get<TerrainPoint>('/terrain/point', { lat, lon }, signal);
  if (apiMode === 'mock') return mockTerrainPoint(lat, lon);
  return null;
}

export async function getHeightmap(lat: number, lon: number, sizeKm: number, res = 256, signal?: AbortSignal): Promise<Heightmap | null> {
  if (apiMode === 'live') {
    try {
      return await get<Heightmap>('/terrain/heightmap', { lat, lon, sizeKm, res, format: 'json' }, signal);
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
    const res = await get<{ items: ApiSite[]; total: number }>('/sites', {}, signal);
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

export async function getLayers(signal?: AbortSignal): Promise<LayerInfo[]> {
  if (apiMode !== 'live') return DEFAULT_LAYERS;
  try {
    const res = await get<{ layers: LayerInfo[] }>('/layers', {}, signal);
    return DEFAULT_LAYERS.map((d) => res.layers.find((l) => l.id === d.id) ?? d);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return DEFAULT_LAYERS; // endpoint not built yet
    throw e;
  }
}
