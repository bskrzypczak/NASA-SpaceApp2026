import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiMode, getNearby } from '../api/client';
import type { NearbyGoal, NearbyRequest, NearbyResponse, NearbySuggestion } from '../api/types';
import { useSelection } from '../store/selection';
import { formatLat, formatLon, toQuery } from '../lib/coords';
import { StepLoader } from '../components/StepLoader';
import './NearbyPage.css';

const RADII_KM = [1, 2.5, 5, 10];
const SLOPES_DEG = [5, 10, 15];
const GOALS: { id: NearbyGoal; label: string }[] = [
  { id: 'balanced', label: 'Balanced' },
  { id: 'power', label: '☀ Power' },
  { id: 'comms', label: '◉ Comms' },
];

type Tier = 'good' | 'fair' | 'risky';
const tier = (pct: number): Tier => (pct >= 80 ? 'good' : pct >= 60 ? 'fair' : 'risky');

/** Initial bearing from a to b, degrees clockwise from north. */
function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const dLon = (bLon - aLon) * r;
  const y = Math.sin(dLon) * Math.cos(bLat * r);
  const x = Math.cos(aLat * r) * Math.sin(bLat * r) - Math.sin(aLat * r) * Math.cos(bLat * r) * Math.cos(dLon);
  return ((Math.atan2(y, x) / r) % 360 + 360) % 360;
}

/** Which of the 4 sampled cells (N, E, S, W) a suggestion sits in. */
function cellOf(centre: { lat: number; lon: number }, s: NearbySuggestion): [number, number] {
  const b = bearingDeg(centre.lat, centre.lon, s.lat, s.lon);
  if (b >= 315 || b < 45) return [0, 1];
  if (b < 135) return [1, 2];
  if (b < 225) return [2, 1];
  return [1, 0];
}

const isCorner = (r: number, c: number) => r !== 1 && c !== 1;

