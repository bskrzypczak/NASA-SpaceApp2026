import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getSimulation } from '../api/client';
import type { SimulationResult } from '../api/types';
import { useApi } from '../hooks/useApi';
import { useSimulations } from '../store/simulations';
import { SITES } from '../data/sites';
import { formatLat, formatLon } from '../lib/coords';
import { DEFAULT_HARDWARE, DEFAULT_WEIGHTS } from '../lib/simModel';
import './MissionBriefPage.css';

/**
 * Screen 10 — Mission brief: one printable A4 page with everything a reviewer needs about one simulation.
 * "Print / Save as PDF" uses the browser's print dialog with print CSS (no backend PDF needed).
 */
export function MissionBriefPage() {
  const { id = '' } = useParams();
  const cached = useSimulations((s) => s.results[id]);
  const put = useSimulations((s) => s.put);
  const fetched = useApi((signal) => (cached ? Promise.resolve(cached) : getSimulation(id, signal)), [id]);
  const r = cached ?? fetched.data ?? null;

  useEffect(() => {
    if (fetched.data && !cached) put(fetched.data);
  }, [fetched.data, cached, put]);

  useEffect(() => {
    if (r) document.title = `Mission brief · ${siteName(r)} · HORIZON`;
    return () => {
      document.title = 'HORIZON';
    };
  }, [r]);

  if (!r) {
    return (
      <main className="page brief-page">
        {fetched.loading ? (
          <p className="muted">Loading simulation…</p>
        ) : (
          <div className="panel">
            <h1 style={{ marginTop: 0 }}>Simulation not found</h1>
            <p className="muted">The backend keeps results in memory only. Run the simulation again, then open the brief.</p>
            <Link to="/simulation/new" className="btn btn--primary">
              Run again
            </Link>
          </div>
        )}
      </main>
    );
  }

  return (
    <main className="page brief-page">
      <div className="brief-actions no-print">
        <Link to={`/simulation/${encodeURIComponent(r.id)}`} className="btn">
          ← Back to simulation
        </Link>
        <button type="button" className="btn btn--primary" onClick={() => window.print()}>
          ⎙ Print / Save as PDF
        </button>
      </div>
      <Brief r={r} />
    </main>
  );
}

function siteName(r: SimulationResult) {
  return r.site.name ?? SITES.find((s) => Math.abs(s.lat - r.site.lat) < 1e-6 && Math.abs(s.lon - r.site.lon) < 1e-6)?.name ?? 'Custom landing site';
}

const fmtTime = (iso?: string) => (iso ? iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$|Z$/, '') + ' UTC' : '—');
const fmtDay = (d: number | null) => (d == null ? 'not in window' : `day ${d.toFixed(1)}`);

const FACTOR_LABEL: Record<string, string> = {
  minSocPct: 'Power — lowest battery (%)',
  earthVisiblePct: 'Comms — Earth in view (%)',
  longestNightH: 'Night — longest darkness (h)',
};

interface Check {
  ok: boolean;
  title: string;
  detail: string;
}

/** Plain-language checks derived from the summary (same thresholds as the score factors). */
function checks(r: SimulationResult): Check[] {
  const s = r.summary;
  const hw = { ...DEFAULT_HARDWARE, ...r.input.hardware };
  const missionDays = r.input.missionDays ?? 14;
  const enduranceH = (hw.batteryWh * (1 - hw.reservePct / 100)) / hw.nightLoadW;
  return [
    {
      ok: s.minSocPct > hw.reservePct,
      title: 'Battery stays above reserve',
      detail: `Lowest charge ${s.minSocPct.toFixed(0)} % on day ${s.minSocAtDay.toFixed(1)} (reserve ${hw.reservePct} %).`,
    },
    {
      ok: s.longestNightH <= enduranceH,
      title: 'Longest darkness is survivable',
      detail: `Longest night ${s.longestNightH.toFixed(0)} h vs ~${enduranceH.toFixed(0)} h on battery at ${hw.nightLoadW} W.`,
    },
    {
      ok: s.earthVisiblePct >= 50,
      title: 'Direct link to Earth most of the time',
      detail: `Earth in view ${s.earthVisiblePct.toFixed(0)} % of the mission; longest gap ${s.longestCommsGapH.toFixed(0)} h.`,
    },
    sunlightAtLanding(r, missionDays),
  ];
}

/** Is the Sun up at touchdown, and for how long? (Landing in darkness means running on battery at once.) */
function sunlightAtLanding(r: SimulationResult, missionDays: number): Check {
  const s = r.summary;
  const litAtStart = r.timeseries ? r.timeseries.sunVisibleFrac[0] > 0 : r.windows.sun.some((w) => w.fromDay <= 0.01);
  if (!litAtStart) {
    const sunrise = r.events.find((e) => e.type === 'SUNRISE');
    return {
      ok: false,
      title: 'Sunlight at touchdown',
      detail: `Landing in shadow — ${sunrise ? `first sunrise on day ${sunrise.day.toFixed(1)}` : 'no sunrise in the window'}.`,
    };
  }
  return {
    ok: s.firstSunsetDay == null || s.firstSunsetDay >= Math.min(2, missionDays),
    title: 'Sunlight at touchdown',
    detail: s.firstSunsetDay == null ? 'Sun up at landing and no sunset in the window.' : `Sun up at landing; first sunset on day ${s.firstSunsetDay.toFixed(1)}.`,
  };
}

