import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls } from '@react-three/drei';
import { BufferAttribute, BufferGeometry, DoubleSide, LinearFilter, Matrix4, Object3D, Quaternion, SRGBColorSpace, TextureLoader, Vector3, type PerspectiveCamera, type Texture } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { SpaceBackground } from '../space/SpaceBackground';
import { TextureBoundary } from '../moon/TextureBoundary';
import { EARTH_TEXTURE_URL } from '../route/RouteScene';
import { MOON_TEXTURE_URL } from '../moon/MoonGlobe';

/** Optional LOLA elevation map (8-bit, 0 = −10 km, 255 = +10 km vs 1737.4 km). See README. */
export const MOON_DISPLACEMENT_URL = '/textures/moon_displacement.png';
import { latLonToVector } from '../../lib/geo';
import { azElToVector, exaggerate, type SkyState } from '../../lib/sky';
import type { HorizonProfile } from '../../api/types';
import './sim.css';

export const VERTICAL_EXAGGERATION = 10;
export type CameraMode = 'orbit' | 'overview' | 'lander' | 'top';

const K = VERTICAL_EXAGGERATION;
const R_PAD = 0.6; // flat pad around the lander (≈1.5 km)
const R_RING = 60; // = maxDistanceKm (150 km): the farthest a horizon ridge can be
const MOON_RADIUS_KM = 1737.4;
const EARTH_RADIUS_KM = 6371;
/** Earth–Moon distance in the Overview: shortened (real ≈ 60 Earth radii) so both fit on screen. */
const D_ORBIT = 15000;
/** Where the Sun marker sits in the Earth–Moon view (direction is real, distance is not). */
const D_SUN_SYSTEM = D_ORBIT * 1.6;
/** Globe = cube sphere (no pole pinch, where most landing sites are): segments per cube edge. */
const CUBE_SEGMENTS = 320;
const DEFAULT_HORIZON_KM = 150;
/** Sun and Earth sit on a "sky shell" outside the Moon: right direction, not real distance. */
const D_SUN = 2300;
const D_EARTH = 2000;
/** Zoomed out far enough to see the whole Moon, the Sun and the Earth together. */
const MAX_ORBIT_DISTANCE = 90000;
const LANDER_SCALE = 0.3;
/**
 * Sun and Earth radii on the sky shell. Real angular sizes (Sun 0.53°, Earth ~1.9° from the Moon) look like
 * specks next to the whole Moon, so outside Lander view they are drawn ~3× larger (schematic).
 * Lander view keeps them small, so the disc you see against the horizon is not misleading.
 */
const SUN_R = { near: 60, far: 210 };
const EARTH_R = { near: 55, far: 185 };
const MAST_TOP = new Vector3(0, 1.3 * LANDER_SCALE, 0);
const RED = '#FF7A4D';


interface SimScene3DProps {
  lat: number;
  lon: number;
  sky: SkyState;
  /** Sky at the start of the window: in Overview the Sun is held where it was then and the Moon turns. */
  skyStart: SkyState;
  horizon: HorizonProfile | null;
  realTerrain: boolean;
  camera: CameraMode;
}

/**
 * View from the landing site. Near ground + a far silhouette built from GET /horizon.
 * Visibility colours come from the backend (sunFrac / earthVisible), never from raycasts here.
 */
