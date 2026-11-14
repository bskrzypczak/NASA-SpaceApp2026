import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Placeholder } from '../components/Placeholder';
import { SITES, SITE_GROUPS, type SiteGroup, type CatalogSite } from '../data/sites';
import { useSelection } from '../store/selection';
import { formatLat, formatLon, toQuery } from '../lib/coords';

type Filter = 'All' | SiteGroup;

/** Screen 2 — every notable landing site, with filters. */
export function CatalogPage() {
  const navigate = useNavigate();
  const selectSite = useSelection((s) => s.selectSite);
  const [filter, setFilter] = useState<Filter>('All');

  const rows = SITES.filter((s) => filter === 'All' || s.group === filter);
  const filters: Filter[] = ['All', ...SITE_GROUPS];

  function open(site: CatalogSite) {
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
                  {f} <span className="mono" style={{ fontWeight: 400 }}>{f === 'All' ? SITES.length : SITES.filter((s) => s.group === f).length}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <Placeholder label="Search + custom coordinates" note="Text search over names and agencies, and a lat/lon form." tag="CatalogSearch · next" minHeight={160} />
        </aside>

        <section style={{ flex: '999 1 640px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <strong>{rows.length} sites</strong>
            <span className="muted" style={{ fontSize: 13 }}>Placeholder data · coordinates approximate, verify in LROC QuickMap</span>
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
                    <td style={{ fontWeight: 700 }}>{s.name}</td>
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
