import type { Heightmap, TerrainPoint } from './types';

/** Small deterministic PRNG so the same point always gives the same mock terrain. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function seedFrom(lat: number, lon: number) {
  return Math.round((lat + 90) * 1000) * 7919 + Math.round((lon + 180) * 1000);
}

export function mockTerrainPoint(lat: number, lon: number): TerrainPoint {
  const r = rng(seedFrom(lat, lon));
  return {
    lat,
    lon,
    elevationM: Math.round(1500 + r() * 800),
    slopeDeg: null, // mirrors the real backend today
    demCoverage: lat <= -80,
    demResolutionM: 100,
    inPermanentShadow: null, // mirrors the real backend today
    nearestSite: null,
  };
}

/** Synthetic cratered terrain. Only for building the UI without a backend — always shown as MOCK DATA. */
export function mockHeightmap(lat: number, lon: number, sizeKm = 20, res = 256): Heightmap {
  const r = rng(seedFrom(lat, lon));
  const craters = Array.from({ length: 40 }, () => ({
    x: r() * sizeKm,
    y: r() * sizeKm,
    radius: 0.2 + Math.pow(r(), 3) * sizeKm * 0.35,
  }));
  const ridgeAngle = r() * Math.PI;
  const heights: number[][] = [];
  let min = Infinity;
  let max = -Infinity;
  const cell = sizeKm / res;
  for (let row = 0; row < res; row++) {
    const line: number[] = [];
    for (let col = 0; col < res; col++) {
      const x = col * cell;
      const y = row * cell;
      // gentle regional slope + a ridge through the middle
      const along = (x - sizeKm / 2) * Math.cos(ridgeAngle) + (y - sizeKm / 2) * Math.sin(ridgeAngle);
      const across = -(x - sizeKm / 2) * Math.sin(ridgeAngle) + (y - sizeKm / 2) * Math.cos(ridgeAngle);
      let h = 300 * Math.exp(-(across * across) / (2 * (sizeKm / 6) ** 2)) + along * 8;
      for (const c of craters) {
        const d = Math.hypot(x - c.x, y - c.y) / c.radius;
        const depth = c.radius * 180; // m
        if (d < 1) h -= depth * (1 - d * d);
        else if (d < 1.5) h += depth * 0.25 * Math.cos(((d - 1) / 0.5) * (Math.PI / 2));
      }
      line.push(h);
      if (h < min) min = h;
      if (h > max) max = h;
    }
    heights.push(line);
  }
  const center = heights[res >> 1][res >> 1];
  const rel = heights.map((line) => line.map((h) => h - center));
  return {
    lat,
    lon,
    sizeKm,
    res,
    originElevationM: null,
    minElevationM: min - center,
    maxElevationM: max - center,
    heightsM: rel,
    northUp: true,
    demVersion: 'MOCK',
    mock: true,
  };
}
