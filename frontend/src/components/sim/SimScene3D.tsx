import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useLoader, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls } from '@react-three/drei';
import { BufferAttribute, BufferGeometry, DoubleSide, SRGBColorSpace, TextureLoader, Vector3, type Texture } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { SpaceBackground } from '../space/SpaceBackground';
import { TextureBoundary } from '../moon/TextureBoundary';
import { EARTH_TEXTURE_URL } from '../route/RouteScene';
import { azElToVector, exaggerate, type SkyState } from '../../lib/sky';
import type { HorizonProfile } from '../../api/types';

export const VERTICAL_EXAGGERATION = 10;
export type CameraMode = 'orbit' | 'lander' | 'top';

const K = VERTICAL_EXAGGERATION;
const R_INNER = 6; // flat pad around the lander
const R_RING = 60; // where the horizon silhouette sits
const D_SUN = 140;
const D_EARTH = 115;
const MAST_TOP = new Vector3(0, 1.3, 0);
const RED = '#FF7A4D';

interface SimScene3DProps {
  sky: SkyState;
  horizon: HorizonProfile | null;
  realTerrain: boolean;
  camera: CameraMode;
}

/**
 * View from the landing site. Near ground + a far silhouette built from GET /horizon.
 * Visibility colours come from the backend (sunFrac / earthVisible), never from raycasts here.
 */
export function SimScene3D({ sky, horizon, realTerrain, camera }: SimScene3DProps) {
  const sunEl = exaggerate(sky.sunEl, K);
  const earthEl = exaggerate(sky.earthEl, K);
  const sunPos = azElToVector(sky.sunAz, sunEl, D_SUN);
  const earthPos = azElToVector(sky.earthAz, earthEl, D_EARTH);
  const sunUp = sky.sunFrac > 0;
  const earthUp = sky.earthVisible;

  return (
    <Canvas camera={{ fov: 50, near: 0.1, far: 2000, position: [14, 7, 18] }} shadows={false} aria-label="3D view from the landing site">
      <SpaceBackground intensity={0.5} />
      <ambientLight intensity={0.25} />
      <directionalLight position={sunPos.toArray()} intensity={sunUp ? 2.6 * Math.max(0.25, sky.sunFrac) : 0.15} color="#fff6d8" />
      <hemisphereLight args={['#9fb4d8', '#0b1a45', 0.2]} />

      <Terrain horizon={realTerrain ? horizon : null} />
      <Lander />

      {/* Sun */}
      <mesh position={sunPos}>
        <sphereGeometry args={[4, 32, 32]} />
        <meshBasicMaterial color="#EAFE07" />
      </mesh>
      <Html position={sunPos.clone().add(new Vector3(0, 8, 0))} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <span className={`sim-chip${sunUp ? ' sim-chip--sun' : ' sim-chip--blocked'}`}>Sun {fmt(sky.sunEl)}</span>
      </Html>

      {/* Earth */}
      <group position={earthPos}>
        <TextureBoundary fallback={<EarthBall map={null} />}>
          <Suspense fallback={<EarthBall map={null} />}>
            <TexturedEarthBall />
          </Suspense>
        </TextureBoundary>
      </group>
      <Html position={earthPos.clone().add(new Vector3(0, 9, 0))} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <span className={`sim-chip${earthUp ? ' sim-chip--earth' : ' sim-chip--blocked'}`}>Earth {fmt(sky.earthEl)}</span>
      </Html>

      {/* Lines of sight: colour = backend verdict */}
      <Line points={[MAST_TOP, sunPos]} color={sunUp ? '#EAFE07' : RED} lineWidth={2} dashed={!sunUp} dashSize={2} gapSize={1.5} />
      <Line points={[MAST_TOP, earthPos]} color={earthUp ? '#2E96F5' : RED} lineWidth={2} dashed={!earthUp} dashSize={2} gapSize={1.5} />

      <CameraRig mode={camera} sunAz={sky.sunAz} />
    </Canvas>
  );
}

const fmt = (el: number) => `${el >= 0 ? '+' : ''}${el.toFixed(1)}°`;

