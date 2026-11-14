import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, apiMode, createSimulation, getHorizon, getSimulation } from '../api/client';
import type { HorizonModel, SimulationRequest, SimulationResult } from '../api/types';
import { useSelection, type SelectionState } from '../store/selection';
import { setLastSimulation, useSimulations } from '../store/simulations';
import { useApi } from '../hooks/useApi';
import { SITES } from '../data/sites';
import { skyAt } from '../lib/sky';
import { formatLat, formatLon, toQuery } from '../lib/coords';
import { SimScene3D, VERTICAL_EXAGGERATION, type CameraMode } from '../components/sim/SimScene3D';
import { SkyView } from '../components/sim/SkyView';
import { StatusCards, SuccessCard, Timeline } from '../components/sim/SimPanels';
import { DEFAULT_HARDWARE } from '../lib/simModel';
import { defaultHorizonModel, siteRef } from '../lib/requests';
import './SimulationPage.css';

const WINDOW_DAYS = 30;
const STEP_MIN = 10; // 30 d × 144 = 4320 samples = backend limit

/* ---------- Request helpers ---------- */

function requestFromSelection(sel: SelectionState, horizonModel?: HorizonModel): SimulationRequest {
  return {
    site: siteRef(sel),
    landingTime: `${sel.landingTime}:00Z`,
    missionDays: sel.missionDays,
    windowDays: WINDOW_DAYS,
    stepMin: STEP_MIN,
    horizonModel: horizonModel ?? defaultHorizonModel(sel.lat),
    includeTimeseries: true,
  };
}

function twinRequest(r: SimulationResult, horizonModel: HorizonModel): SimulationRequest {
  const i = r.input;
  return {
    site: i.site ?? { lat: r.site.lat, lon: r.site.lon },
    landingTime: i.landingTime ?? new Date().toISOString(),
    missionDays: i.missionDays ?? 14,
    windowDays: i.windowDays ?? WINDOW_DAYS,
    stepMin: i.stepMin ?? STEP_MIN,
    horizonModel,
    hardware: i.hardware,
    weights: i.weights,
    includeTimeseries: true,
  };
}

/** The backend can take ~40 s; React StrictMode runs effects twice — share one request per payload. */
const inFlight = new Map<string, Promise<SimulationResult>>();
function runOnce(req: SimulationRequest): Promise<SimulationResult> {
  const key = JSON.stringify(req);
  let p = inFlight.get(key);
  if (!p) {
    p = createSimulation(req).finally(() => setTimeout(() => inFlight.delete(key), 1000));
    inFlight.set(key, p);
  }
  return p;
}

/* ---------- /simulation/new ---------- */

export function SimulationNewPage() {
  const navigate = useNavigate();
  const sel = useSelection();
  const put = useSimulations((s) => s.put);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [forceFlat, setForceFlat] = useState(false);
  const req = useMemo(() => requestFromSelection(sel, forceFlat ? 'flat' : undefined), [sel, forceFlat]);

  useEffect(() => {
    let alive = true;
    setError(null);
    runOnce(req)
      .then((res) => {
        if (!alive) return;
        put(res);
        setLastSimulation(res.id);
        navigate(`/simulation/${encodeURIComponent(res.id)}`, { replace: true });
      })
      .catch((e: Error) => alive && setError(e));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, req]);

  if (error) {
    const coverage = error instanceof ApiError && error.code === 'OUT_OF_DEM_COVERAGE';
    return (
      <SimMessage title="Simulation failed" detail={error.message} code={error instanceof ApiError ? error.code : undefined}>
        <button type="button" className="btn btn--primary" onClick={() => setAttempt((a) => a + 1)}>
          Try again
        </button>
        {coverage && (
          <button type="button" className="btn" onClick={() => setForceFlat(true)}>
            Run with flat horizon
          </button>
        )}
        <Link to={`/site${toQuery(sel)}`} className="btn">
          Back to site
        </Link>
      </SimMessage>
    );
  }
  return <SimLoading name={sel.name ?? 'Custom point'} realTerrain={req.horizonModel === 'real'} />;
}

/* ---------- /simulation/:id ---------- */

