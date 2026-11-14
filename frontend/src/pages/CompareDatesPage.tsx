import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, apiMode, getCalendar } from '../api/client';
import type { CalendarDay, CalendarRequest, CalendarResult, HorizonModel } from '../api/types';
import { useSelection } from '../store/selection';
import { useScenarios } from '../store/scenarios';
import { defaultHorizonModel, siteRef } from '../lib/requests';
import { toQuery } from '../lib/coords';
import './CompareDatesPage.css';
import { StepLoader } from '../components/StepLoader';

/* ---------- date helpers (all UTC, "YYYY-MM-DD") ---------- */
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = (y: number, m: number) => new Date(Date.UTC(y, m, 1));
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0));
const addMonths = (ym: { y: number; m: number }, n: number) => {
  const d = monthStart(ym.y, ym.m + n);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

type Tier = 'good' | 'fair' | 'risky';
const tier = (pct: number): Tier => (pct >= 80 ? 'good' : pct >= 60 ? 'fair' : 'risky');
const verdict = (pct: number) => (pct >= 80 ? 'LIKELY' : pct >= 60 ? 'POSSIBLE' : 'RISKY');

/** Calendars are slow to compute (synchronous on the backend) — cache by request. */
const cache = new Map<string, Promise<CalendarResult>>();
function fetchCalendar(req: CalendarRequest) {
  const key = JSON.stringify(req);
  if (!cache.has(key)) {
    const p = getCalendar(req).catch((e) => {
      cache.delete(key);
      throw e;
    });
    cache.set(key, p);
  }
  return cache.get(key)!;
}

function useCalendar(req: CalendarRequest | null) {
  const [state, setState] = useState<{ data: CalendarResult | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: !!req });
  const [attempt, setAttempt] = useState(0);
  const key = req ? JSON.stringify(req) : null;
  useEffect(() => {
    if (!req) return;
    let alive = true;
    setState({ data: null, error: null, loading: true });
    fetchCalendar(req)
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error: Error) => alive && setState({ data: null, error, loading: false }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  return { ...state, retry: () => setAttempt((a) => a + 1) };
}

/** Screen 8 — score for every landing day (POST /calendar), like a flight-price calendar. */
export function CompareDatesPage() {
  const navigate = useNavigate();
  const sel = useSelection();
  const yourDate = sel.landingTime.slice(0, 10);
  const timeOfDay = `${sel.landingTime.slice(11, 16)}:00Z`;
  const [forceFlat, setForceFlat] = useState(false);
  const horizonModel: HorizonModel = forceFlat ? 'flat' : defaultHorizonModel(sel.lat);

  const landing = new Date(`${yourDate}T00:00:00Z`);
  const [view, setView] = useState({ y: landing.getUTCFullYear(), m: landing.getUTCMonth() });
  const [yearWanted, setYearWanted] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const base = useMemo(
    () => ({ site: siteRef(sel), landingTimeOfDay: timeOfDay, missionDays: sel.missionDays, horizonModel }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sel.name, sel.lat, sel.lon, timeOfDay, sel.missionDays, horizonModel],
  );
  const next = addMonths(view, 1);
  const monthsReq = useMemo<CalendarRequest>(
    () => ({ ...base, from: iso(monthStart(view.y, view.m)), to: iso(monthEnd(next.y, next.m)) }),
    [base, view, next.y, next.m],
  );
  const yearReq = useMemo<CalendarRequest | null>(
    () => (yearWanted ? { ...base, from: `${view.y}-01-01`, to: `${view.y}-12-31` } : null),
    [base, yearWanted, view.y],
  );

  const year = useCalendar(yearReq);
  // Once the year is loaded and covers both visible months, reuse it instead of another request.
  const yearCovers = !!year.data && view.y === next.y;
  const months = useCalendar(yearCovers ? null : monthsReq);
  const data = yearCovers ? year.data : months.data;

  const byDate = useMemo(() => {
    const m = new Map<string, CalendarDay>();
    for (const d of [...(year.data?.days ?? []), ...(months.data?.days ?? [])]) m.set(d.date, d);
    return m;
  }, [year.data, months.data]);

  const visibleDays = useMemo(() => {
    const from = monthsReq.from;
    const to = monthsReq.to;
    return [...byDate.values()].filter((d) => d.date >= from && d.date <= to);
  }, [byDate, monthsReq]);
  const best = visibleDays.length ? visibleDays.reduce((a, b) => (b.successPct > a.successPct ? b : a)) : null;
  const pick = (selected && byDate.get(selected)) || best;
  const yours = byDate.get(yourDate) ?? null;

  const loading = yearCovers ? false : months.loading;
  const error = yearCovers ? null : months.error;
  const coverage = error instanceof ApiError && error.code === 'OUT_OF_DEM_COVERAGE';

  const addScenario = useScenarios((s) => s.add);
  const scenarioCount = useScenarios((s) => s.items.length);
  function addToComparison(date: string) {
    const lt = sel.landingTime;
    if (scenarioCount === 0) addScenario({ label: 'Baseline', name: sel.name, lat: sel.lat, lon: sel.lon, landingTime: lt, missionDays: sel.missionDays });
    addScenario({ label: `Land ${date.slice(5)}`, name: sel.name, lat: sel.lat, lon: sel.lon, landingTime: `${date}T${lt.slice(11, 16)}`, missionDays: sel.missionDays });
    navigate('/scenarios');
  }

  function applyDate(date: string, go: 'simulate' | 'site') {
    sel.setMission({ landingTime: `${date}T${sel.landingTime.slice(11, 16)}` });
    navigate(go === 'simulate' ? '/simulation/new' : `/site${toQuery(sel)}`);
  }

  return (
    <main className="page dates-page">
      <div className="dates-head">
        <div>
          <span className="eyebrow">
            {sel.name ?? 'Custom point'} · {sel.missionDays}-day mission · landing {sel.landingTime.slice(11, 16)} UTC · {horizonModel === 'real' ? 'real terrain' : 'flat horizon'}
          </span>
          <h1 className="hero-title" style={{ fontSize: 36, marginTop: 6 }}>
            Pick a better landing day
          </h1>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Each day shows the mission success estimate if you land then. Click a day to see why.
          </p>
        </div>
        <ul className="dates-legend" aria-label="Legend">
          <li><span className="swatch tier-good" />80 %+ likely</li>
          <li><span className="swatch tier-fair" />60–79 % possible</li>
          <li><span className="swatch tier-risky" />▼ under 60 % risky</li>
          <li><span className="swatch swatch--best" />★ best</li>
        </ul>
      </div>

      <div className="dates-layout">
        <section className="dates-main" aria-label="Calendar">
          <div className="dates-nav">
            <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => setView(addMonths(view, -1))}>
              ‹
            </button>
            <strong>
              {MONTHS[view.m]} – {MONTHS[next.m]} {next.y}
            </strong>
            <button type="button" className="icon-btn" aria-label="Next month" onClick={() => setView(addMonths(view, 1))}>
              ›
            </button>
            {(data?.mock || apiMode === 'mock') && <span className="badge badge--warn">MOCK DATA</span>}
          </div>

          {error ? (
            <div className="panel dates-error" role="alert">
              <strong>Could not compute the calendar</strong>
              <span className="muted">{error.message}</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn--primary" onClick={months.retry}>
                  Try again
                </button>
                {coverage && (
                  <button type="button" className="btn" onClick={() => setForceFlat(true)}>
                    Use flat horizon
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="dates-months">
              {[view, next].map((ym) => (
                <MonthGrid
                  key={`${ym.y}-${ym.m}`}
                  y={ym.y}
                  m={ym.m}
                  byDate={byDate}
                  loading={loading}
                  bestDate={best?.date ?? null}
                  yourDate={yourDate}
                  selected={pick?.date ?? null}
                  onPick={setSelected}
                />
              ))}
            </div>
          )}
          {loading && <LoadingNote what="two months" />}

          <section className="panel dates-year" aria-label="12-month outlook">
            <div className="dates-year__head">
              <h2 style={{ fontSize: 20 }}>12-month outlook · {view.y}</h2>
              {!yearWanted && (
                <button type="button" className="btn" onClick={() => setYearWanted(true)}>
                  Load full year
                </button>
              )}
            </div>
            {!yearWanted && <p className="muted" style={{ margin: 0 }}>Shows how good landing days cluster across the year. The full year can take a while to compute.</p>}
            {year.loading && <LoadingNote what={`all of ${view.y}`} />}
            {year.error && (
              <p className="error" style={{ margin: 0 }}>
                {year.error.message}{' '}
                <button type="button" className="btn" onClick={year.retry} style={{ minHeight: 36 }}>
                  Retry
                </button>
              </p>
            )}
            {year.data && <YearStrips data={year.data} yourDate={yourDate} onPickMonth={(m) => setView({ y: view.y, m })} />}
          </section>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Calendar scores use hourly samples; the simulation uses 10-minute steps, so a day can differ by a point or two.
          </p>
        </section>

        <aside className="panel dates-side" aria-label="Selected landing day">
          {pick ? (
            <>
              <span className="eyebrow">Selected landing</span>
              <div className="dates-side__date">{new Date(`${pick.date}T00:00:00Z`).toUTCString().slice(0, 16)}</div>
              <div className="dates-side__score">
                <span className={`dates-side__pct tier-text-${tier(pick.successPct)}`}>{pick.successPct}%</span>
                <span className={`tier-text-${tier(pick.successPct)}`} style={{ fontWeight: 700 }}>
                  {tier(pick.successPct) === 'risky' ? '▼ ' : ''}
                  {verdict(pick.successPct)}
                </span>
              </div>
              <span className="mono muted">{deltaText(pick.date, yourDate)}</span>

              {yours && (
                <div className="dates-compare">
                  <Bar label={`Your date · ${yourDate.slice(5)}`} pct={yours.successPct} color="var(--white)" />
                  <Bar label={`Selected · ${pick.date.slice(5)}`} pct={pick.successPct} color="var(--accent)" />
                </div>
              )}

              <dl className="details">
                <div>
                  <dt>Min battery</dt>
                  <dd>{Math.round(pick.minSocPct)} %</dd>
                </div>
                <div>
                  <dt>Earth in view</dt>
                  <dd>{Math.round(pick.earthVisiblePct)} %</dd>
                </div>
                <div>
                  <dt>Longest night</dt>
                  <dd>{Math.round(pick.longestNightH)} h</dd>
                </div>
              </dl>

              <button type="button" className="btn btn--primary btn--lg" onClick={() => applyDate(pick.date, 'simulate')}>
                ▶ Simulate this date
              </button>
              <button type="button" className="btn" onClick={() => applyDate(pick.date, 'site')} disabled={pick.date === yourDate}>
                Set as landing date
              </button>
              <button type="button" className="btn" onClick={() => addToComparison(pick.date)} disabled={pick.date === yourDate}>
                + Add to comparison
              </button>
            </>
          ) : (
            <span className="muted">{loading ? 'Computing…' : 'No data for these months.'}</span>
          )}
          <Link to={`/site${toQuery(sel)}`} className="muted" style={{ fontSize: 14 }}>
            ← Back to site
          </Link>
        </aside>
      </div>
    </main>
  );
}

function deltaText(date: string, yours: string) {
  const d = Math.round((Date.parse(date) - Date.parse(yours)) / 86_400_000);
  if (d === 0) return 'your current date';
  return `${d > 0 ? '+' : ''}${d} days vs your date — launch moves by the same`;
}

function Bar({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
        <span>{label}</span>
        <span className="mono">{pct} %</span>
      </div>
      <div className="meter" style={{ marginTop: 4 }}>
        <span style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function MonthGrid({
  y,
  m,
  byDate,
  loading,
  bestDate,
  yourDate,
  selected,
  onPick,
}: {
  y: number;
  m: number;
  byDate: Map<string, CalendarDay>;
  loading: boolean;
  bestDate: string | null;
  yourDate: string;
  selected: string | null;
  onPick: (date: string) => void;
}) {
  const first = monthStart(y, m);
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const count = monthEnd(y, m).getUTCDate();
  return (
    <section className="panel month" aria-label={`${MONTHS[m]} ${y}`}>
      <h2 style={{ fontSize: 20, marginBottom: 12 }}>
        {MONTHS[m]} {y}
      </h2>
      <div className="month__grid month__dow" aria-hidden="true">
        {['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="month__grid">
        {Array.from({ length: lead }, (_, i) => (
          <span key={`b${i}`} />
        ))}
        {Array.from({ length: count }, (_, i) => {
          const date = iso(new Date(Date.UTC(y, m, i + 1)));
          const d = byDate.get(date);
          if (!d) {
            return (
              <span key={date} className={`day day--empty${loading ? ' is-loading' : ''}`}>
                <span className="day__num">{i + 1}</span>
              </span>
            );
          }
          const t = tier(d.successPct);
          const isBest = date === bestDate;
          const isYours = date === yourDate;
          return (
            <button
              key={date}
              type="button"
              className={`day tier-${t}${isBest ? ' is-best' : ''}${selected === date ? ' is-selected' : ''}`}
              aria-pressed={selected === date}
              aria-label={`${date}: ${d.successPct} percent${isBest ? ', best day' : ''}${isYours ? ', your date' : ''}`}
              onClick={() => onPick(date)}
            >
              <span className="day__num">{i + 1}</span>
              <span className="day__pct">
                {t === 'risky' ? '▼' : ''}
                {d.successPct}
              </span>
              <span className="day__tag">{isBest ? '★ BEST' : isYours ? 'YOURS' : ''}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function YearStrips({ data, yourDate, onPickMonth }: { data: CalendarResult; yourDate: string; onPickMonth: (m: number) => void }) {
  const byMonth = new Map<number, CalendarDay[]>();
  for (const d of data.days) {
    const m = +d.date.slice(5, 7) - 1;
    byMonth.set(m, [...(byMonth.get(m) ?? []), d]);
  }
  return (
    <div className="year">
      {MONTHS.map((name, m) => {
        const ds = byMonth.get(m) ?? [];
        const info = data.months.find((x) => +x.month.slice(5, 7) - 1 === m);
        return (
          <button key={name} type="button" className="year__row" onClick={() => onPickMonth(m)} aria-label={`Show ${name}`}>
            <span className="year__name">{name.slice(0, 3)}</span>
            <span className="year__cells">
              {ds.map((d) => (
                <span key={d.date} className={`year__cell tier-${tier(d.successPct)}${d.date === yourDate ? ' is-yours' : ''}${d.date === data.best.date ? ' is-best' : ''}`} title={`${d.date}: ${d.successPct} %`} />
              ))}
            </span>
            <span className="year__info mono muted">{info ? `${info.goodDays} good · best ${info.bestPct} %` : ''}</span>
          </button>
        );
      })}
      <span className="muted" style={{ fontSize: 13 }}>
        White outline = your date · yellow = best day of the year ({data.best.date}, {data.best.successPct} %). Click a month to open it above.
      </span>
    </div>
  );
}

function LoadingNote({ what }: { what: string }) {
  return (
    <StepLoader
      title={`Scoring every landing day · ${what}`}
      steps={[
        { at: 0, label: 'Loading terrain around the site (first run downloads a 340 km LOLA map)' },
        { at: 10, label: 'Fetching Sun and Earth positions from JPL Horizons' },
        { at: 30, label: 'Simulating each landing day: sunlight, Earth view, battery' },
        { at: 75, label: 'Ranking days and grouping them by month' },
      ]}
      hint="Usually 1–2 minutes for a new site or range; repeat views are cached."
      slowAfterS={150}
    />
  );
}
