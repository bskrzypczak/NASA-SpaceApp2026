import { useState } from 'react';
import { ApiError, getSources, getValidation } from '../../api/client';
import type { SimEvent, SimulationResult, ValidationResult } from '../../api/types';
import { useApi } from '../../hooks/useApi';
import { landerName } from '../../lib/landers';
import { DEFAULT_HARDWARE, DEFAULT_WEIGHTS, EARTH_ANGULAR_RADIUS_DEG, SUN_ANGULAR_RADIUS_DEG } from '../../lib/simModel';
import { TimeChart } from './TimeChart';
import { LanderEditor } from './LanderEditor';
import type { Hardware } from '../../api/types';
import './pro.css';

export type ProTab = 'charts' | 'events' | 'lander' | 'validation' | 'data';
type Tab = ProTab;

const SUN = '#EAFE07';
const EARTH = '#2E96F5';
const TERRAIN = '#8a93a8';
const BATTERY = '#c9d6f0';
const DANGER = '#FF7A4D';

const EVENT_LABEL: Record<SimEvent['type'], { icon: string; label: string }> = {
  SUNRISE: { icon: '☀↑', label: 'Sunrise' },
  SUNSET: { icon: '☀↓', label: 'Sunset' },
  EARTHRISE: { icon: '◉↑', label: 'Earthrise' },
  EARTHSET: { icon: '◉↓', label: 'Earthset' },
  BATTERY_LOW: { icon: '!', label: 'Battery at reserve' },
  MISSION_END: { icon: '■', label: 'Mission end' },
};

/**
 * Pro mode: the numbers behind the 3D scene — elevation vs terrain mask, battery, every event,
 * an independent check against NASA PGDA, and the raw data to export.
 */
export function ProPanel({
  result,
  t,
  onT,
  tab: tabProp,
  onTab,
  onRunLander,
  landerRunning = false,
  landerError = null,
}: {
  result: SimulationResult;
  t: number;
  onT: (t: number) => void;
  /** Controlled tab (optional) — lets the page open the Lander tab. */
  tab?: Tab;
  onTab?: (t: Tab) => void;
  onRunLander: (hw: Hardware) => void;
  landerRunning?: boolean;
  landerError?: Error | null;
}) {
  const [ownTab, setOwnTab] = useState<Tab>('charts');
  const tab = tabProp ?? ownTab;
  const setTab = onTab ?? setOwnTab;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'charts', label: 'Charts' },
    { id: 'events', label: `Events (${result.events.length})` },
    { id: 'lander', label: 'Lander' },
    { id: 'validation', label: 'Validation vs PGDA' },
    { id: 'data', label: 'Data & export' },
  ];
  return (
    <section className="pro panel" aria-label="Pro mode">
      <div className="pro__head">
        <span className="eyebrow">Pro mode</span>
        <div role="tablist" aria-label="Pro mode sections" className="segmented">
          {tabs.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} aria-pressed={tab === x.id} onClick={() => setTab(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'charts' && <Charts result={result} t={t} onT={onT} />}
      {tab === 'events' && <Events result={result} t={t} onT={onT} />}
      {tab === 'lander' && <LanderEditor result={result} onRun={onRunLander} running={landerRunning} error={landerError} />}
      {tab === 'validation' && <Validation result={result} />}
      {tab === 'data' && <DataExport result={result} />}
    </section>
  );
}

/* ---------- Charts ---------- */

