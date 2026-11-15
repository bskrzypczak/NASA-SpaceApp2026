import { Link, useNavigate } from 'react-router-dom';
import { CoordinateBar } from '../components/CoordinateBar';
import { Moon3D } from '../components/moon/Moon3D';
import { useSelection } from '../store/selection';
import { SITES, FEATURED_IDS } from '../data/sites';
import { toQuery, type LatLon } from '../lib/coords';
import { useApi } from '../hooks/useApi';
import { getQuickTerrain } from '../api/client';

/** Screen 1 — pick a point on the Moon. */
export function ExplorePage() {
  const navigate = useNavigate();
  const { lat, lon, selectSite } = useSelection();
  const featured = SITES.filter((s) => FEATURED_IDS.includes(s.id));
  const terrain = useApi((signal) => getQuickTerrain(lat, lon, signal), [lat, lon], { debounceMs: 300 });
  const elevationM = terrain.loading ? undefined : (terrain.data?.elevationM ?? null);

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

          <section className="panel" aria-label="Featured sites" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span className="eyebrow">Featured sites</span>
            <div className="chips">
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
            <span className="muted" style={{ fontSize: 13 }}>
              Pick one to move the pin, or click anywhere on the Moon.
            </span>
          </section>

          <Link to="/catalog" className="btn" style={{ alignSelf: 'flex-start' }}>
            Browse all {SITES.length} sites →
          </Link>
        </div>

        <Moon3D style={{ flex: '999 1 560px', minHeight: 560 }} />
      </div>

      <CoordinateBar value={{ lat, lon }} onNext={goToSite} elevationM={elevationM} />
    </main>
  );
}