export function SimScene3D({ lat, lon, sky, skyStart, horizon, realTerrain, camera }: SimScene3DProps) {
  // Horizontal scale: the crest ring (R_RING) is the horizon distance, so the Moon gets the same km per unit.
  const kmPerUnit = (horizon?.maxDistanceKm ?? DEFAULT_HORIZON_KM) / R_RING;
  const moonR = MOON_RADIUS_KM / kmPerUnit;
  const terrainHorizon = realTerrain ? horizon : null;
  // Lander view keeps the silhouette angles exact; the other views keep the patch true to the globe.
  const terrainMode: TerrainMode = camera === 'lander' ? 'angles' : 'globe';
  const disp = useOptionalTexture(MOON_DISPLACEMENT_URL);
  // The site sits at its real DEM height on the (×10) globe, so the patch meets the surface around it.
  // From afar the LOLA-displaced globe is the terrain; the horizon patch is only needed in Lander view
  // (exact backend silhouette) or when there is no elevation map for the globe.
  const showPatch = terrainMode === 'angles' || !disp;
  const globeSiteKm = useGlobeHeightKm(disp, lat, lon);
  const siteKm = showPatch ? (horizon?.observerElevationM != null ? horizon.observerElevationM / 1000 : null) : globeSiteKm;
  // Height of the site on the ×10 globe (units); the scene origin (lander) sits exactly there.
  const siteH = disp && siteKm != null ? (K * siteKm) / kmPerUnit : 0;
  const sunEl = exaggerate(sky.sunEl, K);
  const earthEl = exaggerate(sky.earthEl, K);
  const sunPos = azElToVector(sky.sunAz, sunEl, D_SUN);
  const earthPos = azElToVector(sky.earthAz, earthEl, D_EARTH);
  const sunUp = sky.sunFrac > 0;
  const earthUp = sky.earthVisible;
  const bodySize = camera === 'lander' ? 'near' : 'far';
  const sunR = SUN_R[bodySize];
  const earthR = EARTH_R[bodySize];

  // Moon centre and spin axis in the landing-site frame.
  const moonQ = useMemo(() => moonQuaternion(lat, lon), [lat, lon]);
  const pivot = useMemo(() => new Vector3(0, -moonR - siteH, 0), [moonR, siteH]);
  const spinAxis = useMemo(() => new Vector3(0, 1, 0).applyQuaternion(moonQ).normalize(), [moonQ]);

  // Overview = Earth–Moon system (frame that follows the Sun–Earth line): Earth fixed at the centre, sunlight
  // from a fixed direction (+X), the Moon orbits the Earth and, tidally locked, keeps the same face to it — so
  // the landing site and its lines of sight turn with it. Built from the true (not exaggerated) Sun and Earth
  // directions seen from the site. Other cameras stay in the landing-site frame.
  const system = isSystemView(camera);
  const { frame, groupPos } = useMemo(() => {
    if (!system) return { frame: new Quaternion(), groupPos: pivot.clone() };
    // 1) lunar spin axis → world up; 2) turn about up so the Sun lies along +X.
    const q1 = new Quaternion().setFromUnitVectors(spinAxis, new Vector3(0, 1, 0));
    const sunTrue = azElToVector(sky.sunAz, sky.sunEl, 1).applyQuaternion(q1);
    const q2 = spinToMatch(sunTrue, new Vector3(1, 0, 0), new Vector3(0, 1, 0));
    const q = q2.multiply(q1);
    // The Moon sits opposite the direction in which it sees the Earth.
    const earthDir = azElToVector(sky.earthAz, sky.earthEl, 1).applyQuaternion(q);
    // Keep the Moon exactly on the drawn orbit: drop the small out-of-plane part (libration / inclination,
    // a few degrees), which at this scale only made the Moon float off the dashed circle.
    earthDir.y = 0;
    if (earthDir.lengthSq() < 1e-9) earthDir.set(-1, 0, 0);
    earthDir.normalize();
    return { frame: q, groupPos: earthDir.multiplyScalar(-D_ORBIT) };
  }, [system, pivot, spinAxis, sky.sunAz, sky.sunEl, sky.earthAz, sky.earthEl]);
  const toWorld = (v: Vector3) => v.clone().sub(pivot).applyQuaternion(frame).add(groupPos);
  const siteWorld = toWorld(new Vector3());
  const moonCentreWorld = groupPos.clone();
  const sunWorld = system ? new Vector3(1, 0, 0).multiplyScalar(D_SUN_SYSTEM) : toWorld(sunPos);
  const earthWorld = system ? new Vector3() : toWorld(earthPos);
  const sunDirWorld = system ? new Vector3(1, 0, 0) : sunWorld.clone().sub(siteWorld).normalize();
  const lightTarget = useMemo(() => new Object3D(), []);
  lightTarget.position.copy(siteWorld);
  void skyStart;

  return (
    <Canvas camera={{ fov: 50, near: 0.05, far: 400000, position: [10, 5, 13] }} shadows="soft" aria-label="3D view from the landing site">
      <SpaceBackground intensity={0.5} />
      <ambientLight intensity={0.16} />
      <primitive object={lightTarget} />
      {/* Real Sun direction with terrain shadows: ridges lit, valleys dark. The backend verdict (lines,
          cards) stays the source of truth for whether the lander itself sees the Sun. */}
      <directionalLight
        position={siteWorld.clone().add(sunDirWorld.clone().multiplyScalar(300)).toArray()}
        target={lightTarget}
        intensity={2.4}
        color="#fff6d8"
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-bias={-0.001}
        shadow-normalBias={0.45}
        shadow-camera-left={-R_EDGE}
        shadow-camera-right={R_EDGE}
        shadow-camera-top={R_EDGE}
        shadow-camera-bottom={-R_EDGE}
        shadow-camera-near={1}
        shadow-camera-far={700}
      />
      <hemisphereLight args={['#9fb4d8', '#0b1a45', 0.2]} />

      <group position={groupPos} quaternion={frame}>
      <group position={pivot.clone().negate()}>

      {showPatch && <Terrain horizon={terrainHorizon} moonR={moonR} kmPerUnit={kmPerUnit} mode={terrainMode} maxDistanceKm={horizon?.maxDistanceKm ?? DEFAULT_HORIZON_KM} />}
      {/* In Lander view the patch uses ×10 curvature to keep angles exact, so the globe would poke through it;
          from the ground the globe is below the horizon anyway. */}
      {terrainMode === 'globe' && <MoonBody quaternion={moonQ} lat={lat} lon={lon} radius={moonR} siteH={siteH} disp={disp} holdUnderPatch={showPatch} kmPerUnit={kmPerUnit} sunDir={sunDirWorld} />}
      <SiteRing />
      {!system && <Compass />}
      <Lander />

      {!system && (
      <>
      {/* Sun */}
      <mesh position={sunPos}>
        <sphereGeometry args={[sunR, 48, 48]} />
        <meshBasicMaterial color="#EAFE07" />
      </mesh>
      <mesh position={sunPos}>
        <sphereGeometry args={[sunR * 1.8, 48, 48]} />
        <meshBasicMaterial color="#EAFE07" transparent opacity={0.08} depthWrite={false} />
      </mesh>
      <Html position={sunPos.clone().add(new Vector3(0, sunR * 2.3, 0))} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <span className={`sim-chip${sunUp ? ' sim-chip--sun' : ' sim-chip--blocked'}`}>Sun {fmt(sky.sunEl)}</span>
      </Html>

      {/* Earth */}
      <group position={earthPos}>
        <TextureBoundary fallback={<EarthBall map={null} radius={earthR} />}>
          <Suspense fallback={<EarthBall map={null} radius={earthR} />}>
            <TexturedEarthBall radius={earthR} />
          </Suspense>
        </TextureBoundary>
      </group>
      <Html position={earthPos.clone().add(new Vector3(0, earthR * 1.6, 0))} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <span className={`sim-chip${earthUp ? ' sim-chip--earth' : ' sim-chip--blocked'}`}>Earth {fmt(sky.earthEl)}</span>
      </Html>

      {/* Lines of sight: colour = backend verdict */}
      <Line points={[MAST_TOP, sunPos]} color={sunUp ? '#EAFE07' : RED} lineWidth={2} dashed={!sunUp} dashSize={2} gapSize={1.5} />
      <Line points={[MAST_TOP, earthPos]} color={earthUp ? '#2E96F5' : RED} lineWidth={2} dashed={!earthUp} dashSize={2} gapSize={1.5} />
      </>
      )}
      </group>
      </group>

      {system && (
        <EarthMoonSystem
          site={toWorld(MAST_TOP)}
          moonCentre={moonCentreWorld}
          sunUp={sunUp}
          earthUp={earthUp}
          sunLabel={`Sun ${fmt(sky.sunEl)}`}
          earthLabel={`Earth ${fmt(sky.earthEl)}`}
          earthR={EARTH_RADIUS_KM / kmPerUnit}
        />
      )}

      <CameraRig
        mode={camera}
        sunAz={sky.sunAz}
        sunWorld={sunWorld}
        earthWorld={earthWorld}
        siteWorld={siteWorld}
        bodies={
          system
            ? [
                [new Vector3(), D_ORBIT + moonR],
                [new Vector3(), EARTH_RADIUS_KM / kmPerUnit],
              ]
            : [
                [toWorld(pivot), moonR],
                [sunWorld, SUN_R.far * 1.8],
                [earthWorld, EARTH_R.far],
              ]
        }
      />
    </Canvas>
  );
}

