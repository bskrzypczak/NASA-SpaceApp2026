/** Response shapes from backend/README.md. Fields the backend cannot compute yet are `null`. */

export interface TerrainPoint {
  lat: number;
  lon: number;
  elevationM: number | null;
  /** null until the backend derives slope from the DEM. */
  slopeDeg: number | null;
  demCoverage: boolean;
  demResolutionM: number | null;
  /** null until a PSR map is wired in. */
  inPermanentShadow: boolean | null;
  nearestSite?: { id: string; distanceKm: number } | null;
  demVersion?: string;
  source?: string;
}

export interface Heightmap {
  lat: number;
  lon: number;
  sizeKm: number;
  res: number;
  originElevationM: number | null;
  minElevationM: number;
  maxElevationM: number;
  /** heightsM[row][col], row 0 = north edge, col 0 = west edge, metres relative to the landing point. */
  heightsM: number[][];
  northUp: boolean;
  demVersion: string;
  /** Set by the mock generator only. */
  mock?: boolean;
  /** Why mock data is shown, e.g. the endpoint is not built yet. */
  fallbackReason?: string;
}

/** GET /sites item. */
export interface ApiSite {
  id: string;
  name: string;
  program: string;
  group: 'Artemis III' | 'CLPS' | 'Commercial' | 'Other nations' | 'Apollo';
  status: string;
  lat: number;
  lon: number;
  region: 'South pole' | 'Near side' | 'Far side';
  coordsVerified?: boolean;
  precomputed?: boolean;
}

export type LayerId = 'illumination' | 'earth-visibility' | 'psr' | 'slope';

export interface LayerInfo {
  id: LayerId;
  name: string;
  source: string;
  /** null = backend does not serve this layer yet. */
  tileUrl: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; field?: string };
}