export function SimulationPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const cached = useSimulations((s) => s.results[id]);
  const put = useSimulations((s) => s.put);
  const linkFlat = useSimulations((s) => s.linkFlat);
  const flatId = useSimulations((s) => s.flatTwin[id]);
  const flatResult = useSimulations((s) => (flatId ? s.results[flatId] : undefined));

  const fetched = useApi((signal) => (cached ? Promise.resolve(cached) : getSimulation(id, signal)), [id]);
  const base = cached ?? fetched.data ?? null;

  useEffect(() => {
    if (fetched.data && !cached) {
      put(fetched.data);
      setLastSimulation(fetched.data.id);
    }
  }, [fetched.data, cached, put]);

  const [view, setView] = useState<'3d' | 'sky'>('3d');
  const [camera, setCamera] = useState<CameraMode>('orbit');
  const [showFlat, setShowFlat] = useState(false);
  const [flatLoading, setFlatLoading] = useState(false);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(6);

  const baseIsReal = base?.input.horizonModel !== 'flat';
  const shown = showFlat && flatResult ? flatResult : base;
  const realTerrain = !!shown && shown.input.horizonModel !== 'flat';
  const windowDays = shown?.input.windowDays ?? WINDOW_DAYS;
  const missionDays = shown?.input.missionDays ?? 14;
  const reservePct = shown?.input.hardware?.reservePct ?? DEFAULT_HARDWARE.reservePct;

  const horizon = useApi(
    (signal) => (base && baseIsReal ? getHorizon(base.site.lat, base.site.lon, base.input.hardware?.panelHeightM ?? 2, signal) : Promise.resolve(null)),
    [base?.id],
  );

  // Playback: `speed` simulated hours per real second.
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const next = tRef.current + (speed / 24) * 0.05;
      if (next >= windowDays) {
        setT(windowDays);
        setPlaying(false);
      } else setT(next);
    }, 50);
    return () => clearInterval(timer);
  }, [playing, speed, windowDays]);

  async function toggleHorizon(flat: boolean) {
    setShowFlat(flat);
    if (!flat || !base || flatResult || !baseIsReal) return;
    setFlatLoading(true);
    try {
      const res = await runOnce(twinRequest(base, 'flat'));
      put(res);
      linkFlat(base.id, res.id);
    } catch {
      setShowFlat(false);
    } finally {
      setFlatLoading(false);
    }
  }

  if (!base) {
    if (fetched.loading) return <SimLoading name="simulation" realTerrain={false} short />;
    return (
      <SimMessage
        title="Simulation not found"
        detail="The backend keeps results only in memory, so they disappear after a restart. Run it again from the site screen."
        code={fetched.error instanceof ApiError ? fetched.error.code : undefined}
      >
        <button type="button" className="btn btn--primary" onClick={() => navigate('/simulation/new')}>
          Run again with current settings
        </button>
        <Link to="/site" className="btn">
          Back to site
        </Link>
      </SimMessage>
    );
  }

  const ts = shown?.timeseries;
  if (!shown || !ts) {
    return <SimMessage title="No time series in this result" detail="Re-run the simulation with includeTimeseries: true." />;
  }

  const sky = skyAt(ts, Math.min(t, windowDays - (ts.stepMin / 1440) * 1.01));
  const siteName = shown.site.name ?? (SITES.find((s) => Math.abs(s.lat - shown.site.lat) < 1e-6 && Math.abs(s.lon - shown.site.lon) < 1e-6)?.name ?? 'Custom point');
  const realPct = base && baseIsReal ? base.summary.successPct : null;
  const flatPct = base?.summary.flatHorizonSuccessPct ?? null;

  return (
    <main className="sim-page">
      <div className="sim-toolbar">
        <nav aria-label="Breadcrumb" className="breadcrumb">
          <Link to="/">Moon</Link>
          <span aria-hidden="true">/</span>
          <Link to={`/site${toQuery(shown.site)}`}>{siteName}</Link>
          <span aria-hidden="true">/</span>
          <span>Simulation</span>
        </nav>
        <div className="segmented" role="group" aria-label="View">
          <button type="button" aria-pressed={view === '3d'} onClick={() => setView('3d')}>
            3D scene
          </button>
          <button type="button" aria-pressed={view === 'sky'} onClick={() => setView('sky')}>
            Sky 360°
          </button>
        </div>
        <div className="segmented" role="group" aria-label="Horizon model">
          <button type="button" aria-pressed={!showFlat && baseIsReal} disabled={!baseIsReal} onClick={() => toggleHorizon(false)} title={baseIsReal ? '' : 'This run used a flat horizon — run again for real terrain'}>
            Real terrain (LOLA)
          </button>
          <button type="button" aria-pressed={showFlat || !baseIsReal} onClick={() => toggleHorizon(true)}>
            {flatLoading ? 'Flat horizon…' : 'Flat horizon'}
          </button>
        </div>
        {view === '3d' && (
          <div className="segmented" role="group" aria-label="Camera">
            {(['orbit', 'lander', 'top'] as CameraMode[]).map((c) => (
              <button key={c} type="button" aria-pressed={camera === c} onClick={() => setCamera(c)}>
                {c === 'orbit' ? 'Orbit' : c === 'lander' ? 'Lander view' : 'Top-down'}
              </button>
            ))}
          </div>
        )}
        <div className="sim-toolbar__right">
          {(shown.mock || apiMode === 'mock') && <span className="badge badge--warn">MOCK DATA</span>}
          <Link to="/dates" className="btn">
            Compare dates
          </Link>
          <Link to="/scenarios" className="btn">
            Scenarios
          </Link>
          <button type="button" className="btn" disabled title="Mission brief — next sprint">
            Mission brief
          </button>
          <div className="segmented" role="group" aria-label="Mode">
            <button type="button" aria-pressed="true">
              Basic
            </button>
            <button type="button" aria-pressed="false" disabled title="Pro mode — next sprint">
              Pro
            </button>
          </div>
        </div>
      </div>

      <div className="sim-stage">
        {view === '3d' ? (
          <SimScene3D sky={sky} horizon={realTerrain ? horizon.data : null} realTerrain={realTerrain} camera={camera} />
        ) : (
          <SkyView ts={ts} sky={sky} horizon={realTerrain ? horizon.data : null} />
        )}
        <div className="sim-stage__site">
          <strong>{siteName}</strong>
          <span className="mono" style={{ color: 'var(--accent)' }}>
            {formatLat(shown.site.lat, 3)} · {formatLon(shown.site.lon, 3)}
          </span>
        </div>
        <div className="sim-stage__note mono">
          {view === '3d' ? `Vertical scale ×${VERTICAL_EXAGGERATION} · ` : 'True scale · '}
          {realTerrain ? (horizon.loading ? 'loading terrain horizon…' : horizon.data ? `horizon ${horizon.data.demVersion}` : 'horizon unavailable') : 'flat horizon'} · ephemeris JPL Horizons
        </div>
      </div>

      <StatusCards sky={sky} events={shown.events} t={t} reservePct={reservePct} />

      <div className="sim-bottom">
        <SuccessCard summary={shown.summary} factors={shown.factors} missionDays={missionDays} realTerrain={realTerrain} realPct={realPct} flatPct={flatPct} />
        <Timeline
          t={t}
          onT={(v) => {
            setPlaying(false);
            setT(v);
          }}
          playing={playing}
          onTogglePlay={() => {
            if (!playing && t >= windowDays - 0.01) setT(0);
            setPlaying((p) => !p);
          }}
          speed={speed}
          onSpeed={setSpeed}
          windows={shown.windows}
          windowDays={windowDays}
          missionDays={missionDays}
          soc={ts.socPct}
          reservePct={reservePct}
          landingTime={shown.input.landingTime ?? new Date().toISOString()}
        />
      </div>
    </main>
  );
}