function Charts({ result, t, onT }: { result: SimulationResult; t: number; onT: (t: number) => void }) {
  const ts = result.timeseries;
  if (!ts) return <p className="muted">This result has no time series.</p>;
  const windowDays = result.input.windowDays ?? 30;
  const missionDays = result.input.missionDays ?? 14;
  const reservePct = result.input.hardware?.reservePct ?? DEFAULT_HARDWARE.reservePct;
  const flat = result.input.horizonModel === 'flat';
  const common = { days: ts.day, missionDays, windowDays, t, onT };
  const deg = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}°`;
  return (
    <div className="pro__charts">
      <TimeChart
        {...common}
        title="Sun elevation vs terrain horizon"
        yUnit="°"
        series={[
          { name: flat ? 'Flat horizon (0°)' : 'Terrain at Sun azimuth', color: TERRAIN, values: ts.sunMaskElDeg, kind: 'area', format: deg },
          { name: 'Sun centre', color: SUN, values: ts.sunElDeg, kind: 'line', format: deg },
        ]}
        bands={{ windows: result.windows.sun, color: SUN, label: 'Sunlit' }}
      />
      <TimeChart
        {...common}
        title="Earth elevation vs terrain horizon"
        yUnit="°"
        series={[
          { name: flat ? 'Flat horizon (0°)' : 'Terrain at Earth azimuth', color: TERRAIN, values: ts.earthMaskElDeg, kind: 'area', format: deg },
          { name: 'Earth centre', color: EARTH, values: ts.earthElDeg, kind: 'line', format: deg },
        ]}
        bands={{ windows: result.windows.earth, color: EARTH, label: 'Earth in view' }}
      />
      <TimeChart
        {...common}
        title="Battery state of charge"
        yUnit="%"
        yMin={0}
        yMax={100}
        series={[{ name: 'Battery', color: BATTERY, values: ts.socPct, kind: 'line', format: (v) => `${v.toFixed(1)} %` }]}
        refLines={[{ y: reservePct, label: `reserve ${reservePct} %`, color: DANGER }]}
      />
      <p className="muted pro__note">
        A body counts as visible when its disc clears the terrain line (Sun radius {SUN_ANGULAR_RADIUS_DEG}°, Earth {EARTH_ANGULAR_RADIUS_DEG}°). Shaded spans = backend
        visibility windows. Click a chart to move the simulation clock.
      </p>
    </div>
  );
}

/* ---------- Events ---------- */

function Events({ result, t, onT }: { result: SimulationResult; t: number; onT: (t: number) => void }) {
  const missionDays = result.input.missionDays ?? 14;
  if (!result.events.length) return <p className="muted">No rise/set events in the window — the Sun and Earth stay as they are.</p>;
  return (
    <div className="table-wrap">
      <table className="pro__table">
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">Time (UTC)</th>
            <th scope="col">Day</th>
            <th scope="col">Az</th>
            <th scope="col">El</th>
            <th scope="col">
              <span className="sr-only">Jump</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {result.events.map((e, i) => {
            const meta = EVENT_LABEL[e.type];
            const after = e.day > missionDays;
            const now = Math.abs(e.day - t) < 0.05;
            return (
              <tr key={i} className={`${after ? 'is-after' : ''}${now ? ' is-now' : ''}`}>
                <td>
                  <span aria-hidden="true" className="pro__icon">
                    {meta.icon}
                  </span>{' '}
                  {meta.label}
                  {after && <span className="muted"> · after mission</span>}
                </td>
                <td className="mono">{e.time.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, 'Z')}</td>
                <td className="mono">{e.day.toFixed(2)}</td>
                <td className="mono">{e.azDeg != null ? `${e.azDeg.toFixed(1)}°` : '—'}</td>
                <td className="mono">{e.elDeg != null ? `${e.elDeg.toFixed(2)}°` : '—'}</td>
                <td>
                  <button type="button" className="btn btn--sm" onClick={() => onT(Math.max(0, e.day))}>
                    Go →
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Validation ---------- */

function Validation({ result }: { result: SimulationResult }) {
  const { lat, lon } = result.site;
  const [state, setState] = useState<{ loading: boolean; data: ValidationResult | null; error: Error | null }>({ loading: false, data: null, error: null });
  const covered = Math.abs(lat) >= 65;

  function run() {
    setState({ loading: true, data: null, error: null });
    getValidation(lat, lon)
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error: Error) => setState({ loading: false, data: null, error }));
  }

  if (!covered) {
    return (
      <p className="muted">
        PGDA polar illumination maps cover 65–90° N/S only, so this site ({lat.toFixed(2)}°) cannot be checked against them.
      </p>
    );
  }
  const d = state.data;
  const row = (label: string, ours: number, theirs: number | null, tol: number) => {
    const delta = theirs == null ? null : ours - theirs;
    const ok = delta == null ? null : Math.abs(delta) <= tol;
    return (
      <tr>
        <th scope="row">{label}</th>
        <td className="mono">{ours.toFixed(1)} %</td>
        <td className="mono">{theirs == null ? 'n/a' : `${theirs.toFixed(1)} %`}</td>
        <td className="mono">{delta == null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts`}</td>
        <td>{ok == null ? '—' : ok ? <span className="pro__ok">✓ within ±{tol}</span> : <span className="pro__bad">✕ off by more than {tol}</span>}</td>
      </tr>
    );
  };

  return (
    <div className="pro__validation">
      <p className="muted" style={{ margin: 0 }}>
        Independent check: HORIZON's own model (JPL Horizons + LOLA horizon, one year, hourly) against NASA GSFC PGDA long-term averages (18.6 years) for this exact point.
      </p>
      {!d && (
        <button type="button" className="btn btn--primary" onClick={run} disabled={state.loading}>
          {state.loading ? 'Comparing… (first run can take a minute)' : '▶ Run validation'}
        </button>
      )}
      {state.error && (
        <p className="error" role="status">
          ! {state.error.message}
          {state.error instanceof ApiError && state.error.code === 'OUT_OF_PGDA_COVERAGE' ? '' : ' '}
        </p>
      )}
      {d && (
        <>
          <div className={`pro__verdict ${d.withinTolerance ? 'is-ok' : d.withinTolerance === false ? 'is-bad' : ''}`}>
            {d.withinTolerance ? '✓ Model agrees with NASA PGDA' : d.withinTolerance === false ? '! Model differs from NASA PGDA' : '— PGDA has no value here'}
            {d.deltaMaxPts != null && <span className="mono"> · max difference {d.deltaMaxPts.toFixed(1)} pts (tolerance ±{d.tolerancePts})</span>}
            {d.mock && <span className="badge badge--warn">MOCK</span>}
          </div>
          <div className="table-wrap">
            <table className="pro__table">
              <thead>
                <tr>
                  <th scope="col">Long-term average</th>
                  <th scope="col">HORIZON</th>
                  <th scope="col">NASA PGDA</th>
                  <th scope="col">Difference</th>
                  <th scope="col">Check</th>
                </tr>
              </thead>
              <tbody>
                {row('☀ Time in sunlight', d.avgIlluminationPct.horizon, d.avgIlluminationPct.pgda, d.tolerancePts)}
                {row('◉ Time with Earth in view', d.earthVisibilityPct.horizon, d.earthVisibilityPct.pgda, d.tolerancePts)}
                <tr>
                  <th scope="row">LROC WAC imagery</th>
                  <td colSpan={4} className="muted">
                    not available — {d.lrocWacNote}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted pro__note">
            HORIZON period {d.periodStart} → {d.periodEnd} ({d.periodDays} days, every {d.samplingStepHours} h), observer {d.heightM} m above ground, DEM {d.horizonDemVersion} (
            {d.horizonDemResolutionM} m/px). PGDA averages over 18.6 years, so a few points of difference are expected.
          </p>
        </>
      )}
    </div>
  );
}