/** Screen 3b — "Better places nearby": sensitivity of the score to small moves of the landing point. */
export function NearbyPage() {
  const navigate = useNavigate();
  const sel = useSelection();
  const [radiusKm, setRadiusKm] = useState(2.5);
  const [goal, setGoal] = useState<NearbyGoal>('balanced');
  const [maxSlopeDeg, setMaxSlopeDeg] = useState(10);
  const [state, setState] = useState<{ loading: boolean; error: Error | null; data: NearbyResponse | null; req: NearbyRequest | null }>({
    loading: false,
    error: null,
    data: null,
    req: null,
  });

  const req: NearbyRequest = useMemo(
    () => ({
      center: { lat: +sel.lat.toFixed(5), lon: +sel.lon.toFixed(5) },
      radiusKm,
      landingTime: `${sel.landingTime}:00Z`,
      missionDays: sel.missionDays,
      goal,
      maxSlopeDeg,
      top: 3,
      hardware: sel.hardware,
    }),
    [sel.lat, sel.lon, sel.landingTime, sel.missionDays, radiusKm, goal, maxSlopeDeg, sel.hardware],
  );
  const stale = !!state.req && JSON.stringify(state.req) !== JSON.stringify(req);

  function run(r: NearbyRequest = req) {
    setState((s) => ({ ...s, loading: true, error: null }));
    getNearby(r)
      .then((data) => setState({ loading: false, error: null, data, req: r }))
      .catch((error: Error) => setState((s) => ({ ...s, loading: false, error })));
  }

  // First run on open, with the current pick and defaults.
  useEffect(() => {
    if (apiMode !== 'offline') run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickPoint(s: NearbySuggestion) {
    sel.selectSite({ lat: s.lat, lon: s.lon, name: null });
    navigate(`/site${toQuery({ lat: s.lat, lon: s.lon })}`);
  }

  const data = state.data;
  const shownReq = state.req ?? req;
  const rankAt = new Map<string, NearbySuggestion>();
  data?.suggestions.forEach((s) => rankAt.set(cellOf(shownReq.center, s).join(','), s));
  const centreExcluded = data?.grid.excluded[1]?.[1] ?? false;

  return (
    <main className="page nearby">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to={`/site${toQuery({ lat: sel.lat, lon: sel.lon })}`}>Site</Link>
        <span aria-hidden="true">/</span>
        <span>Better places nearby</span>
      </nav>

      <header className="nearby__head">
        <div>
          <span className="eyebrow">Sensitivity map</span>
          <h1 style={{ margin: '4px 0' }}>Better places nearby</h1>
          <p className="muted" style={{ margin: 0 }}>
            {sel.name ?? 'Custom point'} · {formatLat(sel.lat, 3)} · {formatLon(sel.lon, 3)} · {sel.landingTime.replace('T', ' ')} UTC · {sel.missionDays} d
          </p>
        </div>
        {data?.mock && <span className="badge badge--warn">MOCK DATA</span>}
      </header>

      <section className="panel nearby__controls" aria-label="Search settings">
        <div className="nearby__control">
          <span className="eyebrow">Move up to</span>
          <div role="group" aria-label="Search radius" className="segmented">
            {RADII_KM.map((r) => (
              <button key={r} type="button" aria-pressed={radiusKm === r} onClick={() => setRadiusKm(r)}>
                {r} km
              </button>
            ))}
          </div>
        </div>
        <div className="nearby__control">
          <span className="eyebrow">Optimise for</span>
          <div role="group" aria-label="Goal" className="segmented">
            {GOALS.map((g) => (
              <button key={g.id} type="button" aria-pressed={goal === g.id} onClick={() => setGoal(g.id)}>
                {g.label}
              </button>
            ))}
          </div>
        </div>
        <div className="nearby__control">
          <span className="eyebrow">Max slope</span>
          <div role="group" aria-label="Maximum slope" className="segmented">
            {SLOPES_DEG.map((d) => (
              <button key={d} type="button" aria-pressed={maxSlopeDeg === d} onClick={() => setMaxSlopeDeg(d)}>
                {d}°
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="btn btn--primary btn--lg nearby__run" disabled={state.loading || apiMode === 'offline'} onClick={() => run()}>
          {state.loading ? 'Simulating…' : data && !stale ? '↻ Run again' : '▶ Find better places'}
        </button>
      </section>

      {apiMode === 'offline' && <p className="error">! Needs the backend: set VITE_API_URL or VITE_USE_MOCKS=true in .env.local.</p>}
      {state.error && (
        <p className="error" role="status">
          ! {state.error.message}
        </p>
      )}
      {state.loading && (
        <StepLoader
          title={`Checking 4 neighbours ${radiusKm} km away`}
          steps={[
            { at: 0, label: 'Reading slope and permanent-shadow maps around your point' },
            { at: 5, label: 'Loading terrain horizon for all 5 points (one shared LOLA map)' },
            { at: 20, label: 'Simulating your point and the safe neighbours' },
            { at: 45, label: 'Comparing scores and writing suggestions' },
          ]}
          hint="The first run on a new point can take 1–2 minutes; repeats are cached."
        />
      )}
      {stale && data && !state.loading && <p className="muted" style={{ margin: 0 }}>Settings changed — results below are for the previous run.</p>}

      {data && (
        <div className="nearby__body">
          <section className="panel nearby__map" aria-label="Score around your point">
            <div className="nearby__compass" aria-hidden="true">
              <span className="nearby__w">W</span>
              <span className="nearby__e">E</span>
            </div>
            <span className="nearby__ns" aria-hidden="true">N</span>
            <div className="nearby__grid" role="grid" aria-label={`3 by 3 grid, ${shownReq.radiusKm} km between points, north up`}>
              {data.grid.successPct.map((row, r) => (
                <div role="row" key={r} className="nearby__row">
                  {row.map((pct, c) => {
                    const centre = r === 1 && c === 1;
                    const s = rankAt.get(`${r},${c}`);
                    if (isCorner(r, c) && pct === null) {
                      return (
                        <div role="gridcell" key={c} className="nearby__cell nearby__cell--off" aria-label="Not sampled">
                          <span className="muted">· not sampled</span>
                        </div>
                      );
                    }
                    if (pct === null) {
                      return (
                        <div role="gridcell" key={c} className="nearby__cell nearby__cell--unsafe" aria-label="Unsafe: steep, in permanent shadow, or no data">
                          <strong>✕</strong>
                          <span>unsafe</span>
                          <span className="nearby__small">slope / PSR / no data</span>
                        </div>
                      );
                    }
                    const delta = pct - data.center.successPct;
                    return (
                      <div
                        role="gridcell"
                        key={c}
                        className={`nearby__cell tier-${tier(pct)}${centre ? ' is-centre' : ''}${s ? ' is-pick' : ''}`}
                        aria-label={`${centre ? 'Your point' : s ? `Option ${s.rank}` : 'Neighbour'}: ${pct} %`}
                      >
                        {centre ? <span className="nearby__tag">★ You</span> : s ? <span className="nearby__tag">{s.rank}</span> : null}
                        <span className="nearby__pct">
                          {tier(pct) === 'risky' ? '▼ ' : ''}
                          {pct}%
                        </span>
                        {!centre && (
                          <span className="nearby__small">
                            {delta > 0 ? '▲ +' : delta < 0 ? '▼ ' : '= '}
                            {delta} pts
                          </span>
                        )}
                        {centre && centreExcluded && <span className="nearby__small">! steep / PSR</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <span className="nearby__ns" aria-hidden="true">S</span>
            <p className="muted nearby__small" style={{ margin: 0 }}>
              {shownReq.radiusKm} km between points · north up · corners are not sampled
            </p>
          </section>

          <section className="nearby__list" aria-label="Suggestions">
            {centreExcluded && (
              <p className="panel nearby__warn">
                ! Your point fails the safety check (slope over {shownReq.maxSlopeDeg}° or permanent shadow). Its score is shown for comparison only.
              </p>
            )}
            {data.suggestions.length === 0 ? (
              <div className="panel">
                <strong>★ Your point is the best in this area</strong>
                <p className="muted" style={{ margin: '6px 0 0' }}>
                  No safe point {shownReq.radiusKm} km away scores higher than {data.center.successPct}%. Try a larger radius or another goal.
                </p>
              </div>
            ) : (
              data.suggestions.map((s) => (
                <article key={s.rank} className="panel nearby__card">
                  <div className="nearby__card-head">
                    <span className="nearby__rank" aria-hidden="true">
                      {s.rank}
                    </span>
                    <div style={{ flex: 1 }}>
                      <strong>Option {s.rank}</strong>
                      <div className="mono muted nearby__small">
                        {formatLat(s.lat, 3)} · {formatLon(s.lon, 3)} · {s.distanceKm} km away
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className={`nearby__pct tier-text-${tier(s.successPct)}`}>{s.successPct}%</div>
                      <div className="nearby__small">▲ +{s.successPct - data.center.successPct} pts</div>
                    </div>
                  </div>
                  <ul className="nearby__why">
                    {s.why.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                  <button type="button" className="btn" onClick={() => pickPoint(s)}>
                    Use this point →
                  </button>
                </article>
              ))
            )}
            <p className="muted nearby__small" style={{ margin: 0 }}>
              Quick estimate: 1-hour simulation steps and a coarse slope grid, so scores can differ by a few points from the full simulation. Always re-run the
              simulation for the point you pick.
            </p>
          </section>
        </div>
      )}
    </main>
  );
}
