import { useEffect } from 'react';
import { Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import { Placeholder } from '../components/Placeholder';
import { useSelection } from '../store/selection';
import { formatLat, formatLon, fromQuery, toQuery } from '../lib/coords';

/** Screen 3 — the chosen landing point. The confirm popup (screen 4) renders in the <Outlet />. */
export function SitePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { lat, lon, name, selectSite } = useSelection();

  // The URL wins: lets people share or reload /site?lat=..&lon=..
  useEffect(() => {
    const fromUrl = fromQuery(params);
    if (fromUrl && (fromUrl.lat !== lat || fromUrl.lon !== lon)) {
      selectSite({ ...fromUrl, name: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const title = name ?? 'Custom point';

  return (
    <main className="page" style={{ maxWidth: 'none', padding: 0, gap: 0 }}>
      <div className="row" style={{ gap: 0, flex: 1, alignItems: 'stretch' }}>
        <div style={{ flex: '999 1 640px', minWidth: 0, padding: 24, display: 'flex' }}>
          <Placeholder
            label="Zoomed terrain map with pin"
            note="Google-Maps-style zoom on the selected point, with map layers: sunlight, Earth visibility, permanent shadow, slope."
            tag="SiteMap · next"
            minHeight={560}
            style={{ flex: 1 }}
          >
            <div className="panel" style={{ marginTop: 16, borderColor: 'var(--accent)' }}>
              <div style={{ fontWeight: 700 }}>{title}</div>
              <div className="mono" style={{ color: 'var(--accent)' }}>
                {formatLat(lat, 4)} · {formatLon(lon, 4)}
              </div>
            </div>
          </Placeholder>
        </div>

        <aside
          aria-label="Simulation setup"
          style={{ flex: '1 1 360px', maxWidth: 440, padding: 32, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 24 }}
        >
          <div>
            <span className="eyebrow">Landing site</span>
            <h1 style={{ fontWeight: 900, fontSize: 32, letterSpacing: '0.03em', textTransform: 'uppercase', marginTop: 6 }}>{title}</h1>
          </div>

          <dl className="details">
            <div>
              <dt>Latitude</dt>
              <dd data-testid="site-lat">{lat.toFixed(4)}° ({formatLat(lat)})</dd>
            </div>
            <div>
              <dt>Longitude</dt>
              <dd data-testid="site-lon">{lon.toFixed(4)}° ({formatLon(lon)})</dd>
            </div>
            <div>
              <dt>Elevation</dt>
              <dd className="muted">— m (LOLA, next)</dd>
            </div>
          </dl>

          <Placeholder label="Landing date + mission length" note="Date/time picker (UTC) and 3 / 7 / 14 / 30-day selector." tag="MissionForm · next" minHeight={140} />
          <Placeholder label="See better places nearby" note="Link to the sensitivity map." tag="Nearby · later" minHeight={80} />

          <button type="button" className="btn btn--primary btn--lg" onClick={() => navigate(`/site/confirm${toQuery({ lat, lon })}`)}>
            ▶ Start simulation
          </button>
        </aside>
      </div>

      <Outlet />
    </main>
  );
}
