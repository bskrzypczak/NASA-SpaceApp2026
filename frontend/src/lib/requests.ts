import type { HorizonModel } from '../api/types';
import { SITES } from '../data/sites';
import type { SelectionState } from '../store/selection';

/** Catalog sites go by id (backend uses its own coordinates); anything else by lat/lon. */
export function siteRef(sel: Pick<SelectionState, 'name' | 'lat' | 'lon'>): { siteId: string } | { lat: number; lon: number } {
  const site = SITES.find((s) => s.name === sel.name && s.lat === sel.lat && s.lon === sel.lon);
  return site ? { siteId: site.id } : { lat: +sel.lat.toFixed(5), lon: +sel.lon.toFixed(5) };
}

/**
 * The backend picks the right LOLA DEM for any latitude (south/north polar or global),
 * so real terrain is the default everywhere. Flat horizon stays available as a toggle
 * and as the fallback when a request returns OUT_OF_DEM_COVERAGE.
 */
export function defaultHorizonModel(_lat?: number): HorizonModel {
  return 'real';
}
