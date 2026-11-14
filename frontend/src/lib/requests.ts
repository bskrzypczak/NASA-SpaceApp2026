import type { HorizonModel } from '../api/types';
import { SITES } from '../data/sites';
import type { SelectionState } from '../store/selection';

/**
 * Real-terrain simulations need GET /horizon, which the backend currently serves
 * only from the south-polar DEM. When the backend adds the global DEM, set this to 90
 * (one-line change) and real terrain works everywhere.
 */
export const TERRAIN_SIM_MAX_LAT = -80;

export function terrainSimAvailable(lat: number): boolean {
  return lat <= TERRAIN_SIM_MAX_LAT;
}

/** Catalog sites go by id (backend uses its own coordinates); anything else by lat/lon. */
export function siteRef(sel: Pick<SelectionState, 'name' | 'lat' | 'lon'>): { siteId: string } | { lat: number; lon: number } {
  const site = SITES.find((s) => s.name === sel.name && s.lat === sel.lat && s.lon === sel.lon);
  return site ? { siteId: site.id } : { lat: +sel.lat.toFixed(5), lon: +sel.lon.toFixed(5) };
}

/** Real terrain where the backend has horizon data; flat horizon elsewhere. */
export function defaultHorizonModel(lat: number): HorizonModel {
  return terrainSimAvailable(lat) ? 'real' : 'flat';
}

/** Short user-facing explanation when real terrain is not available. */
export const TERRAIN_LIMIT_NOTE = 'Real terrain only south of 80° S — this site uses a flat horizon';