/** Which camera shows the Earth–Moon system (Moon orbiting the Earth). */
export const isSystemView = (camera: CameraMode) => camera === 'overview';

/**
 * Earth at the centre (true size vs the Moon), the Moon's orbit, sunlight arriving from +X, and the two
 * lines of sight from the landing site — coloured by the backend verdict.
 */
function EarthMoonSystem({
  site,
  moonCentre,
  sunUp,
  earthUp,
  sunLabel,
  earthLabel,
  earthR,
}: {
  site: Vector3;
  moonCentre: Vector3;
  sunUp: boolean;
  earthUp: boolean;
  sunLabel: string;
  earthLabel: string;
  earthR: number;
}) {
  const orbit = useMemo(() => {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * 2 * Math.PI;
      pts.push(new Vector3(Math.cos(a) * D_ORBIT, 0, Math.sin(a) * D_ORBIT));
    }
    return pts;
  }, []);
  // The line of sight ends at the Sun marker, so it visibly "leads to the Sun". (Sunlight itself is lit as
  // parallel rays from +X; the marker is only a direction sign — the real Sun is ~400× farther.)
  const sunMarker = new Vector3(D_SUN_SYSTEM, 0, 0);
  const sunEnd = sunMarker;
  return (
    <>
      <group>
        <TextureBoundary fallback={<EarthBall map={null} radius={earthR} />}>
          <Suspense fallback={<EarthBall map={null} radius={earthR} />}>
            <TexturedEarthBall radius={earthR} />
          </Suspense>
        </TextureBoundary>
      </group>
      <Html position={[0, earthR * 1.35, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <span className={`sim-chip${earthUp ? ' sim-chip--earth' : ' sim-chip--blocked'}`}>{earthLabel}</span>
      </Html>
      <Line points={orbit} color="#c9d6f0" lineWidth={1} transparent opacity={0.35} dashed dashSize={300} gapSize={300} />
      <Html position={moonCentre.clone().add(new Vector3(0, -1300, 0))} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <span className="sim-compass">Moon</span>
      </Html>

      {/* Sun direction marker (the Sun itself is ~400× farther than the Moon is from the Earth) */}
      <mesh position={sunMarker}>
        <sphereGeometry args={[900, 48, 48]} />
        <meshBasicMaterial color="#EAFE07" />
      </mesh>
      <mesh position={sunMarker}>
        <sphereGeometry args={[1600, 48, 48]} />
        <meshBasicMaterial color="#EAFE07" transparent opacity={0.08} depthWrite={false} />
      </mesh>
      <Html position={sunMarker.clone().add(new Vector3(0, 2100, 0))} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <span className={`sim-chip${sunUp ? ' sim-chip--sun' : ' sim-chip--blocked'}`}>{sunLabel} · far away</span>
      </Html>

      <Line points={[site, sunEnd]} color={sunUp ? '#EAFE07' : RED} lineWidth={2} dashed={!sunUp} dashSize={250} gapSize={180} />
      <Line points={[site, new Vector3()]} color={earthUp ? '#2E96F5' : RED} lineWidth={2} dashed={!earthUp} dashSize={250} gapSize={180} />
    </>
  );
}

const fmt = (el: number) => `${el >= 0 ? '+' : ''}${el.toFixed(1)}°`;

/* ---------- Terrain diorama ---------- */

const RINGS_IN = 24; // rings between the pad and the crest
const RINGS_OUT = 8; // rings from the crest to the edge
const R_EDGE = R_RING * 1.1; // outer edge of the patch, where it meets the globe
const LOW = [0.24, 0.26, 0.31]; // valley floor (≈ #3d4250)
const HIGH = [0.74, 0.76, 0.81]; // sunlit crest (≈ #bdc2ce)
const SKIRT = [0.11, 0.13, 0.19];

type TerrainMode = 'angles' | 'globe';

/** Circular moving average — removes 0.5° bin noise that looked like spikes, keeps the shape. */
function smoothProfile(el: number[], half = 1): number[] {
  const n = el.length;
  return el.map((_, i) => {
    let sum = 0;
    for (let k = -half; k <= half; k++) sum += el[(i + k + n) % n];
    return sum / (2 * half + 1);
  });
}

/** Cheap deterministic ripples in x/z (not azimuth, which made streaks converge on the lander). */
function ripple(x: number, z: number) {
  return (
    Math.sin(x * 0.19 + z * 0.07) * 0.35 +
    Math.sin(z * 0.23 - x * 0.11 + 1.3) * 0.3 +
    Math.sin(x * 0.53 + z * 0.47 + 0.4) * 0.2 +
    Math.sin(z * 1.1 - x * 0.9 + 2.2) * 0.15
  );
}

/** Drop of a sphere below the tangent plane after `dKm` (km). */
const curvatureKm = (dKm: number) => (dKm * dKm) / (2 * MOON_RADIUS_KM);

/**
 * Ground around the landing site, built from GET /horizon: in each direction the blocking ridge stands at
 * its real distance (distanceKm) and real height, ×10 vertically — the same scale as the globe.
 *
 * - "globe" (Orbit / Overview / Top-down): relief ×10 on top of the real (not exaggerated) curvature, so the
 *   patch sits on the sphere like the rest of the Moon.
 * - "angles" (Lander view): the whole height above the tangent plane ×10, i.e. tan el' = 10·tan el, the same
 *   rule as the Sun and Earth, so the silhouette from the lander matches the backend exactly.
 */
function Terrain({
  horizon,
  moonR,
  kmPerUnit,
  mode,
  maxDistanceKm,
}: {
  horizon: HorizonProfile | null;
  moonR: number;
  kmPerUnit: number;
  mode: TerrainMode;
  maxDistanceKm: number;
}) {
  const geometry = useMemo(() => {
    const el = horizon ? smoothProfile(horizon.elevationDeg, 2) : new Array<number>(360).fill(0);
    const n = el.length;
    const rawD = horizon?.distanceKm?.length === n ? horizon.distanceKm : new Array<number>(n).fill(maxDistanceKm);
    // Distances jump between ridges; a light smoothing keeps the crest from zig-zagging radially.
    const crestR = smoothProfile(rawD.map((d) => Math.min(R_RING, Math.max(R_PAD + 0.6, d / kmPerUnit))), 2);
    const edgeDropU = curvatureKm(R_EDGE * kmPerUnit) / kmPerUnit;
    const edgeY = mode === 'globe' ? -edgeDropU : -K * edgeDropU;

    const rows = RINGS_IN + RINGS_OUT + 2; // pad edge … crest … edge + skirt
    const pos: number[] = [];
    const heights: number[] = [];
    for (let i = 0; i <= n; i++) {
      const b = i % n;
      const az = (b / n) * 2 * Math.PI;
      const rc = crestR[b];
      const dKm = rc * kmPerUnit;
      const tanEl = Math.tan((el[b] * Math.PI) / 180);
      // Real crest height above the observer's level sphere (km) and the drawn crest height (units).
      const reliefKm = dKm * tanEl + curvatureKm(dKm);
      const yCrest = mode === 'globe' ? (K * reliefKm - curvatureKm(dKm)) / kmPerUnit : (K * dKm * tanEl) / kmPerUnit;
      const lineOfSight = (r: number) => (yCrest * r) / rc;

      for (let k = 0; k <= RINGS_IN + RINGS_OUT; k++) {
        let r: number;
        let y: number;
        if (k <= RINGS_IN) {
          const t = k / RINGS_IN;
          r = R_PAD + (rc - R_PAD) * t;
          const rKm = r * kmPerUnit;
          const bump = ripple(Math.sin(az) * r, -Math.cos(az) * r) * 0.25 * Math.sin(Math.PI * t);
          if (mode === 'globe') {
            y = (K * reliefKm * Math.pow(t, 2.2) - curvatureKm(rKm)) / kmPerUnit + bump;
          } else {
            // Never above the line of sight to the crest: the lander sees exactly the backend silhouette.
            y = Math.min(yCrest * Math.pow(t, 2.2) + bump, lineOfSight(r) - 0.01 * t);
          }
          if (k === RINGS_IN) y = yCrest;
        } else {
          const t = (k - RINGS_IN) / RINGS_OUT;
          r = rc + (R_EDGE - rc) * t;
          const fall = 0.5 - 0.5 * Math.cos(Math.PI * t);
          y = yCrest + (edgeY - yCrest) * fall + ripple(Math.sin(az) * r, -Math.cos(az) * r) * 0.2 * Math.sin(Math.PI * t);
          if (mode === 'angles') y = Math.min(y, lineOfSight(r) - 0.02);
        }
        pos.push(Math.sin(az) * r, y, -Math.cos(az) * r);
        heights.push(y);
      }
      pos.push(Math.sin(az) * (R_EDGE - 0.5), edgeY - 3, -Math.cos(az) * (R_EDGE - 0.5)); // skirt, inside the Moon
      heights.push(Number.NaN);
    }

    const finite = heights.filter(Number.isFinite);
    const yMin = Math.min(...finite, 0);
    const yMax = Math.max(...finite, yMin + 1);
    const colors: number[] = [];
    heights.forEach((y, v) => {
      if (!Number.isFinite(y)) return colors.push(...SKIRT);
      const h = Math.pow((y - yMin) / (yMax - yMin), 0.8);
      const grain = 1 + 0.06 * ripple(pos[v * 3] * 2.3, pos[v * 3 + 2] * 2.3);
      colors.push(...LOW.map((lo, c) => (lo + (HIGH[c] - lo) * h) * grain));
    });

    // Flat pad around the lander
    pos.push(0, 0, 0);
    colors.push(...LOW.map((lo, c) => lo + (HIGH[c] - lo) * Math.pow(-yMin / (yMax - yMin), 0.8)));
    const centre = pos.length / 3 - 1;

    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = i * rows;
      const b = (i + 1) * rows;
      idx.push(centre, a, b);
      for (let k = 0; k < rows - 1; k++) idx.push(a + k, a + k + 1, b + k, b + k, a + k + 1, b + k + 1);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }, [horizon, kmPerUnit, mode, maxDistanceKm]);
  void moonR;

  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.95} metalness={0} side={DoubleSide} />
    </mesh>
  );
}

