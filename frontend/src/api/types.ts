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
  /** false = slope or PSR could not be fetched this time (NASA service slow); retrying may fill them in. */
  complete?: boolean;
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
  demResolutionM?: number;
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
  /** true = GET /layers/{id}/grid works for this layer. Missing → frontend default (slope, psr). */
  grid?: boolean;
}

/** GET /layers/{id}/grid — same grid layout as /terrain/heightmap for the same lat/lon/sizeKm/res. */
export interface LayerGrid {
  layerId: LayerId;
  lat: number;
  lon: number;
  sizeKm: number;
  res: number;
  /** continuous = values in `unit` (slope °), mask = 1 inside / 0 outside (PSR). */
  kind: 'continuous' | 'mask';
  unit: string | null;
  min: number | null;
  max: number | null;
  /** values[row][col], row 0 = north edge, col 0 = west edge; null = NoData. */
  values: (number | null)[][];
  northUp: boolean;
  source: string;
  version: string;
  mock?: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string; field?: string };
}

/* ---------- Horizon & simulation (backend §4.4, §4.6) ---------- */

export interface HorizonProfile {
  lat: number;
  lon: number;
  heightM: number;
  binDeg: number;
  maxDistanceKm: number;
  /** 0 … 360−binDeg, one value per bin */
  azimuthDeg: number[];
  /** terrain elevation angle per azimuth bin, degrees above the flat horizon */
  elevationDeg: number[];
  /** Distance (km) of the ridge that sets the horizon in each bin. Older backends: missing. */
  distanceKm?: number[];
  /** DEM height at the site (m, vs 1737.4 km), without heightM. */
  observerElevationM?: number;
  features: { name: string; azFromDeg: number; azToDeg: number; maxElevationDeg: number }[];
  demVersion: string;
  demResolutionM?: number;
  mock?: boolean;
}

export type HorizonModel = 'real' | 'flat';

export interface Hardware {
  batteryWh: number;
  solarW: number;
  dayLoadW: number;
  nightLoadW: number;
  reservePct: number;
  panelHeightM: number;
  mastHeightM: number;
}

export interface ScoreWeights {
  power: number;
  comms: number;
  night: number;
}

export interface SimulationRequest {
  site: { siteId: string } | { lat: number; lon: number };
  /** ISO 8601 with offset, e.g. 2027-03-14T06:00:00Z */
  landingTime: string;
  missionDays: number;
  windowDays: number;
  stepMin: number;
  horizonModel: HorizonModel;
  hardware?: Partial<Hardware>;
  weights?: Partial<ScoreWeights>;
  includeTimeseries?: boolean;
}

export interface DayWindow {
  fromDay: number;
  toDay: number;
}

export type SimEventType = 'SUNRISE' | 'SUNSET' | 'EARTHRISE' | 'EARTHSET' | 'BATTERY_LOW' | 'MISSION_END';

export interface SimEvent {
  type: SimEventType;
  time: string;
  day: number;
  azDeg?: number;
  elDeg?: number;
}

export interface ScoreFactor {
  key: 'power' | 'comms' | 'night';
  metric: string;
  value: number;
  score: number;
  weight: number;
  points: number;
  ok: boolean;
}

export type Verdict = 'LIKELY' | 'POSSIBLE' | 'RISKY';

export interface SimSummary {
  successPct: number;
  verdict: Verdict;
  flatHorizonSuccessPct?: number;
  sunlitPct: number;
  earthVisiblePct: number;
  bothPct: number;
  minSocPct: number;
  minSocAtDay: number;
  longestNightH: number;
  longestCommsGapH: number;
  firstSunsetDay: number | null;
  firstEarthsetDay: number | null;
}

export interface SimTimeseries {
  stepMin: number;
  day: number[];
  sunAzDeg: number[];
  sunElDeg: number[];
  sunMaskElDeg: number[];
  sunVisibleFrac: number[];
  earthAzDeg: number[];
  earthElDeg: number[];
  earthMaskElDeg: number[];
  earthVisible: boolean[];
  socPct: number[];
}

