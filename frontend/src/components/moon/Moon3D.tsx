import { Component, Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Canvas, useFrame, useLoader, useThree, type Camera } from '@react-three/fiber';
import { OrbitControls, Stars } from '@react-three/drei';
import { EquirectangularReflectionMapping, SRGBColorSpace, TextureLoader, Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { MoonGlobe, TexturedMoonGlobe } from './MoonGlobe';
import { useSelection } from '../../store/selection';
import { latLonToVector } from '../../lib/geo';
import { formatLat, formatLon, type LatLon } from '../../lib/coords';

const MIN_DIST = 1.08; // closest zoom (Moon radius = 1)
const MAX_DIST = 6;
const START = latLonToVector(-55, 20, 3); // tilted to show the south pole

/**
 * Rotatable, zoomable 3D Moon (QuickMap-style).
 * Drag = rotate · wheel/pinch = zoom · click = drop pin (writes lat/lon to the selection store).
 */
export function Moon3D({ style }: { style?: CSSProperties }) {
  const [hover, setHover] = useState<LatLon | null>(null);
  const [textureMissing, setTextureMissing] = useState(false);
  const cameraRef = useRef<Camera | null>(null);
  const skipFlyRef = useRef(false);

  function zoom(factor: number) {
    const cam = cameraRef.current;
    if (!cam) return;
    const d = Math.max(MIN_DIST, Math.min(MAX_DIST, cam.position.length() * factor));
    cam.position.setLength(d);
  }

  const globeProps = { onHover: setHover, onPick: () => (skipFlyRef.current = true) };

  return (
    <div className="moon-view" style={style}>
      <Canvas
        camera={{ position: START.toArray(), fov: 40, near: 0.001, far: 100 }}
        onCreated={({ camera }) => (cameraRef.current = camera)}
        aria-label="Interactive 3D Moon. Drag to rotate, scroll to zoom, click to place a pin."
      >
        <color attach="background" args={['#020611']} />
        <TextureBoundary onError={() => {}} fallback={<ProceduralStars />}>
          <Suspense fallback={<ProceduralStars />}>
            <StarMapBackground />
          </Suspense>
        </TextureBoundary>
        <ambientLight intensity={0.55} />
        <directionalLight position={[5, 1.5, 3]} intensity={2.2} />

        <TextureBoundary onError={() => setTextureMissing(true)} fallback={<MoonGlobe {...globeProps} />}>
          <Suspense fallback={<MoonGlobe {...globeProps} />}>
            <TexturedMoonGlobe {...globeProps} />
          </Suspense>
        </TextureBoundary>

        <CameraRig skipFlyRef={skipFlyRef} />
      </Canvas>

      <div className="moon-view__hud moon-view__hud--top">
        {textureMissing && <span className="error">Texture missing: add public/textures/moon_color.jpg</span>}
      </div>

      <div className="moon-view__hud moon-view__hud--bottom">
        <span className="mono" aria-live="off">
          {hover ? `cursor ${formatLat(hover.lat)} · ${formatLon(hover.lon)}` : 'Drag to rotate · Scroll to zoom · Click to drop a pin'}
        </span>
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="icon-btn moon-view__btn" aria-label="Zoom in" onClick={() => zoom(0.8)}>
            +
          </button>
          <button type="button" className="icon-btn moon-view__btn" aria-label="Zoom out" onClick={() => zoom(1.25)}>
            −
          </button>
        </span>
      </div>
    </div>
  );
}

/** Put a star map here (see README → "Starry sky"). */
export const STAR_MAP_URL = '/textures/starmap.jpg';

/** Real all-sky star map (NASA SVS Deep Star Maps) as the scene background. */
function StarMapBackground() {
  const tex = useLoader(TextureLoader, STAR_MAP_URL);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    tex.mapping = EquirectangularReflectionMapping;
    tex.colorSpace = SRGBColorSpace;
    const prev = { bg: scene.background, intensity: scene.backgroundIntensity };
    scene.background = tex;
    scene.backgroundIntensity = 0.6; // keep stars subtle so the Moon and UI stay readable
    return () => {
      scene.background = prev.bg;
      scene.backgroundIntensity = prev.intensity;
    };
  }, [tex, scene]);
  return null;
}

/** Fallback when the star map file is missing: procedural twinkling stars. */
function ProceduralStars() {
  return (
    <>
      <Stars radius={80} depth={40} count={6000} factor={3} saturation={0} fade speed={0.4} />
      <Stars radius={120} depth={20} count={1500} factor={6} saturation={0} fade speed={0.2} />
    </>
  );
}

/** Orbit controls + smooth "fly to" when the selection changes from outside the globe (list, catalog, typed coords). */
function CameraRig({ skipFlyRef }: { skipFlyRef: React.MutableRefObject<boolean> }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const lat = useSelection((s) => s.lat);
  const lon = useSelection((s) => s.lon);
  const flyDir = useRef<Vector3 | null>(null);

  useEffect(() => {
    if (skipFlyRef.current) {
      // The user clicked the globe: don't yank the camera away from the cursor.
      skipFlyRef.current = false;
      return;
    }
    flyDir.current = latLonToVector(lat, lon).normalize();
  }, [lat, lon, skipFlyRef]);

  useFrame(({ camera }) => {
    const c = controls.current;
    const dist = camera.position.length();
    if (c) {
      // Slower rotation when zoomed in, like QuickMap.
      c.rotateSpeed = Math.max(0.05, Math.min(1, (dist - 1) * 0.6));
      c.zoomSpeed = Math.max(0.3, Math.min(1, (dist - 1) * 0.8));
    }
    if (flyDir.current) {
      const desired = flyDir.current.clone().multiplyScalar(dist);
      camera.position.lerp(desired, 0.08).setLength(dist);
      if (camera.position.distanceTo(desired) < 0.002) flyDir.current = null;
      c?.update();
    }
  });

  return (
    <OrbitControls
      ref={controls}
      enablePan={false}
      enableDamping
      dampingFactor={0.08}
      minDistance={MIN_DIST}
      maxDistance={MAX_DIST}
      onStart={() => (flyDir.current = null)}
    />
  );
}

/** Shows the grey Moon if the texture file is missing instead of crashing the page. */
class TextureBoundary extends Component<{ fallback: ReactNode; onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
