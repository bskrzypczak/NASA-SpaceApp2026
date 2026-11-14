import { useRef, useState } from 'react';
import { ImageryView, type ImageryApi } from './ImageryView';
import { TerrainView } from './TerrainView';
import { useApi } from '../../hooks/useApi';
import { apiMode, getHeightmap, getLayers } from '../../api/client';
import type { LayerId } from '../../api/types';
import { formatLat, formatLon, type LatLon } from '../../lib/coords';

type View = 'imagery' | 'terrain';
const TERRAIN_SIZES_KM = [5, 10, 20, 40];

/** Pick a round scale-bar length that is ~90–160 px long. */
function scaleBar(viewHeightKm: number, containerPx: number) {
  const kmPerPx = viewHeightKm / Math.max(1, containerPx);
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200];
  const km = steps.find((s) => s / kmPerPx >= 90) ?? steps[steps.length - 1];
  return { km, px: km / kmPerPx };
}

/** Screen 3 map: LROC imagery close-up (works now) or LOLA shaded relief (from the backend). */
export function SiteMap({ lat, lon, onPick }: LatLon & { onPick: () => void }) {
  const [view, setView] = useState<View>('imagery');
  const [sizeKm, setSizeKm] = useState(20);
  const [viewKm, setViewKm] = useState(30);
  const [hover, setHover] = useState<LatLon | null>(null);
  const [hoverElev, setHoverElev] = useState<number | null>(null);
  const [activeLayers, setActiveLayers] = useState<Partial<Record<LayerId, boolean>>>({});
  const imageryApi = useRef<ImageryApi | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const layers = useApi((signal) => getLayers(signal), []);
  const heightmap = useApi(
    (signal) => (view === 'terrain' ? getHeightmap(lat, lon, sizeKm, 256, signal) : Promise.resolve(null)),
    [view, lat, lon, sizeKm],
  );

  const heightPx = boxRef.current?.clientHeight ?? 600;
  const bar = scaleBar(view === 'imagery' ? viewKm : sizeKm, view === 'imagery' ? heightPx : Math.min(heightPx, boxRef.current?.clientWidth ?? heightPx));

  function zoom(dir: 1 | -1) {
    if (view === 'imagery') imageryApi.current?.zoom(dir > 0 ? 0.7 : 1.4);
    else {
      const i = TERRAIN_SIZES_KM.indexOf(sizeKm);
      setSizeKm(TERRAIN_SIZES_KM[Math.max(0, Math.min(TERRAIN_SIZES_KM.length - 1, i - dir))]);
    }
  }

  return (
    <div className="site-map" ref={boxRef}>
      {view === 'imagery' ? (
        <ImageryView lat={lat} lon={lon} apiRef={imageryApi} onViewHeightKm={setViewKm} onHover={setHover} onPick={onPick} />
      ) : heightmap.data ? (
        <TerrainView data={heightmap.data} onHoverElevation={setHoverElev} />
      ) : (
        <div className="site-map__empty">
          {heightmap.loading ? (
            <span>Loading terrain…</span>
          ) : heightmap.error ? (
            <span className="error">Terrain unavailable: {heightmap.error.message}</span>
          ) : (
            <>
              <strong>Terrain view needs the backend</strong>
              <span className="muted">Set VITE_API_URL (GET /terrain/heightmap) or VITE_USE_MOCKS=true for development.</span>
            </>
          )}
        </div>
      )}

      {/* Top-left: view switch */}
      <div className="site-map__hud site-map__hud--tl">
        <div role="group" aria-label="Map view" className="segmented">
          <button type="button" aria-pressed={view === 'imagery'} onClick={() => setView('imagery')}>
            Imagery · LROC
          </button>
          <button type="button" aria-pressed={view === 'terrain'} onClick={() => setView('terrain')}>
            Terrain · LOLA
          </button>
        </div>
        {view === 'terrain' && heightmap.data?.mock && (
          <span className="badge badge--warn" title={heightmap.data.fallbackReason}>
            MOCK DATA{heightmap.data.fallbackReason ? ` · ${heightmap.data.fallbackReason}` : ''}
          </span>
        )}
        {view === 'imagery' && <span className="badge">Low-res near the pole · use Terrain for relief</span>}
      </div>

      {/* Left: zoom */}
      <div className="site-map__hud site-map__hud--zoom">
        <button type="button" className="icon-btn moon-view__btn" aria-label="Zoom in" onClick={() => zoom(1)}>
          +
        </button>
        <button type="button" className="icon-btn moon-view__btn" aria-label="Zoom out" onClick={() => zoom(-1)}>
          −
        </button>
        {view === 'imagery' && (
          <button type="button" className="icon-btn moon-view__btn" aria-label="Recenter on pin" onClick={() => imageryApi.current?.recenter()}>
            ⌖
          </button>
        )}
      </div>

      {/* Bottom-left: scale + cursor */}
      <div className="site-map__hud site-map__hud--bl">
        <div className="scale-bar" aria-label={`Scale: ${bar.km} km`}>
          <span style={{ width: bar.px }} />
          <span className="mono">{bar.km} km</span>
        </div>
        <span className="mono site-map__readout">
          {view === 'imagery'
            ? hover
              ? `${formatLat(hover.lat, 3)} · ${formatLon(hover.lon, 3)}`
              : 'Drag to pan · scroll to zoom · click to move the pin'
            : hoverElev !== null
              ? `${hoverElev >= 0 ? '+' : ''}${Math.round(hoverElev)} m vs. landing point`
              : `${sizeKm} km × ${sizeKm} km · hover for elevation`}
        </span>
      </div>

      {/* Bottom-right: layers */}
      <fieldset className="site-map__hud site-map__hud--br layers-panel">
        <legend className="eyebrow">Map layers</legend>
        {(layers.data ?? []).map((l) => {
          const available = !!l.tileUrl;
          return (
            <label key={l.id} className={`layers-panel__row${available ? '' : ' is-disabled'}`}>
              <input
                type="checkbox"
                disabled={!available}
                checked={!!activeLayers[l.id]}
                onChange={() => setActiveLayers((a) => ({ ...a, [l.id]: !a[l.id] }))}
              />
              <span className={`layer-swatch layer-swatch--${l.id}`} aria-hidden="true" />
              <span style={{ flex: 1 }}>{l.name}</span>
              <span className="mono muted" style={{ fontSize: 11 }}>
                {available ? l.source : 'coming soon'}
              </span>
            </label>
          );
        })}
        <span className="muted" style={{ fontSize: 12 }}>
          Backend: {apiMode}
        </span>
      </fieldset>
    </div>
  );
}