/* ---------- Loading & messages ---------- */

const STEPS = [
  { at: 0, label: 'Sending the mission to the backend' },
  { at: 2, label: 'Sun & Earth positions from JPL Horizons' },
  { at: 6, label: 'Terrain horizon from the LOLA DEM (first run for a site ≈ 40 s)' },
  { at: 30, label: 'Visibility windows, battery and score' },
];

function SimLoading({ name, realTerrain, short = false }: { name: string; realTerrain: boolean; short?: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - start) / 1000), 250);
    return () => clearInterval(timer);
  }, []);
  const steps = STEPS.filter((s) => realTerrain || !s.label.startsWith('Terrain'));
  return (
    <main className="sim-message" aria-busy="true">
      <div className="sim-message__card">
        <span className="eyebrow">{short ? 'Loading' : 'Running simulation'}</span>
        <h1 className="sim-message__title">{name}</h1>
        <div className="progress" aria-hidden="true">
          <span />
        </div>
        {!short && (
          <ol className="sim-steps">
            {steps.map((s, i) => {
              const done = steps[i + 1] ? elapsed >= steps[i + 1].at : false;
              const active = elapsed >= s.at && !done;
              return (
                <li key={s.label} className={done ? 'is-done' : active ? 'is-active' : ''}>
                  <span aria-hidden="true">{done ? '✓' : active ? '●' : '○'}</span> {s.label}
                </li>
              );
            })}
          </ol>
        )}
        <span className="mono muted">{elapsed.toFixed(0)} s</span>
      </div>
    </main>
  );
}

function SimMessage({ title, detail, code, children }: { title: string; detail: string; code?: string; children?: ReactNode }) {
  return (
    <main className="sim-message">
      <div className="sim-message__card" role="alert">
        <span className="eyebrow">{code ?? 'Simulation'}</span>
        <h1 className="sim-message__title">{title}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {detail}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>{children}</div>
      </div>
    </main>
  );
}
