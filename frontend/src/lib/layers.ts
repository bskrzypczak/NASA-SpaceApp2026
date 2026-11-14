import type { LayerGrid } from '../api/types';

/** Slope above this is drawn as a hazard (matches the layer name "Slope > 10°"). */
export const SLOPE_HAZARD_DEG = 10;

/** Horn slope in degrees, same as backend build_slope_grid: 1-cell border = null. */
export function slopeFromHeights(heightsM: number[][], sizeKm: number): (number | null)[][] {
  const res = heightsM.length;
  const cell = (sizeKm * 1000) / res;
  const out: (number | null)[][] = Array.from({ length: res }, () => new Array<number | null>(res).fill(null));
  for (let r = 1; r < res - 1; r++) {
    const n = heightsM[r - 1];
    const m = heightsM[r];
    const s = heightsM[r + 1];
    for (let c = 1; c < res - 1; c++) {
      const dzdx = (n[c + 1] + 2 * m[c + 1] + s[c + 1] - n[c - 1] - 2 * m[c - 1] - s[c - 1]) / (8 * cell);
      const dzdy = (s[c - 1] + 2 * s[c] + s[c + 1] - n[c - 1] - 2 * n[c] - n[c + 1]) / (8 * cell);
      out[r][c] = Math.round((Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI * 1000) / 1000;
    }
  }
  return out;
}

/** True when the grid has no data at all (e.g. PSR outside 80–90°S). */
export function gridIsEmpty(g: LayerGrid): boolean {
  return g.values.every((row) => row.every((v) => v === null));
}

/** Short hover text for one cell, with a symbol so colour is not the only signal. */
export function describeCell(g: LayerGrid, row: number, col: number): string | null {
  const v = g.values[row]?.[col];
  if (v === undefined) return null;
  if (g.layerId === 'slope') {
    if (v === null) return 'slope n/a';
    return `slope ${v.toFixed(1)}°${v > SLOPE_HAZARD_DEG ? ' ⚠' : ''}`;
  }
  if (g.layerId === 'illumination') return v === null ? 'sunlight n/a' : `☀ sunlit ${v.toFixed(0)}% of time`;
  if (g.layerId === 'earth-visibility') return v === null ? 'Earth n/a' : `◉ Earth in view ${v.toFixed(0)}%`;
  if (g.layerId === 'psr') return v === null ? 'PSR n/a' : v ? '▨ permanent shadow' : 'not PSR';
  return v === null ? `${g.layerId} n/a` : `${g.layerId} ${v}`;
}

/** Paint an overlay into RGBA pixels (res × res). Transparent where nothing to show. */
export function paintOverlay(g: LayerGrid, img: ImageData): void {
  const { res, values } = g;
  const d = img.data;
  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) {
      const v = values[r][c];
      const i = (r * res + c) * 4;
      d[i + 3] = 0;
      if (v === null) continue;
      if (g.layerId === 'slope' && v > SLOPE_HAZARD_DEG) {
        // --danger-text #ff7a4d, stronger for steeper ground
        const a = Math.min(1, 0.45 + (v - SLOPE_HAZARD_DEG) / 40);
        d[i] = 255; d[i + 1] = 122; d[i + 2] = 77; d[i + 3] = Math.round(a * 200);
      } else if (g.layerId === 'illumination' || g.layerId === 'earth-visibility') {
        // Sun = Neon Yellow #eafe07, Earth = Blue Yonder #2e96f5; opacity grows with the % of time in view.
        const [cr, cg, cb] = g.layerId === 'illumination' ? [234, 254, 7] : [46, 150, 245];
        d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = Math.round(Math.max(0, Math.min(100, v)) * 1.1); // max ~43 % opacity: terrain stays readable
      } else if (g.layerId === 'psr' && v === 1) {
        // --blue-yonder #2e96f5, diagonal hatch like the legend swatch
        const stripe = (r + c) % 5 < 2;
        d[i] = 46; d[i + 1] = 150; d[i + 2] = 245; d[i + 3] = stripe ? 230 : 90;
      }
    }
  }
}
