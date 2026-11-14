import { Vector3 } from 'three';
import type { LatLon } from './coords';

const DEG = Math.PI / 180;

/**
 * Selenographic lat/lon → point on a sphere, matching three.js SphereGeometry UVs
 * with an equirectangular texture whose left edge is lon −180° and top edge is lat +90°
 * (the layout of the NASA SVS CGI Moon Kit maps).
 */
export function latLonToVector(lat: number, lon: number, radius = 1): Vector3 {
  const phi = ((lon + 180) / 360) * 2 * Math.PI;
  const theta = (90 - lat) * DEG;
  return new Vector3(
    -radius * Math.cos(phi) * Math.sin(theta),
    radius * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

/** Inverse of latLonToVector. Works for any point (it is normalized first). */
export function vectorToLatLon(p: Vector3): LatLon {
  const n = p.clone().normalize();
  const lat = Math.asin(Math.max(-1, Math.min(1, n.y))) / DEG;
  let phi = Math.atan2(n.z, -n.x);
  if (phi < 0) phi += 2 * Math.PI;
  let lon = (phi / (2 * Math.PI)) * 360 - 180;
  if (lon >= 180) lon -= 360;
  return { lat, lon };
}
