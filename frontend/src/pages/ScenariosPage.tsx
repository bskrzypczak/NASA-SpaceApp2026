import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, apiMode, compareScenarios } from '../api/client';
import type { DayWindow, ScenarioCompareRequest, ScenarioCompareResponse } from '../api/types';
import { MAX_SCENARIOS, shiftDays, useScenarios, type ScenarioDraft } from '../store/scenarios';
import { useSelection } from '../store/selection';
import { SITES } from '../data/sites';
import { defaultHorizonModel, siteRef } from '../lib/requests';
import { formatLat, formatLon } from '../lib/coords';
import './ScenariosPage.css';
import { StepLoader } from '../components/StepLoader';

const WINDOW_DAYS = 30;
const STEP_MIN = 10;
const RED = 'var(--danger-text)';

function toSpec(d: ScenarioDraft) {
  return {
    label: d.label,
    site: siteRef(d),
    landingTime: `${d.landingTime}:00Z`,
    missionDays: d.missionDays,
    windowDays: WINDOW_DAYS,
    stepMin: STEP_MIN,
    horizonModel: defaultHorizonModel(d.lat),
    includeTimeseries: false as const,
  };
}

const cache = new Map<string, Promise<ScenarioCompareResponse>>();
function runCompare(req: ScenarioCompareRequest) {
  const key = JSON.stringify(req);
  if (!cache.has(key)) {
    cache.set(
      key,
      compareScenarios(req).catch((e) => {
        cache.delete(key);
        throw e;
      }),
    );
  }
  return cache.get(key)!;
}

