import { useEffect, useState, type FormEvent } from 'react';
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { SiteMap } from '../components/site/SiteMap';
import { MissionForm } from '../components/site/MissionForm';
import { useSelection } from '../store/selection';
import { useApi } from '../hooks/useApi';
import { apiMode, getTerrainPoint } from '../api/client';
import { SITES } from '../data/sites';
import { formatLat, formatLon, fromQuery, parseLat, parseLon, toQuery } from '../lib/coords';

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

  const terrain = useApi((signal) => getTerrainPoint(lat, lon, signal), [lat, lon]);
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
        </nav>

        <div>
          <span className="eyebrow">Landing site{site ? ` · ${site.program}` : ''}</span>
          <h1 className="site-page__title">{title}</h1>
          {site && <p className="muted" style={{ margin: '6px 0 0' }}>{site.status} · coordinates approximate</p>}
        </div>

        <CoordinateEditor lat={lat} lon={lon} onApply={(p) => selectSite({ ...p, name: null })} />

        <dl className="details">
          <div>
            <dt>Elevation</dt>
            <dd>{valueOrDash(terrain.data?.elevationM, (v) => `${Math.round(v).toLocaleString('en-US')} m`, terrain.loading)}</dd>
          </div>
          <div>
            <dt>Slope</dt>
            <dd title="Backend does not compute slope yet">{valueOrDash(terrain.data?.slopeDeg, (v) => `${v.toFixed(1)}°`, terrain.loading)}</dd>
          </div>
          <div>
            <dt>Permanent shadow</dt>
            <dd title="PSR map not wired in yet">
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
                  : terrain.error
                    ? 'error'
                    : '…'}
            </dd>
          </div>
        </dl>
        {terrain.error && <p className="error" style={{ margin: 0 }}>{terrain.error.message}</p>}

        <MissionForm />

        <button type="button" className="btn nearby-link" disabled title="Sensitivity map — next sprint">
          <span>◎ See better places nearby</span>
          <span className="mono muted" style={{ textTransform: 'none', letterSpacing: 0 }}>coming soon</span>
        </button>

        <button
          type="button"
          className="btn btn--primary btn--lg"
          onClick={() => navigate(`/site/confirm${toQuery({ lat: +lat.toFixed(5), lon: +lon.toFixed(5) })}`)}
        >
          ▶ Start simulation
        </button>
        <p className="muted" style={{ margin: '-12px 0 0', fontSize: 13, textAlign: 'center' }}>
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
      <div className="coord-editor__foot">
        <span className="mono" style={{ color: 'var(--accent)', fontSize: 13 }}>
          {formatLat(lat, 4)} · {formatLon(lon, 4)}
        </span>
        <button type="submit" className="btn" disabled={!changed} style={{ minHeight: 40, padding: '0 14px', fontSize: 12 }}>
          Apply
        </button>
      </div>
      {(pLat === null || pLon === null) && (
        <span className="error" role="alert">
          Latitude −90…90, longitude −180…360.
        </span>
      )}
    </form>
  );
}
