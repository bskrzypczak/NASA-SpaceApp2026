/** Selenographic coordinates: latitude −90…90 (north +), longitude −180…180 (east +). */
export interface LatLon {
  lat: number;
  lon: number;
}

/** Accepts longitudes in 0…360 too and folds them into −180…180. */
export function normalizeLon(lon: number): number {
  let l = ((lon + 180) % 360 + 360) % 360 - 180;
  if (Object.is(l, -0)) l = 0;
  return l;
}

export function parseLat(text: string): number | null {
  const v = Number(text.trim().replace(',', '.'));
  if (text.trim() === '' || !Number.isFinite(v) || v < -90 || v > 90) return null;
  return v;
}

export function parseLon(text: string): number | null {
  const v = Number(text.trim().replace(',', '.'));
  if (text.trim() === '' || !Number.isFinite(v) || v < -180 || v > 360) return null;
  return normalizeLon(v);
}

export function formatLat(lat: number, digits = 2): string {
  return `${Math.abs(lat).toFixed(digits)}° ${lat < 0 ? 'S' : 'N'}`;
}

export function formatLon(lon: number, digits = 2): string {
  return `${Math.abs(lon).toFixed(digits)}° ${lon < 0 ? 'W' : 'E'}`;
}

/** Query string used to pass a point between screens, e.g. "?lat=-89.45&lon=-137.3". */
export function toQuery({ lat, lon }: LatLon): string {
  return `?lat=${lat}&lon=${lon}`;
}

export function fromQuery(params: URLSearchParams): LatLon | null {
  const lat = parseLat(params.get('lat') ?? '');
  const lon = parseLon(params.get('lon') ?? '');
  return lat === null || lon === null ? null : { lat, lon };
}