/** Rotation lunar body frame → landing-site frame (site on top, lunar north towards −Z). */
function moonQuaternion(lat: number, lon: number): Quaternion {
  const up = latLonToVector(lat, lon).normalize();
  const north = latLonToVector(Math.min(lat + 0.01, 89.99), lon).sub(up).projectOnPlane(up).normalize();
  // Near the poles "north" is ill-defined from a tiny step; fall back to the meridian direction.
  if (!Number.isFinite(north.x) || north.lengthSq() < 0.5) north.set(0, 1, 0).projectOnPlane(up).normalize();
  const east = north.clone().cross(up).normalize();
  // Basis (east, up, −north) → (X, Y, Z): invert the matrix whose columns are those vectors.
  const m = new Matrix4().makeBasis(east, up, north.clone().negate()).invert();
  return new Quaternion().setFromRotationMatrix(m);
}

/** Rotation about `axis` that turns `v`'s projection onto the equator plane onto `ref`'s projection. */
function spinToMatch(v: Vector3, ref: Vector3, axis: Vector3): Quaternion {
  const pv = v.clone().projectOnPlane(axis);
  const pr = ref.clone().projectOnPlane(axis);
  if (pv.lengthSq() < 1e-6 || pr.lengthSq() < 1e-6) return new Quaternion();
  const angle = Math.atan2(axis.dot(pv.clone().cross(pr)), pv.dot(pr));
  return new Quaternion().setFromAxisAngle(axis, angle);
}

