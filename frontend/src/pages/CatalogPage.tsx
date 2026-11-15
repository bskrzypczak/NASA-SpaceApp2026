import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SITE_GROUPS, type SiteGroup } from '../data/sites';
import type { ApiSite } from '../api/types';
import { getSites } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useSelection } from '../store/selection';
import { formatLat, formatLon, toQuery } from '../lib/coords';

type Filter = 'All' | SiteGroup;

/** Screen 2 — every notable landing site, with filters. */
export function CatalogPage() {
  const navigate = useNavigate();
  const selectSite = useSelection((s) => s.selectSite);
  const [filter, setFilter] = useState<Filter>('All');
  const [query, setQuery] = useState('');
  const [latIn, setLatIn] = useState('');
  const [lonIn, setLonIn] = useState('');
  const [coordError, setCoordError] = useState<string | null>(null);

  const sites = useApi((signal) => getSites(signal), []);
  const all = sites.data?.items ?? [];
  const q = query.trim().toLowerCase();
  const rows = all.filter(
    (s) => (filter === 'All' || s.group === filter) && (!q || `${s.name} ${s.program} ${s.status} ${s.region}`.toLowerCase().includes(q)),
  );

  function openCoords(e: React.FormEvent) {
    e.preventDefault();
    const la = Number(latIn.replace(',', '.'));
    const lo = Number(lonIn.replace(',', '.'));
    if (!latIn.trim() || !Number.isFinite(la) || la < -90 || la > 90) return setCoordError('Latitude must be between −90 and 90 (south is negative).');
    if (!lonIn.trim() || !Number.isFinite(lo) || lo < -180 || lo > 360) return setCoordError('Longitude must be between −180 and 360 (west is negative).');
    setCoordError(null);
    const lon180 = lo > 180 ? lo - 360 : lo;
    selectSite({ lat: la, lon: lon180, name: null });
    navigate(`/site${toQuery({ lat: la, lon: lon180 })}`);
  }
  const filters: Filter[] = ['All', ...SITE_GROUPS];

  function open(site: ApiSite) {
    selectSite({ lat: site.lat, lon: site.lon, name: site.name });
    navigate(`/site${toQuery(site)}`);
  }

  return (
    <main className="page">
      <div>
        <h1 className="hero-title" style={{ fontSize: 36 }}>Site catalog</h1>
        <p className="muted" style={{ margin: '8px 0 0' }}>
          Apollo sites, Artemis III candidate regions, CLPS and commercial landers, and missions from other agencies.
        </p>
      </div>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <aside style={{ flex: '1 1 260px', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="eyebrow" style={{ paddingBottom: 8 }}>Program</legend>
            <div className="chips">
              {filters.map((f) => (
                <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {f} <span className="mono" style={{ fontWeight: 400 }}>{f === 'All' ? all.length : all.filter((s) => s.group === f).length}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="field">
            <label htmlFor="catalog-search" className="eyebrow">
              Search
            </label>
            <input id="catalog-search" type="search" placeholder="Name, program, region…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <form className="panel" onSubmit={openCoords} style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-label="Open custom coordinates" noValidate>
            <span className="eyebrow">Custom coordinates</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <div className="field" style={{ flex: 1, minWidth: 0 }}>
                <label htmlFor="catalog-lat">Lat °</label>
                <input id="catalog-lat" style={{ width: "100%", minWidth: 0 }} inputMode="decimal" placeholder="-89.45" value={latIn} onChange={(e) => setLatIn(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 0 }}>
                <label htmlFor="catalog-lon">Lon °</label>
                <input id="catalog-lon" style={{ width: "100%", minWidth: 0 }} inputMode="decimal" placeholder="-137.3" value={lonIn} onChange={(e) => setLonIn(e.target.value)} />
              </div>
            </div>
            {coordError && (
              <p className="error" role="alert" style={{ margin: 0 }}>
                ! {coordError}
              </p>
            )}
            <button type="submit" className="btn btn--primary">
              Open site →
            </button>
          </form>
        </aside>

        <section style={{ flex: '999 1 640px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <strong>{sites.loading ? 'Loading…' : `${rows.length} sites`}</strong>
            <span className="muted" style={{ fontSize: 13 }}>
              Source: LROC QuickMap
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Site</th>
                  <th scope="col">Program</th>
                  <th scope="col">Status</th>
                  <th scope="col">Lat</th>
                  <th scope="col">Lon</th>
                  <th scope="col">Region</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 700 }}>
                      {s.name}
                      {s.coordsVerified === false && (
                        <span className="muted" title="Coordinates not verified yet" style={{ marginLeft: 6, fontWeight: 400 }}>
                          ≈
                        </span>
                      )}
                    </td>
                    <td>{s.program}</td>
                    <td className="muted">{s.status}</td>
                    <td className="mono">{formatLat(s.lat)}</td>
                    <td className="mono">{formatLon(s.lon)}</td>
                    <td>{s.region}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button type="button" className="btn" style={{ minHeight: 40, padding: '0 14px', fontSize: 12 }} onClick={() => open(s)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
