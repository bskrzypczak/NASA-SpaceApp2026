import { useRef, useState } from 'react';
import { ImageryView, type ImageryApi } from './ImageryView';
import { TerrainView, type HoverCell } from './TerrainView';
import { useApi } from '../../hooks/useApi';
import { apiMode, getHeightmap, getLayerGrid, getLayers, layerHasGrid } from '../../api/client';
import type { LayerGrid, LayerId } from '../../api/types';
import type { ApiState } from '../../hooks/useApi';
import { describeCell, gridIsEmpty } from '../../lib/layers';
import { formatLat, formatLon, type LatLon } from '../../lib/coords';
import './site-map.css';

type View = 'imagery' | 'terrain';
const TERRAIN_SIZES_KM = [5, 10, 20, 40];
/** Heightmap and layer grids must use the same res to line up pixel for pixel. */
const GRID_RES = 256;
const OVERLAY_ORDER = ['illumination', 'earth-visibility', 'psr', 'slope'] as const;
type OverlayId = (typeof OVERLAY_ORDER)[number];

/** One overlay grid; fetched only while the layer is on (Terrain view). */
function useLayerGrid(id: LayerId, on: boolean, lat: number, lon: number, sizeKm: number) {
  return useApi((signal) => (on ? getLayerGrid(id, lat, lon, sizeKm, GRID_RES, signal) : Promise.resolve(null)), [on, lat, lon, sizeKm], { debounceMs: 300 });
}

/** Pick a round scale-bar length that is ~90–160 px long. */
function scaleBar(viewHeightKm: number, containerPx: number) {
  const kmPerPx = viewHeightKm / Math.max(1, containerPx);
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200];
  const km = steps.find((s) => s / kmPerPx >= 90) ?? steps[steps.length - 1];
  return { km, px: km / kmPerPx };
}

/** Screen 3 map: LROC imagery close-up (works now) or LOLA shaded relief (from the backend). */
export function SiteMap({ lat, lon, onPick, hidePinLabel = false }: LatLon & { onPick: () => void; hidePinLabel?: boolean }) {
  const [view, setView] = useState<View>('imagery');
  const [sizeKm, setSizeKm] = useState(20);
  const [viewKm, setViewKm] = useState(30);
  const [hover, setHover] = useState<LatLon | null>(null);
  const [hoverCell, setHoverCell] = useState<HoverCell | null>(null);
  const [activeLayers, setActiveLayers] = useState<Partial<Record<LayerId, boolean>>>({});
  const imageryApi = useRef<ImageryApi | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const layers = useApi((signal) => getLayers(signal), []);
  const heightmap = useApi(
    (signal) => (view === 'terrain' ? getHeightmap(lat, lon, sizeKm, GRID_RES, signal) : Promise.resolve(null)),
    [view, lat, lon, sizeKm],
    { debounceMs: 300 },
  );
  const isOn = (id: LayerId) => view === 'terrain' && !!activeLayers[id];
  // Fixed call order (same 4 hooks every render). Draw order: averages first, hazards on top.
  const gridState: Record<OverlayId, ApiState<LayerGrid | null>> = {
    illumination: useLayerGrid('illumination', isOn('illumination'), lat, lon, sizeKm),
    'earth-visibility': useLayerGrid('earth-visibility', isOn('earth-visibility'), lat, lon, sizeKm),
    psr: useLayerGrid('psr', isOn('psr'), lat, lon, sizeKm),
    slope: useLayerGrid('slope', isOn('slope'), lat, lon, sizeKm),
  };
  const overlays = OVERLAY_ORDER.map((id) => (isOn(id) ? gridState[id].data : null)).filter((g): g is LayerGrid => !!g);
  const psrOn = isOn('psr');
  const psr = gridState.psr;

  function toggleLayer(id: LayerId) {
    const next = !activeLayers[id];
    setActiveLayers((a) => ({ ...a, [id]: next }));
    // Overlays are aligned with the LOLA heightmap, so they live on the Terrain view.
    if (next && view !== 'terrain') setView('terrain');
  }

  function layerStatus(id: LayerId, fallback: string): string {
    const st = gridState[id as OverlayId];
    if (!activeLayers[id] || view !== 'terrain' || !st) return fallback;
    if (st.loading) return 'loading…';
    if (st.error) return 'error';
    if (st.data && gridIsEmpty(st.data)) return 'no data here';
    return fallback;
  }

  const hoverText = hoverCell
    ? [
        `${hoverCell.elevationM >= 0 ? '+' : ''}${Math.round(hoverCell.elevationM)} m vs. landing point`,
        ...overlays.map((g) => describeCell(g, hoverCell.row, hoverCell.col)).filter(Boolean),
      ].join(' · ')
    : null;

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
        <ImageryView lat={lat} lon={lon} apiRef={imageryApi} onViewHeightKm={setViewKm} onHover={setHover} onPick={onPick} hidePinLabel={hidePinLabel} />
      ) : heightmap.data ? (
        <TerrainView data={heightmap.data} overlays={overlays} onHover={setHoverCell} />
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
            : (hoverText ?? `${sizeKm} km × ${sizeKm} km · hover for elevation`)}
        </span>
      </div>

      {/* Bottom-right: layers */}
      <fieldset className="site-map__hud site-map__hud--br layers-panel">
        <legend className="eyebrow">Map layers</legend>
        {(layers.data ?? []).map((l) => {
          const available = layerHasGrid(l);
          const status = layerStatus(l.id, l.source);
          return (
            <label key={l.id} className={`layers-panel__row${available ? '' : ' is-disabled'}`}>
              <input
                type="checkbox"
                disabled={!available}
                checked={!!activeLayers[l.id]}
                onChange={() => toggleLayer(l.id)}
              />
              <span className={`layer-swatch layer-swatch--${l.id}`} aria-hidden="true" />
              <span style={{ flex: 1 }}>{l.name}</span>
              <span className={`mono ${status === 'error' ? 'error' : 'muted'}`} style={{ fontSize: 11 }} title={gridState[l.id as OverlayId]?.error?.message}>
                {available ? status : 'coming soon'}
              </span>
            </label>
          );
        })}
        {view === 'imagery' && <span className="layers-panel__note">Layers draw on the Terrain view (LOLA grid).</span>}
        {(psrOn && psr.data && gridIsEmpty(psr.data)) && <span className="layers-panel__note">PSR map covers 80–90°S only.</span>}
        {(['illumination', 'earth-visibility'] as const).some((id) => isOn(id) && gridState[id].data && gridIsEmpty(gridState[id].data!)) && (
          <span className="layers-panel__note">Sunlight and Earth maps cover 65–90° N/S only.</span>
        )}
        {(isOn('illumination') || isOn('earth-visibility')) && <span className="layers-panel__note">Stronger colour = more time in view (18.6-yr average).</span>}
        <span className="muted" style={{ fontSize: 12 }}>
          Backend: {apiMode}
        </span>
      </fieldset>
    </div>
  );
}