/**
 * The whole Moon under the patch, at the same horizontal scale as the terrain (km per unit) and with the
 * same ×10 vertical exaggeration when the LOLA elevation map is available — so the landing patch is not
 * the only rough spot on a smooth ball.
 */
function MoonBody({
  quaternion,
  lat,
  lon,
  radius,
  siteH,
  disp,
  holdUnderPatch,
  kmPerUnit,
  sunDir,
}: {
  quaternion: Quaternion;
  lat: number;
  lon: number;
  radius: number;
  siteH: number;
  disp: Texture | null;
  holdUnderPatch: boolean;
  kmPerUnit: number;
  sunDir: Vector3;
}) {
  const site = useMemo(() => latLonToVector(lat, lon).normalize(), [lat, lon]);
  // Relief fades out under the patch (the patch carries its own terrain) and is full beyond ~1.8× its size.
  const patchAngle = R_EDGE / radius;
  const props = { radius, sunDir, disp, site, patchAngle, kmPerUnit, siteH, holdUnderPatch };
  return (
    <group position={[0, -radius - siteH, 0]} quaternion={quaternion}>
      <TextureBoundary fallback={<MoonSphere {...props} map={null} />}>
        <Suspense fallback={<MoonSphere {...props} map={null} />}>
          <TexturedMoonSphere {...props} />
        </Suspense>
      </TextureBoundary>
    </group>
  );
}