/* ---------- Data & export ---------- */

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function timeseriesCsv(r: SimulationResult): string {
  const ts = r.timeseries;
  if (!ts) return '';
  const head = 'day,sun_az_deg,sun_el_deg,sun_mask_el_deg,sun_visible_frac,earth_az_deg,earth_el_deg,earth_mask_el_deg,earth_visible,soc_pct';
  const rows = ts.day.map((d, i) =>
    [d, ts.sunAzDeg[i], ts.sunElDeg[i], ts.sunMaskElDeg[i], ts.sunVisibleFrac[i], ts.earthAzDeg[i], ts.earthElDeg[i], ts.earthMaskElDeg[i], ts.earthVisible[i] ? 1 : 0, ts.socPct[i]].join(','),
  );
  return [head, ...rows].join('\n');
}

function DataExport({ result }: { result: SimulationResult }) {
  const sources = useApi((signal) => getSources(signal), []);
  const [copied, setCopied] = useState(false);
  const hw = { ...DEFAULT_HARDWARE, ...result.input.hardware };
  const w = { ...DEFAULT_WEIGHTS, ...result.input.weights };
  const base = `horizon-${result.id}`;
  const s = sources.data;
  return (
    <div className="pro__data">
      <div className="pro__exports">
        <button type="button" className="btn" onClick={() => download(`${base}.json`, JSON.stringify(result, null, 2), 'application/json')}>
          ⤓ Full result (JSON)
        </button>
        <button type="button" className="btn" disabled={!result.timeseries} onClick={() => download(`${base}-timeseries.csv`, timeseriesCsv(result), 'text/csv')}>
          ⤓ Time series (CSV)
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void navigator.clipboard?.writeText(window.location.href.split('?')[0]).then(() => setCopied(true));
          }}
        >
          {copied ? '✓ Link copied' : '⧉ Copy link'}
        </button>
      </div>

      <div className="pro__cols">
        <div>
          <h3 className="pro__h">Model assumptions</h3>
          <dl className="details">
            {(
              [
                ['Lander', landerName(hw)],
                ['Battery', `${hw.batteryWh} Wh, reserve ${hw.reservePct} %`],
                ['Solar panel', `${hw.solarW} W at ${hw.panelHeightM} m`],
                ['Loads', `${hw.dayLoadW} W day / ${hw.nightLoadW} W night`],
                ['Antenna mast', `${hw.mastHeightM} m`],
                ['Score weights', `power ${w.power} · comms ${w.comms} · night ${w.night}`],
                ['Sampling', `every ${result.input.stepMin ?? 10} min, ${result.input.windowDays ?? 30} days`],
                ['Horizon model', result.input.horizonModel === 'flat' ? 'flat (0°)' : 'real terrain, LOLA DEM'],
                ['Result id', result.id],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h3 className="pro__h">Data sources</h3>
          {sources.loading && <p className="muted">Loading…</p>}
          {s && (
            <ul className="pro__sources">
              <li>
                <a href={s.ephemeris.url} target="_blank" rel="noreferrer">
                  {s.ephemeris.name}
                </a>{' '}
                <span className="muted">— {s.ephemeris.model}, Sun & Earth positions</span>
              </li>
              <li>
                <a href={s.terrain.url} target="_blank" rel="noreferrer">
                  {s.terrain.name}
                </a>{' '}
                <span className="muted">
                  — {s.terrain.southPoleNorthPoleResolutionM} m/px poles, {s.terrain.globalResolutionPxPerDegree} px/° global
                </span>
              </li>
              <li>
                <a href={s.permanentShadow.url} target="_blank" rel="noreferrer">
                  {s.permanentShadow.name}
                </a>{' '}
                <span className="muted">
                  — {s.permanentShadow.resolutionM} m/px, {s.permanentShadow.coverage}
                </span>
              </li>
              <li>
                <a href={s.lunarPolarVisibility.url} target="_blank" rel="noreferrer">
                  {s.lunarPolarVisibility.name}
                </a>{' '}
                <span className="muted">
                  — {s.lunarPolarVisibility.source}, {s.lunarPolarVisibility.averagingPeriodYears}-year averages, {s.lunarPolarVisibility.coverage}
                </span>
              </li>
            </ul>
          )}
          {sources.error && <p className="error">! {sources.error.message}</p>}
        </div>
      </div>
    </div>
  );
}
