import { Link } from 'react-router-dom';
import type { DayWindow, ScoreFactor, SimEvent, SimSummary } from '../../api/types';
import type { SkyState } from '../../lib/sky';
import './sim.css';

const RED = 'var(--danger-text)';

export function formatSpan(days: number | null): string {
  if (days === null) return 'beyond window';
  const d = Math.floor(days);
  const h = Math.round((days - d) * 24);
  return h === 24 ? `${d + 1} d 0 h` : `${d} d ${h} h`;
}

const sign = (v: number, digits = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}°`;

/** Days until the next event of one of `types` after t (null if none in the window). */
export function untilNext(events: SimEvent[], types: SimEvent['type'][], t: number): number | null {
  const e = events.find((x) => types.includes(x.type) && x.day > t + 1e-6);
  return e ? e.day - t : null;
}

/* ---------- Status cards: Sun / Earth / Battery ---------- */

export function StatusCards({ sky, events, t, reservePct }: { sky: SkyState; events: SimEvent[]; t: number; reservePct: number }) {
  const sunUp = sky.sunFrac > 0;
  const earthUp = sky.earthVisible;
  const low = sky.soc < reservePct;
  const charging = sunUp && sky.sunFrac > 0;
  return (
    <div className="sim-cards">
      <section className={`sim-card${sunUp ? ' is-sun' : ' is-blocked'}`} aria-label="Sun">
        <header>
          <SunIcon />
          <span className="eyebrow">Sun</span>
          <span className="sim-card__state" style={{ color: sunUp ? 'var(--sun)' : RED }}>
            {sunUp ? `✓ Sunlit${sky.sunFrac < 1 ? ` · ${Math.round(sky.sunFrac * 100)} % disk` : ''}` : '✕ Blocked'}
          </span>
        </header>
        <div className="sim-card__grid">
          <div>
            <span className="muted">Elevation</span>
            <strong className="sim-card__big" style={{ color: 'var(--sun)' }}>{sign(sky.sunEl)}</strong>
            <span className="mono muted">{sign(sky.sunEl - sky.sunMask)} vs terrain</span>
          </div>
          <div>
            <span className="muted">{sunUp ? 'To sunset' : 'To sunrise'}</span>
            <strong className="sim-card__big">{formatSpan(untilNext(events, [sunUp ? 'SUNSET' : 'SUNRISE'], t))}</strong>
            <span className="mono muted">az {sky.sunAz.toFixed(1)}°</span>
          </div>
        </div>
      </section>

      <section className={`sim-card${earthUp ? ' is-earth' : ' is-blocked'}`} aria-label="Earth link">
        <header>
          <EarthIcon />
          <span className="eyebrow">Earth link</span>
          <span className="sim-card__state" style={{ color: earthUp ? 'var(--earth)' : RED }}>
            {earthUp ? '✓ In view' : '✕ Blocked'}
          </span>
        </header>
        <div className="sim-card__grid">
          <div>
            <span className="muted">Elevation</span>
            <strong className="sim-card__big" style={{ color: 'var(--earth)' }}>{sign(sky.earthEl)}</strong>
            <span className="mono muted">{sign(sky.earthEl - sky.earthMask)} vs terrain</span>
          </div>
          <div>
            <span className="muted">{earthUp ? 'To Earthset' : 'To Earthrise'}</span>
            <strong className="sim-card__big">{formatSpan(untilNext(events, [earthUp ? 'EARTHSET' : 'EARTHRISE'], t))}</strong>
            <span className="mono muted">az {sky.earthAz.toFixed(1)}°</span>
          </div>
        </div>
      </section>

      <section className={`sim-card${low ? ' is-blocked' : ''}`} aria-label="Battery">
        <header>
          <BatteryIcon />
          <span className="eyebrow">Battery</span>
          <span className="sim-card__state" style={{ color: low ? RED : charging ? 'var(--sun)' : 'var(--text)' }}>
            {low ? '! Below reserve' : charging ? '↑ Charging' : '↓ Draining'}
          </span>
        </header>
        <div className="sim-card__battery">
          <strong className="sim-card__big">{Math.round(sky.soc)} %</strong>
          <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(sky.soc)} aria-label="State of charge">
            <span style={{ width: `${sky.soc}%`, background: low ? RED : 'var(--white)' }} />
            <i style={{ left: `${reservePct}%` }} title={`${reservePct} % reserve`} />
          </div>
        </div>
      </section>
    </div>
  );
}

/* ---------- Success estimate ---------- */

const FACTOR_LABEL: Record<ScoreFactor['key'], (v: number) => string> = {
  power: (v) => `battery bottoms out at ${Math.round(v)} %`,
  comms: (v) => `Earth in view ${Math.round(v)} % of the mission`,
  night: (v) => `longest night ${Math.round(v)} h`,
};
const FACTOR_TITLE: Record<ScoreFactor['key'], string> = { power: 'Power reserve', comms: 'Earth contact', night: 'Longest night' };

export function SuccessCard({
  summary,
  factors,
  missionDays,
  realTerrain,
  realPct,
  flatPct,
}: {
  summary: SimSummary;
  factors: ScoreFactor[];
  missionDays: number;
  realTerrain: boolean;
  realPct: number | null;
  flatPct: number | null;
}) {
  const s = summary.successPct;
  const color = s >= 80 ? 'var(--earth)' : s >= 60 ? 'var(--white)' : RED;
  const circ = 2 * Math.PI * 46;
  const delta = realPct !== null && flatPct !== null ? flatPct - realPct : null;
  return (
    <section className="panel sim-success" aria-label="Mission success estimate">
      <span className="eyebrow">Mission success estimate</span>
      <div className="sim-success__head">
        <svg width="112" height="112" viewBox="0 0 112 112" role="img" aria-label={`${s} percent`}>
          <circle cx="56" cy="56" r="46" fill="none" stroke="#1A2A55" strokeWidth="10" />
          <circle cx="56" cy="56" r="46" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(circ * s) / 100} ${circ}`} transform="rotate(-90 56 56)" />
          <text x="56" y="65" textAnchor="middle" className="sim-success__pct">
            {s}%
          </text>
        </svg>
        <div>
          <div className="sim-success__verdict" style={{ color }}>
            {summary.verdict}
          </div>
          <div className="muted" style={{ fontSize: 14 }}>
            {missionDays}-day mission · {realTerrain ? 'real terrain (LOLA)' : 'flat horizon'}
          </div>
        </div>
      </div>
      <ul className="sim-factors">
        {factors.map((f) => (
          <li key={f.key}>
            <span className="sim-factor__icon" style={{ background: f.ok ? 'var(--earth)' : RED }} aria-hidden="true">
              {f.ok ? '✓' : '!'}
            </span>
            <span>
              <strong>{FACTOR_TITLE[f.key]}</strong> <span className="muted">{FACTOR_LABEL[f.key](f.value)}</span>
              <span className="mono muted" style={{ fontSize: 12 }}>
                {' '}
                · {f.points} / {Math.round(f.weight * 100)} pts
              </span>
            </span>
          </li>
        ))}
      </ul>
      {delta !== null && (
        <div className="sim-delta">
          {realTerrain ? (
            <>
              <strong style={{ color: 'var(--accent)' }}>Terrain costs {delta} points.</strong>{' '}
              <span className="muted">On a smooth Moon this date would score {flatPct} %. No atmosphere — the horizon is pure terrain.</span>
            </>
          ) : (
            <>
              <strong style={{ color: 'var(--accent)' }}>This is the naive answer.</strong>{' '}
              <span className="muted">With real LOLA terrain the estimate is {realPct} %.</span>
            </>
          )}
        </div>
      )}
      <Link to="/dates" className="btn btn--primary">
        Find a better date
      </Link>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        Heuristic: 0.5 power + 0.3 comms + 0.2 night length — not a probability.
      </p>
    </section>
  );
}

