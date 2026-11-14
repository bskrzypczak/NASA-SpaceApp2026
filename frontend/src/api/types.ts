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