function Brief({ r }: { r: SimulationResult }) {
  const s = r.summary;
  const hw = { ...DEFAULT_HARDWARE, ...r.input.hardware };
  const w = { ...DEFAULT_WEIGHTS, ...r.input.weights };
  const missionDays = r.input.missionDays ?? 14;
  const windowDays = r.input.windowDays ?? 30;
  const flat = r.input.horizonModel === 'flat';
  const events = r.events.filter((e) => e.day <= missionDays && e.type !== 'MISSION_END').slice(0, 10);
  const verdictClass = s.verdict === 'LIKELY' ? 'is-good' : s.verdict === 'POSSIBLE' ? 'is-fair' : 'is-risky';
  const verdictIcon = s.verdict === 'LIKELY' ? '✓' : s.verdict === 'POSSIBLE' ? '!' : '▼';

  return (
    <article className="brief" aria-label="Mission brief">
      <header className="brief__head">
        <div>
          <div className="brief__brand">HORIZON · Mission brief</div>
          <h1 className="brief__title">{siteName(r)}</h1>
          <div className="brief__coords">
            {formatLat(r.site.lat, 3)} · {formatLon(r.site.lon, 3)}
            {r.site.elevationM != null && ` · ${Math.round(r.site.elevationM).toLocaleString('en-US')} m`}
          </div>
        </div>
        <div className={`brief__score ${verdictClass}`}>
          <span className="brief__pct">{s.successPct}%</span>
          <span className="brief__verdict">
            {verdictIcon} {s.verdict}
          </span>
          <span className="brief__small">mission success estimate</span>
        </div>
      </header>

      <section className="brief__grid">
        <div>
          <h2>Mission</h2>
          <dl className="brief__dl">
            <dt>Landing</dt>
            <dd>{fmtTime(r.input.landingTime)}</dd>
            <dt>Surface mission</dt>
            <dd>{missionDays} days</dd>
            <dt>Terrain</dt>
            <dd>{flat ? 'flat horizon (comparison run)' : 'real terrain horizon, LRO LOLA DEM'}</dd>
            {s.flatHorizonSuccessPct != null && !flat && (
              <>
                <dt>Flat-horizon estimate</dt>
                <dd>
                  {s.flatHorizonSuccessPct}% ({s.successPct - s.flatHorizonSuccessPct >= 0 ? '+' : ''}
                  {s.successPct - s.flatHorizonSuccessPct} pts from terrain)
                </dd>
              </>
            )}
          </dl>
        </div>
        <div>
          <h2>Hardware assumed</h2>
          <dl className="brief__dl">
            <dt>Battery</dt>
            <dd>
              {(hw.batteryWh / 1000).toFixed(1)} kWh, reserve {hw.reservePct} %
            </dd>
            <dt>Solar</dt>
            <dd>
              {hw.solarW} W panel at {hw.panelHeightM} m
            </dd>
            <dt>Loads</dt>
            <dd>
              {hw.dayLoadW} W day · {hw.nightLoadW} W night
            </dd>
            <dt>Antenna</dt>
            <dd>{hw.mastHeightM} m mast</dd>
          </dl>
        </div>
      </section>

      <section>
        <h2>Key numbers (mission days 0–{missionDays})</h2>
        <div className="brief__kpis">
          <Kpi label="☀ In sunlight" value={`${s.sunlitPct.toFixed(0)} %`} />
          <Kpi label="◉ Earth in view" value={`${s.earthVisiblePct.toFixed(0)} %`} />
          <Kpi label="Both at once" value={`${s.bothPct.toFixed(0)} %`} />
          <Kpi label="Lowest battery" value={`${s.minSocPct.toFixed(0)} %`} sub={`day ${s.minSocAtDay.toFixed(1)}`} />
          <Kpi label="Longest night" value={`${s.longestNightH.toFixed(0)} h`} />
          <Kpi label="Longest comms gap" value={`${s.longestCommsGapH.toFixed(0)} h`} />
        </div>
      </section>

      <section>
        <h2>Visibility & battery over the {windowDays}-day window</h2>
        <BriefTimeline r={r} />
      </section>

      <section className="brief__grid">
        <div>
          <h2>Readiness checks</h2>
          <ul className="brief__checks">
            {checks(r).map((c) => (
              <li key={c.title} className={c.ok ? 'is-ok' : 'is-bad'}>
                <span className="brief__mark" aria-hidden="true">
                  {c.ok ? '✓' : '!'}
                </span>
                <span>
                  <strong>{c.title}</strong>
                  <span className="sr-only">{c.ok ? ' — passed' : ' — needs attention'}</span>
                  <br />
                  <span className="brief__small">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2>Score breakdown</h2>
          <table className="brief__table">
            <thead>
              <tr>
                <th scope="col">Factor</th>
                <th scope="col">Value</th>
                <th scope="col">Weight</th>
                <th scope="col">Points</th>
              </tr>
            </thead>
            <tbody>
              {r.factors.map((f) => (
                <tr key={f.key}>
                  <td>
                    {f.ok ? '✓' : '!'} {FACTOR_LABEL[f.metric] ?? f.metric}
                  </td>
                  <td>{f.value.toFixed(1)}</td>
                  <td>{f.weight}</td>
                  <td>{f.points.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="brief__small">
            Score = {w.power} · power + {w.comms} · comms + {w.night} · night. LIKELY ≥ 80, POSSIBLE ≥ 60.
          </p>
        </div>
      </section>

      {events.length > 0 && (
        <section>
          <h2>Events during the mission</h2>
          <table className="brief__table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Time</th>
                <th scope="col">Day</th>
                <th scope="col">Azimuth</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td>{e.type.charAt(0) + e.type.slice(1).toLowerCase().replace('_', ' ')}</td>
                  <td>{fmtTime(e.time)}</td>
                  <td>{e.day.toFixed(2)}</td>
                  <td>{e.azDeg != null ? `${e.azDeg.toFixed(0)}°` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="brief__foot">
        <div>
          <strong>Sources</strong> · Sun & Earth positions: JPL Horizons (DE441) · Terrain horizon: LRO LOLA DEM via NASA Moon Trek · Shadow & visibility maps: NASA GSFC PGDA.
        </div>
        <div>
          First sunset {fmtDay(s.firstSunsetDay)} · first Earthset {fmtDay(s.firstEarthsetDay)} · Simulation {r.id} · generated {new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC
          {r.mock && ' · MOCK DATA'}
        </div>
      </footer>
    </article>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="brief__kpi">
      <span className="brief__small">{label}</span>
      <strong>{value}</strong>
      {sub && <span className="brief__small">{sub}</span>}
    </div>
  );
}

/** Static strip for paper: Sun / Earth visibility bars and the battery line, mission end marked. */
function BriefTimeline({ r }: { r: SimulationResult }) {
  const W = 700;
  const H = 150;
  const L = 78;
  const R = 26;
  const windowDays = r.input.windowDays ?? 30;
  const missionDays = r.input.missionDays ?? 14;
  const reserve = r.input.hardware?.reservePct ?? DEFAULT_HARDWARE.reservePct;
  const x = (d: number) => L + (d / windowDays) * (W - L - R);
  const ts = r.timeseries;
  const batTop = 60;
  const batH = 64;
  const yB = (v: number) => batTop + (1 - v / 100) * batH;
  let path = '';
  if (ts) {
    const stride = Math.max(1, Math.floor(ts.day.length / 700));
    for (let i = 0; i < ts.day.length; i += stride) path += `${path ? 'L' : 'M'}${x(ts.day[i]).toFixed(1)},${yB(ts.socPct[i]).toFixed(1)}`;
  }
  const ticks: number[] = [];
  for (let d = 0; d <= windowDays; d += 5) ticks.push(d);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="brief__timeline" role="img" aria-label="Sun and Earth visibility windows and battery charge over the simulation window">
      <text x={0} y={16} className="brief__svgtext">
        ☀ Sunlit
      </text>
      <rect x={L} y={6} width={W - L - R} height={14} className="brief__track" />
      {r.windows.sun.map((w, i) => (
        <rect key={i} x={x(w.fromDay)} y={6} width={Math.max(1, x(w.toDay) - x(w.fromDay))} height={14} className="brief__sun" />
      ))}
      <text x={0} y={42} className="brief__svgtext">
        ◉ Earth
      </text>
      <rect x={L} y={32} width={W - L - R} height={14} className="brief__track" />
      {r.windows.earth.map((w, i) => (
        <rect key={i} x={x(w.fromDay)} y={32} width={Math.max(1, x(w.toDay) - x(w.fromDay))} height={14} className="brief__earth" />
      ))}
      <text x={0} y={batTop + 10} className="brief__svgtext">
        Battery
      </text>
      <text x={L - 6} y={batTop + 4} className="brief__svgtick" textAnchor="end">
        100%
      </text>
      <text x={L - 6} y={batTop + batH} className="brief__svgtick" textAnchor="end">
        0%
      </text>
      <line x1={L} x2={W - R} y1={yB(reserve)} y2={yB(reserve)} className="brief__reserve" />
      <text x={L + 4} y={yB(reserve) - 4} className="brief__svgtick">
        reserve {reserve}%
      </text>
      {path && <path d={path} className="brief__soc" />}
      <line x1={x(missionDays)} x2={x(missionDays)} y1={2} y2={batTop + batH} className="brief__end" />
      <text x={x(missionDays) + 4} y={batTop - 3} className="brief__svgtick">
        mission end (day {missionDays})
      </text>
      {ticks.map((d) => (
        <text key={d} x={x(d)} y={H - 4} className="brief__svgtick" textAnchor="middle">
          day {d}
        </text>
      ))}
    </svg>
  );
}