/* ---------- Timeline ---------- */

function segments(windows: DayWindow[], total: number) {
  const out: { w: number; on: boolean }[] = [];
  let cursor = 0;
  for (const win of windows) {
    if (win.fromDay > cursor) out.push({ w: win.fromDay - cursor, on: false });
    out.push({ w: win.toDay - win.fromDay, on: true });
    cursor = win.toDay;
  }
  if (cursor < total) out.push({ w: total - cursor, on: false });
  return out.map((s) => ({ ...s, pct: (s.w / total) * 100 }));
}

export function Timeline({
  t,
  onT,
  playing,
  onTogglePlay,
  speed,
  onSpeed,
  windows,
  windowDays,
  missionDays,
  soc,
  reservePct,
  landingTime,
}: {
  t: number;
  onT: (t: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  speed: number;
  onSpeed: (s: number) => void;
  windows: { sun: DayWindow[]; earth: DayWindow[]; both: DayWindow[] };
  windowDays: number;
  missionDays: number;
  soc: number[];
  reservePct: number;
  landingTime: string;
}) {
  const tracks = [
    { label: 'Sunlight', color: 'var(--sun)', segs: segments(windows.sun, windowDays) },
    { label: 'Earth link', color: 'var(--earth)', segs: segments(windows.earth, windowDays) },
    { label: 'Both', color: 'var(--white)', segs: segments(windows.both, windowDays) },
  ];
  const step = Math.max(1, Math.floor(soc.length / 600));
  const socPts = soc
    .filter((_, i) => i % step === 0)
    .map((v, i) => `${((i * step) / soc.length) * 1000},${10 + (100 - v) * 0.8}`)
    .join(' ');
  const landingMs = Date.parse(landingTime);
  const date = (d: number) => new Date(landingMs + d * 86_400_000).toISOString().slice(5, 10);
  const now = new Date(landingMs + t * 86_400_000).toISOString().slice(0, 16).replace('T', ' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * windowDays));

  return (
    <section className="sim-timeline" aria-label="Timeline">
      <div className="sim-timeline__controls">
        <button type="button" className="play-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={onTogglePlay}>
          {playing ? (
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
              <rect x="4" y="3" width="4" height="14" fill="#07173F" />
              <rect x="12" y="3" width="4" height="14" fill="#07173F" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 3 L17 10 L5 17 Z" fill="#07173F" />
            </svg>
          )}
        </button>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="eyebrow">Simulated time (UTC)</span>
          <span className="mono" style={{ fontSize: 17 }}>
            {now} · day {t.toFixed(1)}
          </span>
        </div>
        <div className="segmented" role="group" aria-label="Playback speed" style={{ marginLeft: 'auto' }}>
          {[1, 6, 24].map((s) => (
            <button key={s} type="button" aria-pressed={speed === s} onClick={() => onSpeed(s)}>
              {s === 24 ? '1 d/s' : `${s} h/s`}
            </button>
          ))}
        </div>
      </div>

      <input
        type="range"
        min={0}
        max={windowDays}
        step={0.01}
        value={t}
        onChange={(e) => onT(parseFloat(e.target.value))}
        aria-label="Time since landing in days"
        className="sim-timeline__range"
      />

      {tracks.map((tr) => (
        <div key={tr.label} className="sim-track">
          <span className="eyebrow">{tr.label}</span>
          <div className="sim-track__bar">
            {tr.segs.map((s, i) => (
              <span key={i} style={{ width: `${s.pct}%`, background: s.on ? tr.color : 'transparent' }} />
            ))}
            <i style={{ left: `${(t / windowDays) * 100}%` }} />
          </div>
        </div>
      ))}

      <div className="sim-track">
        <span className="eyebrow">Battery</span>
        <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="sim-battery" role="img" aria-label="Battery state of charge over the window">
          <line x1="0" x2="1000" y1={10 + (100 - reservePct) * 0.8} y2={10 + (100 - reservePct) * 0.8} stroke="#FF7A4D" strokeWidth="1.5" strokeDasharray="6 5" vectorEffect="non-scaling-stroke" />
          <line x1={(missionDays / windowDays) * 1000} x2={(missionDays / windowDays) * 1000} y1="0" y2="100" stroke="rgba(255,255,255,0.5)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
          <polyline points={socPts} fill="none" stroke="#FFFFFF" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
          <line x1={(t / windowDays) * 1000} x2={(t / windowDays) * 1000} y1="0" y2="100" stroke="#EAFE07" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>

      <div className="sim-ticks mono muted">
        {ticks.map((d) => (
          <span key={d}>
            {date(d)}
            {d === missionDays ? ' · end' : ''}
          </span>
        ))}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13, paddingLeft: 108 }}>
        Red dashed line: {reservePct} % reserve · dashed white: mission end (day {missionDays}).
      </p>
    </section>
  );
}

/* ---------- Icons ---------- */
function SunIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="11" cy="11" r="5" fill="#EAFE07" />
      <path d="M11 1v3M11 18v3M1 11h3M18 11h3M3.9 3.9l2.1 2.1M16 16l2.1 2.1M3.9 18.1L6 16M16 6l2.1-2.1" stroke="#EAFE07" strokeWidth="2" />
    </svg>
  );
}
function EarthIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="11" cy="11" r="8" fill="none" stroke="#2E96F5" strokeWidth="2" />
      <path d="M3 11h16M11 3c3 3 3 13 0 16M11 3c-3 3-3 13 0 16" fill="none" stroke="#2E96F5" strokeWidth="1.5" />
    </svg>
  );
}
function BatteryIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 22 22" aria-hidden="true">
      <rect x="2" y="6" width="16" height="10" rx="2" fill="none" stroke="#FFFFFF" strokeWidth="2" />
      <rect x="18.5" y="9" width="2" height="4" fill="#FFFFFF" />
    </svg>
  );
}
