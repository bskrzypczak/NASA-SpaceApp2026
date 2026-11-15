import { useEffect, useState, type FormEvent } from 'react';
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { SiteMap } from '../components/site/SiteMap';
import { MissionForm } from '../components/site/MissionForm';
import { useSelection } from '../store/selection';
import { useApi } from '../hooks/useApi';
import { apiMode, getQuickTerrain, getTerrainPoint } from '../api/client';
import { SITES } from '../data/sites';
import { formatLat, formatLon, fromQuery, parseLat, parseLon, toQuery } from '../lib/coords';
import './SitePage.css';

/** Screen 3 — the chosen landing point. The confirm popup (screen 4) renders in the <Outlet />. */
export function SitePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const { lat, lon, name, selectSite } = useSelection();

  // URL → store (shared links, reloads).
  useEffect(() => {
    const fromUrl = fromQuery(params);
    if (fromUrl && (fromUrl.lat !== lat || fromUrl.lon !== lon)) selectSite({ ...fromUrl, name: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Store → URL (pin moved on the map, coordinates edited).
  useEffect(() => {
    const fromUrl = fromQuery(params);
    if (!fromUrl || fromUrl.lat !== lat || fromUrl.lon !== lon) {
      navigate(`${location.pathname}${toQuery({ lat: +lat.toFixed(5), lon: +lon.toFixed(5) })}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lon]);

  // Progressive: elevation arrives from a tiny heightmap first; slope + PSR from /terrain/point when it is ready.
  const [retry, setRetry] = useState(0);
  const quick = useApi((signal) => getQuickTerrain(lat, lon, signal), [lat, lon, retry], { debounceMs: 300 });
  const terrain = useApi((signal) => getTerrainPoint(lat, lon, signal), [lat, lon, retry], { debounceMs: 300 });
  const elevationM = terrain.data?.elevationM ?? quick.data?.elevationM;
  const elevationLoading = elevationM == null && (quick.loading || terrain.loading);
  const approxSlope = terrain.data?.slopeDeg == null ? quick.data?.slopeDeg : null;
  const site = SITES.find((s) => s.name === name);
  const title = name ?? 'Custom point';

  return (
    <main className="site-page">
      <div className="site-page__map">
        <SiteMap lat={lat} lon={lon} onPick={() => {}} hidePinLabel={location.pathname.endsWith('/confirm')} />
      </div>

      <aside className="site-page__panel" aria-label="Landing site and simulation setup">
        <nav aria-label="Breadcrumb" className="breadcrumb">
          <Link to="/">Moon</Link>
          <span aria-hidden="true">/</span>
          <span>{site?.region ?? (lat <= -80 ? 'South pole' : 'Custom')}</span>
          {site && (
            <>
              <span aria-hidden="true">·</span>
              <span>{site.program}</span>
            </>
          )}
        </nav>

        <div>
          <h1 className="site-page__title">{title}</h1>
          {site && <p className="muted" style={{ margin: '6px 0 0' }}>{site.status} · coordinates approximate</p>}
        </div>

        <CoordinateEditor lat={lat} lon={lon} onApply={(p) => selectSite({ ...p, name: null })} />

        <dl className="details">
          <div>
            <dt>Elevation</dt>
            <dd>{valueOrDash(elevationM, (v) => `${Math.round(v).toLocaleString('en-US')} m`, elevationLoading)}</dd>
          </div>
          <div>
            <dt>Slope</dt>
            <dd title={approxSlope != null ? 'Approximate, from a 5 km terrain grid. Precise value comes from /terrain/point.' : undefined}>
              {terrain.data?.slopeDeg != null
                ? `${terrain.data.slopeDeg.toFixed(1)}°`
                : approxSlope != null
                  ? `≈ ${approxSlope.toFixed(1)}°${terrain.loading ? ' …' : ''}`
                  : valueOrDash(null, String, terrain.loading || quick.loading)}
            </dd>
          </div>
          <div>
            <dt>Permanent shadow</dt>
            <dd>
              {terrain.loading ? '…' : terrain.data?.inPermanentShadow == null ? '—' : terrain.data.inPermanentShadow ? 'Yes' : 'No'}
            </dd>
          </div>
          <div>
            <dt>Terrain data</dt>
            <dd>
              {terrain.data
                ? terrain.data.demCoverage
                  ? `LOLA ${terrain.data.demResolutionM ?? '?'} m/px`
                  : 'outside DEM coverage'
                : apiMode === 'offline'
                  ? 'backend not connected'
                  : quick.data
                    ? `LOLA ${quick.data.demResolutionM ?? '?'} m/px${terrain.loading ? ' · details loading…' : ''}`
                    : terrain.error
                      ? 'error'
                      : '…'}
            </dd>
          </div>
        </dl>
        {terrain.data?.complete === false && !terrain.error && (
          <p className="muted" role="status" style={{ margin: 0, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>! NASA services were slow: slope or shadow data is missing for now.</span>
            <button type="button" className="btn" onClick={() => setRetry((n) => n + 1)}>
              ↻ Retry
            </button>
          </p>
        )}
        {terrain.error && (
          <p className="error" role="status" style={{ margin: 0, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>
              ! {quick.data ? 'Slope and shadow details unavailable' : 'Terrain unavailable'}: {terrain.error.message}
            </span>
            <button type="button" className="btn" onClick={() => setRetry((n) => n + 1)}>
              ↻ Retry
            </button>
          </p>
        )}

        <MissionForm />
        <div className="site-page__links">
          <Link to="/dates" className="btn site-page__link">
            <span aria-hidden="true">📅</span> Compare dates
          </Link>
          <Link to="/nearby" className="btn site-page__link">
            <span aria-hidden="true">◎</span> Nearby sites
          </Link>
        </div>

        <button
          type="button"
          className="btn btn--primary btn--lg"
          onClick={() => navigate(`/site/confirm${toQuery({ lat: +lat.toFixed(5), lon: +lon.toFixed(5) })}`)}
        >
          ▶ Start simulation
        </button>
        <p className="muted" style={{ margin: '-6px 0 0', fontSize: 12, textAlign: 'center' }}>
          Sun &amp; Earth from JPL Horizons · terrain from LOLA
        </p>
      </aside>

      <Outlet />
    </main>
  );
}

function valueOrDash<T>(v: T | null | undefined, fmt: (v: T) => string, loading: boolean) {
  if (loading) return '…';
  return v === null || v === undefined ? '—' : fmt(v);
}

/** Editable lat/lon with Apply (Enter works too). */
function CoordinateEditor({ lat, lon, onApply }: { lat: number; lon: number; onApply: (p: { lat: number; lon: number }) => void }) {
  const [latText, setLatText] = useState(lat.toFixed(4));
  const [lonText, setLonText] = useState(lon.toFixed(4));

  useEffect(() => {
    setLatText(lat.toFixed(4));
    setLonText(lon.toFixed(4));
  }, [lat, lon]);

  const pLat = parseLat(latText);
  const pLon = parseLon(lonText);
  const changed = pLat !== null && pLon !== null && (Math.abs(pLat - lat) > 1e-9 || Math.abs(pLon - lon) > 1e-9);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pLat !== null && pLon !== null) onApply({ lat: pLat, lon: pLon });
  }

  return (
    <form onSubmit={submit} className="coord-editor" aria-label="Edit coordinates">
      <label className="field">
        <span className="eyebrow">Latitude</span>
        <input inputMode="decimal" value={latText} onChange={(e) => setLatText(e.target.value)} aria-invalid={pLat === null} />
      </label>
      <label className="field">
        <span className="eyebrow">Longitude</span>
        <input inputMode="decimal" value={lonText} onChange={(e) => setLonText(e.target.value)} aria-invalid={pLon === null} />
      </label>
      <button type="submit" className="btn coord-editor__apply" disabled={!changed}>
        Apply
      </button>
      <span className="mono coord-editor__fmt">
        {formatLat(lat, 4)} · {formatLon(lon, 4)}
      </span>
      {(pLat === null || pLon === null) && (
        <span className="error" role="alert">
          Latitude −90…90, longitude −180…360.
        </span>
      )}
    </form>
  );
}
