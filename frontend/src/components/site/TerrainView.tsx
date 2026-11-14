import { useEffect, useRef, type MouseEvent } from 'react';
import type { Heightmap } from '../../api/types';
import './site-map.css';

/** Light from the upper left, low over the horizon — reads well as relief. */
const LIGHT_AZ_DEG = 315;
const LIGHT_ALT_DEG = 30;

/** Shaded-relief rendering of a backend heightmap, with the pin at the centre. */
export function TerrainView({ data, onHoverElevation }: { data: Heightmap; onHoverElevation: (m: number | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { res, heightsM, sizeKm } = data;
    canvas.width = res;
    canvas.height = res;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(res, res);
    const cellM = (sizeKm * 1000) / res;
    const zen = ((90 - LIGHT_ALT_DEG) * Math.PI) / 180;
    const az = (LIGHT_AZ_DEG * Math.PI) / 180;
    const h = (r: number, c: number) => heightsM[Math.max(0, Math.min(res - 1, r))][Math.max(0, Math.min(res - 1, c))];

    for (let r = 0; r < res; r++) {
      for (let c = 0; c < res; c++) {
        const dzdx = (h(r, c + 1) - h(r, c - 1)) / (2 * cellM);
        const dzdy = (h(r + 1, c) - h(r - 1, c)) / (2 * cellM);
        const slope = Math.atan(Math.hypot(dzdx, dzdy));
        const aspect = Math.atan2(dzdy, -dzdx);
        const shade = Math.max(0, Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect));
        // Blend from deep shadow blue to lunar grey.
        const t = Math.pow(shade, 0.8);
        const i = (r * res + c) * 4;
        img.data[i] = 11 + t * (201 - 11);
        img.data[i + 1] = 26 + t * (206 - 26);
        img.data[i + 2] = 69 + t * (216 - 69);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [data]);

  function onMove(e: MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * data.res);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * data.res);
    if (x < 0 || y < 0 || x >= data.res || y >= data.res) return;
    onHoverElevation(data.heightsM[y][x]);
  }

  return (
    <div className="terrain-view">
      <canvas
        ref={canvasRef}
        className="terrain-view__canvas"
        onMouseMove={onMove}
        onMouseLeave={() => onHoverElevation(null)}
        role="img"
        aria-label={`Shaded relief, ${data.sizeKm} km across, centred on the landing point`}
      />
      <svg className="terrain-view__pin" viewBox="0 0 40 52" aria-hidden="true">
        <path d="M20 50 C12 38 6 30 6 20 A14 14 0 1 1 34 20 C34 30 28 38 20 50 Z" fill="#EAFE07" stroke="#07173F" strokeWidth="3" />
        <circle cx="20" cy="20" r="5" fill="#07173F" />
      </svg>
    </div>
  );
}