export interface SimulationResult {
  id: string;
  createdAt: string;
  /** Echo of the request with defaults filled in. */
  input: Partial<SimulationRequest> & { hardware?: Hardware; weights?: ScoreWeights };
  site: { name?: string; lat: number; lon: number; elevationM?: number | null };
  summary: SimSummary;
  factors: ScoreFactor[];
  events: SimEvent[];
  windows: { sun: DayWindow[]; earth: DayWindow[]; both: DayWindow[] };
  timeseries?: SimTimeseries;
  mock?: boolean;
}

/* ---------- Calendar (backend §4.8) ---------- */

export interface CalendarRequest {
  site: { siteId: string } | { lat: number; lon: number };
  /** YYYY-MM-DD */
  from: string;
  to: string;
  /** "HH:MM:SSZ" */
  landingTimeOfDay: string;
  missionDays: number;
  horizonModel: HorizonModel;
  hardware?: Partial<Hardware>;
}

export interface CalendarDay {
  date: string;
  successPct: number;
  minSocPct: number;
  earthVisiblePct: number;
  longestNightH: number;
}

export interface CalendarMonth {
  /** YYYY-MM */
  month: string;
  goodDays: number;
  bestPct: number;
  season?: string;
}

export interface CalendarResult {
  days: CalendarDay[];
  best: { date: string; successPct: number };
  months: CalendarMonth[];
  mock?: boolean;
}

/* ---------- Scenario comparison (backend §4.9) ---------- */

export type ScenarioSpec = Omit<SimulationRequest, 'includeTimeseries'> & { label: string; includeTimeseries?: false };

export interface ScenarioRequirements {
  minSocPct: number;
  minEarthVisiblePct: number;
}

export interface ScenarioCompareRequest {
  scenarios: ScenarioSpec[];
  requirements: ScenarioRequirements;
}

export interface ScenarioResult {
  label: string;
  simulationId: string;
  summary: SimSummary;
  windows: { sun: DayWindow[]; earth: DayWindow[]; both: DayWindow[] };
  meetsRequirements: boolean;
}

export interface ScenarioCompareResponse {
  results: ScenarioResult[];
  recommendation: { label: string; reason: string } | null;
  mock?: boolean;
}

/* ---------- Nearby sensitivity map (backend §4.10) ---------- */

export type NearbyGoal = 'balanced' | 'power' | 'comms';

export interface NearbyRequest {
  center: { lat: number; lon: number };
  radiusKm: number;
  landingTime: string;
  missionDays: number;
  goal: NearbyGoal;
  maxSlopeDeg: number;
  top: number;
}

export interface NearbySuggestion {
  rank: string;
  lat: number;
  lon: number;
  distanceKm: number;
  successPct: number;
  why: string[];
}

export interface NearbyResponse {
  grid: {
    originLat: number;
    originLon: number;
    /** Real spacing between samples (= radiusKm × 1000 for the 3×3 grid). */
    cellM: number;
    cols: number;
    rows: number;
    /** row 0 = north. null = not simulated (unsafe or not sampled). */
    successPct: (number | null)[][];
    /** true = unsafe (slope / PSR / no data) — or a corner the backend does not sample. */
    excluded: boolean[][];
  };
  center: { successPct: number };
  suggestions: NearbySuggestion[];
  mock?: boolean;
}

/* ---------- Validation vs PGDA (backend /validation) & data sources (/meta/sources) ---------- */

export interface ValidationResult {
  avgIlluminationPct: { horizon: number; pgda: number | null; lrocWac: null };
  earthVisibilityPct: { horizon: number; pgda: number | null };
  deltaMaxPts: number | null;
  withinTolerance: boolean | null;
  tolerancePts: number;
  periodStart: string;
  periodEnd: string;
  periodDays: number;
  samplingStepHours: number;
  heightM: number;
  lrocWacNote: string;
  horizonDemVersion: string;
  horizonDemResolutionM: number;
  pgdaVersion: { illumination: string; earthVisibility: string };
  mock?: boolean;
}

export interface SourcesMeta {
  ephemeris: { name: string; version: string; model: string; url: string };
  terrain: { name: string; southPoleNorthPoleResolutionM: number; globalResolutionPxPerDegree: number; note?: string; url: string };
  permanentShadow: { name: string; resolutionM: number; coverage: string; url: string };
  lunarPolarVisibility: { name: string; source: string; averagingPeriodYears: number; coverage: string; resolutionM: number[]; url: string };
  validationRefs: string[];
}