/**
 * Height (km vs 1737.4 km) of the displacement map at lat/lon, bilinear — the same value the globe shader
 * uses — so the lander stands exactly on the globe when there is no patch under it.
 */
function useGlobeHeightKm(disp: Texture | null, lat: number, lon: number): number | null {
  const pixels = useMemo(() => {
    const img = disp?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
    if (!img?.width) return null;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return { data: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
  }, [disp]);
  return useMemo(() => {
    if (!pixels) return null;
    const { data, w, h } = pixels;
    // Texture lookup like the shader: u from the left (lon −180°), v from the bottom (image row 0 = north).
    const tex = (u: number, v: number) => {
      const x = (u * w - 0.5 + w) % w;
      const y = Math.min(h - 1, Math.max(0, (1 - v) * h - 0.5));
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = (x0 + 1) % w;
      const y1 = Math.min(h - 1, y0 + 1);
      const g = (xx: number, yy: number) => data[(yy * w + xx) * 4] / 255;
      const fx = x - x0;
      const fy = y - y0;
      return (g(x0, y0) * (1 - fx) + g(x1, y0) * fx) * (1 - fy) + (g(x0, y1) * (1 - fx) + g(x1, y1) * fx) * fy;
    };
    const hAtDir = (d: Vector3) => {
      const n = d.clone().normalize();
      const theta = Math.acos(Math.max(-1, Math.min(1, n.y)));
      let phi = Math.atan2(n.z, -n.x);
      if (phi < 0) phi += 2 * Math.PI;
      return tex(phi / (2 * Math.PI), 1 - theta / Math.PI);
    };
    // The globe only samples the map at its cube-sphere vertices: interpolate between the 4 vertices around
    // the site — that is where the drawn surface actually is.
    const d = latLonToVector(lat, lon).normalize();
    const ax = Math.abs(d.x) >= Math.abs(d.y) && Math.abs(d.x) >= Math.abs(d.z) ? 'x' : Math.abs(d.y) >= Math.abs(d.z) ? 'y' : 'z';
    const others = (['x', 'y', 'z'] as const).filter((k) => k !== ax);
    const major = d[ax];
    const cube = d.clone().divideScalar(Math.abs(major)); // point on the cube face
    const cell = (t: number) => {
      const g = ((t + 1) / 2) * CUBE_SEGMENTS;
      const i0 = Math.min(CUBE_SEGMENTS - 1, Math.floor(g));
      return { a: (i0 / CUBE_SEGMENTS) * 2 - 1, b: ((i0 + 1) / CUBE_SEGMENTS) * 2 - 1, f: g - i0 };
    };
    const ca = cell(cube[others[0]]);
    const cb = cell(cube[others[1]]);
    const corner = (a: number, b: number) => {
      const c = cube.clone();
      c[others[0]] = a;
      c[others[1]] = b;
      return hAtDir(c);
    };
    const g =
      (corner(ca.a, cb.a) * (1 - ca.f) + corner(ca.b, cb.a) * ca.f) * (1 - cb.f) +
      (corner(ca.a, cb.b) * (1 - ca.f) + corner(ca.b, cb.b) * ca.f) * cb.f;
    return g * 20 - 10;
  }, [pixels, lat, lon]);
}

/** Loads a texture if the file exists; null (no error) when it does not. */
function useOptionalTexture(url: string): Texture | null {
  const [tex, setTex] = useState<Texture | null>(null);
  useEffect(() => {
    let alive = true;
    new TextureLoader().load(
      url,
      (t) => {
        t.minFilter = LinearFilter;
        t.generateMipmaps = false;
        if (alive) setTex(t);
      },
      undefined,
      () => console.info(`Optional ${url} not found — the Moon globe stays smooth (see README).`),
    );
    return () => {
      alive = false;
    };
  }, [url]);
  return tex;
}

interface SphereProps {
  radius: number;
  sunDir: Vector3;
  disp: Texture | null;
  site: Vector3;
  patchAngle: number;
  kmPerUnit: number;
  /** Height of the site on the ×10 globe (units); the globe is held at it under the patch. */
  siteH: number;
  /** false = no patch on top: show the real relief right up to the site. */
  holdUnderPatch: boolean;
}

function TexturedMoonSphere(props: SphereProps) {
  const map = useLoader(TextureLoader, MOON_TEXTURE_URL);
  map.colorSpace = SRGBColorSpace;
  map.anisotropy = 8;
  return <MoonSphere {...props} map={map} />;
}

/**
 * The globe is lit by its own tiny shader from the real Sun direction: the scene's directional light
 * follows the backend verdict at the landing site (dim when the site is in shadow), which must not
 * turn the whole Moon dark.
 */
const UV_FROM_DIR = `
vec2 uvFromDir(vec3 d) {
  float theta = acos(clamp(d.y, -1.0, 1.0));
  float phi = atan(d.z, -d.x);
  if (phi < 0.0) phi += 6.283185307179586;
  return vec2(phi / 6.283185307179586, 1.0 - theta / 3.141592653589793);
}`;

const MOON_VERT = `
uniform sampler2D disp;
uniform bool hasDisp;
uniform float radius;
uniform float unitsPerKm;
uniform vec3 site;
uniform float fadeIn;
uniform float fadeFull;
uniform bool holdUnderPatch;
uniform float siteH;
varying vec3 vDir;
varying vec3 vNormalW;
${UV_FROM_DIR}

float heightAt(vec3 dir) {
  if (!hasDisp) return 0.0;
  float km = texture2D(disp, uvFromDir(dir)).r * 20.0 - 10.0;
  if (!holdUnderPatch) return km * unitsPerKm;
  // Under the patch the globe stays (a bit below) the site's own height; the real relief takes over around it.
  float angle = acos(clamp(dot(dir, site), -1.0, 1.0));
  return mix(siteH - 1.5, km * unitsPerKm, smoothstep(fadeIn, fadeFull, angle));
}
vec3 posAt(vec3 dir) {
  return dir * (radius + heightAt(dir));
}
void main() {
  vec3 d = normalize(position); // cube vertex → sphere direction (no pole singularity)
  vDir = d;
  vec3 p = posAt(d);
  vec3 n = d;
  if (hasDisp) {
    vec3 t1 = normalize(cross(d, abs(d.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(d, t1);
    float e = 0.0015;
    vec3 c = cross(posAt(normalize(d + t1 * e)) - p, posAt(normalize(d + t2 * e)) - p);
    if (length(c) > 1e-9) n = normalize(c) * sign(dot(c, d));
  }
  vNormalW = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const MOON_FRAG = `
uniform sampler2D map;
uniform bool hasMap;
uniform vec3 sunDir;
varying vec3 vDir;
varying vec3 vNormalW;
${UV_FROM_DIR}
void main() {
  // uv per pixel from the direction: no seam or pole artefacts from per-vertex uv interpolation.
  vec2 uv = uvFromDir(normalize(vDir));
  vec3 base = vec3(0.54, 0.56, 0.61);
  if (hasMap) {
    // Gradients from a copy shifted by half a turn avoid a blurred seam line where u wraps 1 → 0.
    vec2 uvB = vec2(fract(uv.x + 0.5), uv.y);
    vec2 dx = dFdx(uv), dy = dFdy(uv), dxB = dFdx(uvB), dyB = dFdy(uvB);
    if (abs(dxB.x) + abs(dyB.x) < abs(dx.x) + abs(dy.x)) { dx.x = dxB.x; dy.x = dyB.x; }
    base = textureGrad(map, uv, dx, dy).rgb;
  }
  float light = 0.05 + 1.05 * max(dot(normalize(vNormalW), sunDir), 0.0);
  gl_FragColor = vec4(base * light, 1.0);
  #include <colorspace_fragment>
}`;

/**
 * The globe is lit by its own small shader from the real Sun direction: the scene's directional light
 * follows the backend verdict at the landing site (dim when the site is in shadow), which must not
 * turn the whole Moon dark. With the LOLA map it is also displaced ×10 like the patch.
 */
function MoonSphere({ radius, map, sunDir, disp, site, patchAngle, kmPerUnit, siteH, holdUnderPatch }: SphereProps & { map: Texture | null }) {
  const uniforms = useMemo(
    () => ({
      map: { value: map },
      hasMap: { value: !!map },
      disp: { value: disp },
      hasDisp: { value: !!disp },
      radius: { value: radius },
      unitsPerKm: { value: K / kmPerUnit },
      site: { value: site },
      fadeIn: { value: patchAngle * 1.08 },
      fadeFull: { value: patchAngle * 1.6 },
      siteH: { value: siteH },
      holdUnderPatch: { value: holdUnderPatch },
      sunDir: { value: new Vector3(0, 1, 0) },
    }),
    [map, disp, radius, kmPerUnit, site, patchAngle, siteH, holdUnderPatch],
  );
  uniforms.sunDir.value.copy(sunDir);
  return (
    // The unit cube is blown up to the Moon's size in the vertex shader, so three.js cannot cull it correctly.
    <mesh frustumCulled={false}>
      <boxGeometry args={[2, 2, 2, CUBE_SEGMENTS, CUBE_SEGMENTS, CUBE_SEGMENTS]} />
      <shaderMaterial vertexShader={MOON_VERT} fragmentShader={MOON_FRAG} uniforms={uniforms} />
    </mesh>
  );
}

/** Yellow ring around the pad so the landing site stays findable when zoomed out. */
function SiteRing() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
      <ringGeometry args={[1.6, 1.8, 64]} />
      <meshBasicMaterial color="#EAFE07" transparent opacity={0.8} side={DoubleSide} depthTest={false} />
    </mesh>
  );
}

/** N / E / S / W on the ground just outside the crest. */
function Compass() {
  return (
    <>
      {(['N', 'E', 'S', 'W'] as const).map((label, i) => {
        const p = azElToVector(i * 90, 0, R_EDGE + 4);
        return (
          <Html key={label} position={[p.x, 2, p.z]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
            <span className="sim-compass">{label}</span>
          </Html>
        );
      })}
    </>
  );
}

function Lander() {
  return (
    <group scale={LANDER_SCALE}>
      <mesh position={[0, 0.55, 0]} castShadow>
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
      <mesh position={[0, 1.3, 0]}>
        <sphereGeometry args={[0.08, 16, 16]} />
        <meshBasicMaterial color="#EAFE07" />
      </mesh>
    </group>
  );
}

function TexturedEarthBall({ radius }: { radius: number }) {
  const map = useLoader(TextureLoader, EARTH_TEXTURE_URL);
  map.colorSpace = SRGBColorSpace;
  return <EarthBall map={map} radius={radius} />;
}

function EarthBall({ map, radius }: { map: Texture | null; radius: number }) {
  return (
    <mesh>
      <sphereGeometry args={[radius, 64, 48]} />
      <meshStandardMaterial map={map} color={map ? '#ffffff' : '#2E96F5'} emissiveMap={map} emissive={map ? '#ffffff' : '#0960E1'} emissiveIntensity={0.35} />
    </mesh>
  );
}

/** Orbit around the lander, stand at the mast (look around), or look straight down. */
function CameraRig({
  mode,
  sunAz,
  sunWorld,
  earthWorld,
  siteWorld,
  bodies,
}: {
  mode: CameraMode;
  sunAz: number;
  sunWorld: Vector3;
  earthWorld: Vector3;
  siteWorld: Vector3;
  /** Spheres (centre, radius) the Overview camera must fit in the frame: Moon, Sun, Earth. */
  bodies: [Vector3, number][];
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const cam = useThree((s) => s.camera);
  // Orbit / Top-down follow the landing site while the Moon turns (at non-polar sites it travels).
  const lastSite = useRef(siteWorld.clone());
  useFrame(() => {
    const c = controls.current;
    if (!c) return;
    const delta = siteWorld.clone().sub(lastSite.current);
    lastSite.current.copy(siteWorld);
    if ((mode === 'orbit' || mode === 'top') && delta.lengthSq() > 0) {
      cam.position.add(delta);
      c.target.add(delta);
      c.update();
    }
  });

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    lastSite.current.copy(siteWorld);
    if (mode === 'orbit') {
      cam.position.set(10, 5, 13).add(siteWorld);
      c.target.set(0, 0.3, 0).add(siteWorld);
    } else if (mode === 'overview') {
      // Look at the Moon's centre from 70° off the Sun direction (mostly lit side), on the side where the
      // Earth sits closer to the middle of the frame.
      // Frame all three bodies: centre of their bounding box, far enough back that the bounding sphere fits
      // the vertical field of view (with a margin for the labels).
      const min = new Vector3(Infinity, Infinity, Infinity);
      const max = new Vector3(-Infinity, -Infinity, -Infinity);
      for (const [p, r] of bodies) {
        min.min(p.clone().subScalar(r));
        max.max(p.clone().addScalar(r));
      }
      const centre = min.clone().add(max).multiplyScalar(0.5);
      const fitR = Math.max(...bodies.map(([p, r]) => p.distanceTo(centre) + r));
      const fov = ((cam as PerspectiveCamera).fov * Math.PI) / 180;
      const aspect = (cam as PerspectiveCamera).aspect || 1.6;
      const halfFov = Math.min(fov / 2, Math.atan(Math.tan(fov / 2) * aspect));
      const dist = (fitR / Math.sin(halfFov)) * 1.12;
      const sunDirH = sunWorld.clone().sub(centre).setY(0).normalize();
      const candidates = [70, -70].map((deg) => {
        const dir = sunDirH.clone().applyAxisAngle(new Vector3(0, 1, 0), (deg * Math.PI) / 180);
        // ~20° above the equator plane of the frame
        return centre.clone().add(dir.multiplyScalar(dist * 0.94)).add(new Vector3(0, dist * 0.34, 0));
      });
      const offAxis = (eye: Vector3) => earthWorld.clone().sub(eye).angleTo(centre.clone().sub(eye));
      cam.position.copy(offAxis(candidates[0]) <= offAxis(candidates[1]) ? candidates[0] : candidates[1]);
      c.target.copy(centre);
    } else if (mode === 'lander') {
      // Eye at the mast; a target 0.01 away turns orbiting into "look around".
      const look = azElToVector(sunAz, 4, 0.01);
      cam.position.set(0, MAST_TOP.y + 0.03, 0);
      c.target.set(look.x, MAST_TOP.y + 0.03 + look.y, look.z);
    } else {
      cam.position.set(0, 180, 0.01).add(siteWorld);
      c.target.copy(siteWorld);
    }
    c.update();
    // Only when the mode changes — not on every Sun move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cam]);
  // (overview uses the Sun/Earth azimuths at the moment the mode is picked)

  return (
    <OrbitControls
      ref={controls}
      enablePan={false}
      enableZoom={mode !== 'lander'}
      enableDamping
      minDistance={mode === 'top' ? 10 : 1.5}
      maxDistance={MAX_ORBIT_DISTANCE}
      zoomSpeed={1.2}
      maxPolarAngle={mode === 'orbit' || mode === 'overview' ? Math.PI * 0.49 : Math.PI}
      rotateSpeed={mode === 'lander' ? -0.35 : 0.8}
    />
  );
}