/** Screen 9 — 2–4 site × date scenarios side by side (POST /scenarios/compare). */
export function ScenariosPage() {
  const navigate = useNavigate();
  const sel = useSelection();
  const { items, requirements, add, remove, rename, setRequirements, clear } = useScenarios();
  const [result, setResult] = useState<ScenarioCompareResponse | null>(null);
  const [resultKey, setResultKey] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [catalogPick, setCatalogPick] = useState('');

  // Start with the current selection as the baseline.
  useEffect(() => {
    if (items.length === 0) {
      add({ label: 'Baseline', name: sel.name, lat: sel.lat, lon: sel.lon, landingTime: sel.landingTime, missionDays: sel.missionDays });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const request = useMemo<ScenarioCompareRequest>(() => {
    // Labels identify results on the backend — keep them unique.
    const seen = new Map<string, number>();
    const scenarios = items.map((d) => {
      const n = (seen.get(d.label) ?? 0) + 1;
      seen.set(d.label, n);
      return toSpec(n > 1 ? { ...d, label: `${d.label} (${n})` } : d);
    });
    return { scenarios, requirements };
  }, [items, requirements]);
  const key = JSON.stringify(request);
  const stale = !!result && resultKey !== key;
  const base = items[0];
  const full = items.length >= MAX_SCENARIOS;

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await runCompare(request);
      setResult(res);
      setResultKey(key);
    } catch (e) {
      setError(e as Error);
    } finally {
      setRunning(false);
    }
  }

  function addSlip(weeks: number) {
    if (!base) return;
    add({ label: `Slip +${weeks} wk`, name: base.name, lat: base.lat, lon: base.lon, landingTime: shiftDays(base.landingTime, weeks * 7), missionDays: base.missionDays });
  }

  function addCatalog(id: string) {
    const s = SITES.find((x) => x.id === id);
    if (!s || !base) return;
    add({ label: s.name, name: s.name, lat: s.lat, lon: s.lon, landingTime: base.landingTime, missionDays: base.missionDays });
    setCatalogPick('');
  }

  // Results come back in request order.
  const baseScore = result?.results[0]?.summary.successPct;
  const sentDrafts: ScenarioDraft[] = resultKey ? (JSON.parse(resultKey) as ScenarioCompareRequest).scenarios.map((sc, i) => ({ ...(items[i] ?? items[0]), label: sc.label, landingTime: sc.landingTime.slice(0, 16), missionDays: sc.missionDays })) : [];

  return (
    <main className="page scen-page">
      <div className="dates-head">
        <div>
          <span className="eyebrow">Scenario comparison · up to {MAX_SCENARIOS}</span>
          <h1 className="hero-title" style={{ fontSize: 36, marginTop: 6 }}>
            Slip the date or move the site?
          </h1>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Compare landing sites and dates side by side. The first scenario is the baseline.
          </p>
        </div>
        {(result?.mock || apiMode === 'mock') && <span className="badge badge--warn">MOCK DATA</span>}
      </div>

      {/* Builder */}
      <section className="panel scen-builder" aria-label="Scenarios to compare">
        <ol className="scen-list">
          {items.map((d, i) => (
            <li key={d.id} className="scen-item">
              <span className="mono" style={{ color: 'var(--accent)' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <label className="sr-only" htmlFor={`label-${d.id}`}>
                Scenario name
              </label>
              <input id={`label-${d.id}`} className="scen-item__label" value={d.label} maxLength={80} onChange={(e) => rename(d.id, e.target.value || `Scenario ${i + 1}`)} />
              <span className="scen-item__meta">
                <strong>{d.name ?? 'Custom point'}</strong>
                <span className="mono muted">
                  {formatLat(d.lat)} · {formatLon(d.lon)} · {d.landingTime.replace('T', ' ')} UTC · {d.missionDays} d
                </span>
              </span>
              {i === 0 ? (
                <span className="badge">baseline</span>
              ) : (
                <button type="button" className="icon-btn" aria-label={`Remove ${d.label}`} onClick={() => remove(d.id)}>
                  ✕
                </button>
              )}
            </li>
          ))}
        </ol>

        <div className="scen-bar">
          <span className="eyebrow scen-bar__label">Add</span>
          <div className="scen-bar__controls">
            {[1, 2, 4].map((w) => (
              <button key={w} type="button" className="btn scen-chip" disabled={full || !base} onClick={() => addSlip(w)}>
                Slip +{w} wk
              </button>
            ))}
            <label className="sr-only" htmlFor="catalog-pick">
              Add another site from the catalog
            </label>
            <select id="catalog-pick" className="scen-select" value={catalogPick} disabled={full || !base} onChange={(e) => addCatalog(e.target.value)}>
              <option value="">Other site, same date…</option>
              {SITES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.program})
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn scen-chip"
              disabled={full}
              onClick={() => add({ label: sel.name ?? 'Current pick', name: sel.name, lat: sel.lat, lon: sel.lon, landingTime: sel.landingTime, missionDays: sel.missionDays })}
            >
              Current selection
            </button>
          </div>
          <button type="button" className="btn scen-chip scen-bar__action" onClick={clear}>
            Reset
          </button>
        </div>

        <div className="scen-bar scen-bar--req">
          <span className="eyebrow scen-bar__label">Requirements</span>
          <div className="scen-bar__controls">
            <label className="scen-req__field">
              <span className="muted">Battery never below</span>
              <span className="scen-num">
                <input type="number" min={0} max={100} value={requirements.minSocPct} onChange={(e) => setRequirements({ minSocPct: clampPct(e.target.value) })} />
                <span aria-hidden="true">%</span>
              </span>
            </label>
            <label className="scen-req__field">
              <span className="muted">Earth in view at least</span>
              <span className="scen-num">
                <input type="number" min={0} max={100} value={requirements.minEarthVisiblePct} onChange={(e) => setRequirements({ minEarthVisiblePct: clampPct(e.target.value) })} />
                <span aria-hidden="true">%</span>
              </span>
            </label>
          </div>
          <button type="button" className="btn btn--primary btn--lg scen-bar__action" disabled={items.length < 2 || running} onClick={run}>
            {running ? 'Comparing…' : result && !stale ? '↻ Compare again' : '▶ Compare'}
          </button>
        </div>
        {items.length < 2 && <p className="muted" style={{ margin: 0 }}>Add at least one more scenario to compare.</p>}
      </section>

      {running && <RunningNote count={items.length} />}
      {error && (
        <div className="panel dates-error" role="alert">
          <strong>Comparison failed{error instanceof ApiError ? ` · ${error.code}` : ''}</strong>
          <span className="muted">{error.message}</span>
          <button type="button" className="btn btn--primary" onClick={run} style={{ alignSelf: 'flex-start' }}>
            Try again
          </button>
        </div>
      )}

      {result && (
        <>
          {stale && <p className="badge" role="note">Scenarios changed — press Compare to update the results below.</p>}

          <div className={`scen-reco${result.recommendation ? '' : ' is-none'}`} role="status">
            <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2 L14.8 8.6 L22 9.3 L16.5 14 L18.2 21 L12 17.3 L5.8 21 L7.5 14 L2 9.3 L9.2 8.6 Z" fill={result.recommendation ? '#EAFE07' : 'none'} stroke="#EAFE07" strokeWidth="1.5" />
            </svg>
            {result.recommendation ? (
              <span>
                <strong style={{ color: 'var(--accent)' }}>Recommendation: {result.recommendation.label}.</strong>{' '}
                <span className="muted">{result.recommendation.reason}</span>
              </span>
            ) : (
              <span>
                <strong style={{ color: RED }}>No scenario meets the requirements.</strong>{' '}
                <span className="muted">Try another date in the calendar or relax the requirements.</span>
              </span>
            )}
          </div>

          <div className="scen-cols" style={{ gridTemplateColumns: `repeat(${Math.max(2, result.results.length)}, minmax(0, 1fr))` }}>
            {result.results.map((r, i) => {
              const draft = sentDrafts[i];
              const s = r.summary;
              const color = s.successPct >= 80 ? 'var(--earth)' : s.successPct >= 60 ? 'var(--white)' : RED;
              const isReco = result.recommendation?.label === r.label;
              const delta = i > 0 && baseScore !== undefined ? s.successPct - baseScore : null;
              return (
                <section key={r.label} className={`panel scen-col${isReco ? ' is-reco' : ''}`} aria-label={r.label}>
                  <div className="scen-col__head">
                    <span className="eyebrow">{i === 0 ? 'Baseline' : `Scenario ${i + 1}`}</span>
                    {isReco && <span className="scen-col__badge">★ RECOMMENDED</span>}
                  </div>
                  <h2 className="scen-col__title">{r.label}</h2>
                  {draft && (
                    <span className="mono muted" style={{ fontSize: 13 }}>
                      {draft.name ?? 'Custom point'} · {draft.landingTime.slice(0, 10)}
                    </span>
                  )}
                  <div className="scen-col__score">
                    <span style={{ color }}>{s.successPct}%</span>
                    <strong style={{ color }}>{s.verdict}</strong>
                  </div>
                  <span className="mono muted" style={{ fontSize: 13 }}>
                    {delta === null ? 'reference' : `${delta >= 0 ? '+' : ''}${delta} pts vs baseline`}
                  </span>
                  <span className="scen-col__req" style={{ color: r.meetsRequirements ? 'var(--earth)' : RED }}>
                    {r.meetsRequirements ? '✓ Meets requirements' : '✕ Misses requirements'}
                  </span>
                  <dl className="details">
                    <Stat k="Min battery" v={`${Math.round(s.minSocPct)} %`} ok={s.minSocPct >= requirements.minSocPct} />
                    <Stat k="Earth in view" v={`${Math.round(s.earthVisiblePct)} %`} ok={s.earthVisiblePct >= requirements.minEarthVisiblePct} />
                    <Stat k="Sunlit" v={`${Math.round(s.sunlitPct)} %`} />
                    <Stat k="Longest night" v={`${Math.round(s.longestNightH)} h`} />
                    <Stat k="First sunset" v={s.firstSunsetDay === null ? '—' : `day ${s.firstSunsetDay.toFixed(1)}`} />
                  </dl>
                  <button type="button" className="btn" onClick={() => navigate(`/simulation/${encodeURIComponent(r.simulationId)}`)}>
                    Open simulation
                  </button>
                </section>
              );
            })}
          </div>

          <section className="panel scen-windows" aria-label="Operating windows">
            <div className="dates-year__head">
              <h2 style={{ fontSize: 20 }}>Operating windows · day 0 → {WINDOW_DAYS}</h2>
              <ul className="dates-legend" aria-label="Legend">
                <li><span className="swatch" style={{ background: 'var(--white)' }} />Sun + Earth</li>
                <li><span className="swatch" style={{ background: 'var(--sun)' }} />Sun only</li>
                <li><span className="swatch" style={{ background: 'var(--earth)' }} />Earth only</li>
                <li><span className="swatch tier-risky" />Dark, no contact</li>
              </ul>
            </div>
            {result.results.map((r, i) => {
              const mission = sentDrafts[i]?.missionDays ?? 14;
              return (
                <div key={r.label} className="scen-row">
                  <span className="scen-row__name">
                    <strong>{r.label}</strong>
                  </span>
                  <div className="scen-row__bar">
                    {combinedSegments(r.windows, WINDOW_DAYS).map((seg, i) => (
                      <span key={i} style={{ width: `${seg.pct}%`, background: seg.color }} title={`day ${seg.from.toFixed(1)}–${seg.to.toFixed(1)}`} />
                    ))}
                    <i style={{ left: `${(mission / WINDOW_DAYS) * 100}%` }} title={`Mission end · day ${mission}`} />
                  </div>
                  <span className="mono" style={{ width: 52, textAlign: 'right' }}>
                    {r.summary.successPct}%
                  </span>
                </div>
              );
            })}
            <div className="sim-ticks mono muted" style={{ paddingLeft: 180, paddingRight: 64 }}>
              <span>day 0</span>
              <span>day 10</span>
              <span>day 20</span>
              <span>day 30</span>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              White tick = end of each mission. Scores count only the mission days.
            </p>
          </section>
        </>
      )}

      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Need a different date? <Link to="/dates">Open the calendar</Link> and use “Add to comparison”.
      </p>
    </main>
  );
}

function clampPct(v: string) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function Stat({ k, v, ok }: { k: string; v: string; ok?: boolean }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd style={{ color: ok === false ? RED : undefined }}>
        {ok === undefined ? '' : ok ? '✓ ' : '! '}
        {v}
      </dd>
    </div>
  );
}

/** Merge sun/earth windows into one strip: both / sun only / earth only / dark. */
function combinedSegments(w: { sun: DayWindow[]; earth: DayWindow[] }, total: number) {
  const cuts = new Set<number>([0, total]);
  for (const x of [...w.sun, ...w.earth]) {
    cuts.add(Math.max(0, Math.min(total, x.fromDay)));
    cuts.add(Math.max(0, Math.min(total, x.toDay)));
  }
  const pts = [...cuts].sort((a, b) => a - b);
  const inside = (ws: DayWindow[], d: number) => ws.some((x) => d >= x.fromDay && d < x.toDay);
  const out: { from: number; to: number; pct: number; color: string }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const mid = (pts[i] + pts[i + 1]) / 2;
    const s = inside(w.sun, mid);
    const e = inside(w.earth, mid);
    const color = s && e ? 'var(--white)' : s ? 'var(--sun)' : e ? 'var(--earth)' : 'transparent';
    const last = out[out.length - 1];
    if (last && last.color === color) {
      last.to = pts[i + 1];
      last.pct = ((last.to - last.from) / total) * 100;
    } else out.push({ from: pts[i], to: pts[i + 1], pct: ((pts[i + 1] - pts[i]) / total) * 100, color });
  }
  return out;
}

function RunningNote({ count }: { count: number }) {
  return (
    <StepLoader
      title={`Comparing ${count} scenarios`}
      steps={[
        { at: 0, label: 'Loading terrain for each site' },
        { at: 8, label: 'Fetching Sun and Earth positions from JPL Horizons' },
        { at: 20, label: `Running ${count} simulations in parallel` },
        { at: 45, label: 'Checking requirements and picking a recommendation' },
      ]}
      hint="New sites download terrain first; repeated comparisons are much faster."
    />
  );
}
