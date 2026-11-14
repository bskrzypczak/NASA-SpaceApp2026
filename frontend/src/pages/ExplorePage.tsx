import { Link, useNavigate } from 'react-router-dom';
import { Placeholder } from '../components/Placeholder';
import { CoordinateBar } from '../components/CoordinateBar';
import { useSelection } from '../store/selection';
import { SITES, FEATURED_IDS } from '../data/sites';
import { toQuery, type LatLon } from '../lib/coords';

/** Screen 1 — pick a point on the Moon. */
export function ExplorePage() {
  const navigate = useNavigate();
  const { lat, lon, selectSite } = useSelection();
  const featured = SITES.filter((s) => FEATURED_IDS.includes(s.id));

  function goToSite(point: LatLon) {
    // A point typed by hand is a custom site unless it matches the current one.
    const same = point.lat === lat && point.lon === lon;
    if (!same) selectSite({ ...point, name: null });
    navigate(`/site${toQuery(point)}`);
  }

  return (
    <main className="page page--gradient">
      <div className="row" style={{ alignItems: 'stretch' }}>
        <div style={{ flex: '1 1 340px', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <h1 className="hero-title">Where should we land?</h1>
            <p style={{ margin: '12px 0 0', fontSize: 20 }}>Pick any point on the Moon.</p>
            <p style={{ margin: 0, fontSize: 20, color: 'var(--accent)' }}>See when it gets sunlight and when it can call Earth.</p>
          </div>

          <Placeholder
            label="Featured sites table"
            note="Short list of notable sites. Clicking a row will fly the 3D camera to it."
            tag="FeaturedSites · next"
            minHeight={240}
          >
            <div className="chips" style={{ justifyContent: 'center', marginTop: 8 }}>
              {featured.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="chip"
                  aria-pressed={s.lat === lat && s.lon === lon}
                  onClick={() => selectSite({ lat: s.lat, lon: s.lon, name: s.name })}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </Placeholder>

          <Link to="/catalog" className="btn" style={{ alignSelf: 'flex-start' }}>
            Browse all {SITES.length} sites →
          </Link>
        </div>

        <Placeholder
          label="3D Moon model"
          note="Rotatable, zoomable Moon (LROC texture + LOLA terrain). Click the surface to drop a pin and update LAT / LON below."
          tag="react-three-fiber · next"
          minHeight={520}
          style={{ flex: '999 1 560px' }}
        />
      </div>

      <CoordinateBar value={{ lat, lon }} onNext={goToSite} />
      <p className="muted" style={{ textAlign: 'center', margin: 0, fontSize: 14 }}>
        Drag to rotate · Scroll to zoom · Click the surface to pick a point
      </p>
    </main>
  );
}
