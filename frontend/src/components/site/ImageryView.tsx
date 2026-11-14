import { Suspense, useEffect, useRef, type MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { MOUSE, TOUCH } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { MoonGlobe, TexturedMoonGlobe } from '../moon/MoonGlobe';
import { TextureBoundary } from '../moon/TextureBoundary';
import { latLonToVector } from '../../lib/geo';
import type { LatLon } from '../../lib/coords';

export const MOON_RADIUS_KM = 1737.4;
const FOV = 40;
const START_DIST = 0.024; // ≈ 30 km tall view
const MIN_DIST = 0.002; // ≈ 2.5 km
const MAX_DIST = 0.35; // ≈ 440 km

export interface ImageryApi {
  zoom: (factor: number) => void;
  recenter: () => void;
}

interface ImageryViewProps {
  lat: number;
  lon: number;
  apiRef: MutableRefObject<ImageryApi | null>;
  /** Height of the visible area in km, for the scale bar. */
  onViewHeightKm: (km: number) => void;
  onHover: (p: LatLon | null) => void;
  onPick: () => void;
}

/** Top-down close-up of the LROC mosaic around the pin (north up). Drag = pan, wheel = zoom, click = move pin. */
export function ImageryView({ lat, lon, apiRef, onViewHeightKm, onHover, onPick }: ImageryViewProps) {
  const globeProps = { onHover, onPick };
  return (
    <Canvas camera={{ fov: FOV, near: 0.00005, far: 10 }} aria-label="Top-down imagery around the landing point">
      <color attach="background" args={['#020611']} />
      <ambientLight intensity={1.6} />
      <TextureBoundary fallback={<MoonGlobe {...globeProps} />}>
        <Suspense fallback={<MoonGlobe {...globeProps} />}>
          <TexturedMoonGlobe {...globeProps} />
        </Suspense>
      </TextureBoundary>
      <MapRig lat={lat} lon={lon} apiRef={apiRef} onViewHeightKm={onViewHeightKm} />
    </Canvas>
  );
}

function MapRig({ lat, lon, apiRef, onViewHeightKm }: Pick<ImageryViewProps, 'lat' | 'lon' | 'apiRef' | 'onViewHeightKm'>) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const lastReported = useRef(0);

  // Put the camera straight above the point, north up.
  function recenter(dist = START_DIST) {
    const c = controls.current;
    const p = latLonToVector(lat, lon);
    const north = latLonToVector(Math.min(lat + 0.05, 89.999), lon).sub(p).normalize();
    camera.up.copy(north);
    camera.position.copy(p.clone().multiplyScalar(1 + dist));
    if (c) {
      c.target.copy(p);
      c.update();
    }
    camera.lookAt(p);
  }

  useEffect(() => {
    // Keep the zoom level when the point moves by a click; full recenter otherwise.
    const c = controls.current;
    const dist = c ? camera.position.distanceTo(c.target) : START_DIST;
    recenter(Math.min(MAX_DIST, Math.max(MIN_DIST, dist || START_DIST)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lon]);

  useEffect(() => {
    apiRef.current = {
      zoom: (factor) => {
        const c = controls.current;
        if (!c) return;
        const offset = camera.position.clone().sub(c.target);
        offset.setLength(Math.min(MAX_DIST, Math.max(MIN_DIST, offset.length() * factor)));
        camera.position.copy(c.target).add(offset);
        c.update();
      },
      recenter: () => recenter(START_DIST),
    };
    return () => {
      apiRef.current = null;
    };
  });

  useFrame(() => {
    const c = controls.current;
    if (!c) return;
    const dist = camera.position.distanceTo(c.target);
    const km = 2 * dist * MOON_RADIUS_KM * Math.tan(((FOV / 2) * Math.PI) / 180);
    if (Math.abs(km - lastReported.current) / km > 0.02) {
      lastReported.current = km;
      onViewHeightKm(km);
    }
  });

  return (
    <OrbitControls
      ref={controls}
      enableRotate={false}
      enablePan
      screenSpacePanning
      enableDamping
      dampingFactor={0.12}
      minDistance={MIN_DIST}
      maxDistance={MAX_DIST}
      mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }}
      touches={{ ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN }}
    />
  );
}