/** Flat pad + a fan that rises/falls to the terrain horizon at R_RING (exaggerated). */
function Terrain({ horizon }: { horizon: HorizonProfile | null }) {
  const geometry = useMemo(() => {
    const n = horizon ? horizon.elevationDeg.length : 360;
    const ring = (i: number, r: number, y: number) => {
      const az = (i / n) * 2 * Math.PI;
      return [Math.sin(az) * r, y, -Math.cos(az) * r];
    };
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const maskEl = horizon ? exaggerate(horizon.elevationDeg[i % n], K) : 0;
      const yFar = Math.tan((maskEl * Math.PI) / 180) * R_RING;
      pos.push(...ring(i, R_INNER, 0), ...ring(i, R_RING, yFar), ...ring(i, R_RING, Math.min(yFar, 0) - 30));
    }
    pos.push(0, 0, 0); // centre
    const c = pos.length / 3 - 1;
    for (let i = 0; i < n; i++) {
      const a = i * 3;
      const b = (i + 1) * 3;
      idx.push(c, a, b); // pad
      idx.push(a, a + 1, b, b, a + 1, b + 1); // slope up/down to the horizon
      idx.push(a + 1, a + 2, b + 1, b + 1, a + 2, b + 2); // skirt below the silhouette
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }, [horizon]);

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#6E7689" roughness={1} metalness={0} side={DoubleSide} flatShading />
    </mesh>
  );
}

function Lander() {
  return (
    <group>
      <mesh position={[0, 0.55, 0]}>
        <boxGeometry args={[0.9, 0.45, 0.9]} />
        <meshStandardMaterial color="#E8ECF3" roughness={0.6} />
      </mesh>
      {[
        [0.55, 0.55],
        [-0.55, 0.55],
        [0.55, -0.55],
        [-0.55, -0.55],
      ].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x * 0.85, 0.2, z * 0.85]} rotation={[z * 0.5, 0, -x * 0.5]}>
          <cylinderGeometry args={[0.03, 0.03, 0.6, 6]} />
          <meshStandardMaterial color="#C9CED8" />
        </mesh>
      ))}
      <mesh position={[0, 1.0, 0]}>
        <cylinderGeometry args={[0.03, 0.03, 0.6, 6]} />
        <meshStandardMaterial color="#C9CED8" />
      </mesh>
      <mesh position={MAST_TOP}>
        <sphereGeometry args={[0.08, 16, 16]} />
        <meshBasicMaterial color="#EAFE07" />
      </mesh>
    </group>
  );
}

function TexturedEarthBall() {
  const map = useLoader(TextureLoader, EARTH_TEXTURE_URL);
  map.colorSpace = SRGBColorSpace;
  return <EarthBall map={map} />;
}

function EarthBall({ map }: { map: Texture | null }) {
  return (
    <mesh>
      <sphereGeometry args={[5, 48, 32]} />
      <meshStandardMaterial map={map} color={map ? '#ffffff' : '#2E96F5'} emissiveMap={map} emissive={map ? '#ffffff' : '#0960E1'} emissiveIntensity={0.35} />
    </mesh>
  );
}

/** Orbit around the lander, stand at the mast (look around), or look straight down. */
function CameraRig({ mode, sunAz }: { mode: CameraMode; sunAz: number }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const cam = useThree((s) => s.camera);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    if (mode === 'orbit') {
      cam.position.set(14, 7, 18);
      c.target.set(0, 0.6, 0);
    } else if (mode === 'lander') {
      // Eye at the mast; a target 0.01 away turns orbiting into "look around".
      const look = azElToVector(sunAz, 4, 0.01);
      cam.position.set(0, 1.4, 0);
      c.target.set(look.x, 1.4 + look.y, look.z);
    } else {
      cam.position.set(0, 120, 0.01);
      c.target.set(0, 0, 0);
    }
    c.update();
    // Only when the mode changes — not on every Sun move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cam]);

  return (
    <OrbitControls
      ref={controls}
      enablePan={false}
      enableZoom={mode !== 'lander'}
      enableDamping
      minDistance={mode === 'top' ? 30 : 4}
      maxDistance={mode === 'top' ? 250 : 120}
      maxPolarAngle={mode === 'orbit' ? Math.PI * 0.49 : Math.PI}
      rotateSpeed={mode === 'lander' ? -0.35 : 0.8}
    />
  );
}
