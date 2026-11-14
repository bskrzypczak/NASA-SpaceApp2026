import { Suspense, useMemo, useRef } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { Html, Line, OrbitControls } from '@react-three/drei';
import { BackSide, CatmullRomCurve3, CubicBezierCurve3, Mesh, Quaternion, SRGBColorSpace, TextureLoader, Vector3, type Curve, type Texture } from 'three';
import { SpaceBackground } from '../space/SpaceBackground';
import { TextureBoundary } from '../moon/TextureBoundary';
import { MOON_TEXTURE_URL } from '../moon/MoonGlobe';
import { latLonToVector } from '../../lib/geo';
import type { LaunchSite } from '../../data/launchSites';
import type { LatLon } from '../../lib/coords';
import type { TransferType } from '../../store/selection';
import { EARTH_MOON_DISTANCE_KM, TRANSFERS, formatDuration, totalHours } from '../../data/route';

/** NASA Blue Marble, equirectangular, left edge 180° W (see README → "Earth texture"). */
export const EARTH_TEXTURE_URL = '/textures/earth_color.jpg';

// Not to scale: Earth and Moon pulled together so both fit the dialog.
const EARTH_POS = new Vector3(-2.7, -0.3, 0);
const EARTH_R = 1;
const MOON_POS = new Vector3(2.9, 0.55, -0.3);
const MOON_R = 0.27; // real Moon/Earth size ratio
const Y = new Vector3(0, 1, 0);

interface RouteSceneProps {
  launch: LaunchSite;
  landing: LatLon;
  transfer: TransferType;
  onTransferChange: (t: TransferType) => void;
}

/** Earth → Moon route picture: launch pad, transfer arc with leg chips, landing pin, alternative route in grey. */
export function RouteScene({ launch, landing, transfer, onTransferChange }: RouteSceneProps) {
  const geo = useMemo(() => buildGeometry(launch, landing), [launch, landing]);
  const other: TransferType = transfer === 'direct' ? 'low-energy' : 'direct';
  const active = TRANSFERS[transfer];
  const curves = { direct: geo.direct, 'low-energy': geo.lowEnergy };

  return (
    <Canvas camera={{ position: [0.3, 1.6, 9], fov: 40 }} aria-label={`Route from ${launch.name} to the landing site`}>
      <SpaceBackground intensity={0.55} />
      <ambientLight intensity={0.8} />
      {/* Sun roughly behind the camera so the visible faces of Earth and Moon are lit */}
      <directionalLight position={[2, 3, 9]} intensity={2.2} />

      {/* Earth */}
      <group position={EARTH_POS} rotation={[0, geo.earthYaw, 0]}>
        <TextureBoundary fallback={<EarthBody map={null} />}>
          <Suspense fallback={<EarthBody map={null} />}>
            <TexturedEarth />
          </Suspense>
        </TextureBoundary>
        <SurfacePin position={latLonToVector(launch.lat, launch.lon, EARTH_R)} label={launch.short} />
      </group>
      {/* thin atmosphere rim */}
      <mesh position={EARTH_POS}>
        <sphereGeometry args={[EARTH_R * 1.035, 64, 64]} />
        <meshBasicMaterial color="#2E96F5" transparent opacity={0.18} side={BackSide} />
      </mesh>

      {/* Moon */}
      <group position={MOON_POS} quaternion={geo.moonQuat}>
        <TextureBoundary fallback={<MoonBody map={null} />}>
          <Suspense fallback={<MoonBody map={null} />}>
            <TexturedMoon />
          </Suspense>
        </TextureBoundary>
        <SurfacePin position={latLonToVector(landing.lat, landing.lon, MOON_R)} label="Landing site" small />
      </group>

      {/* Alternative route first (underneath), like Google Maps */}
      <Line points={curves[other].getPoints(160)} color="#C9D6F0" lineWidth={3} transparent opacity={0.35} dashed dashSize={0.12} gapSize={0.1} />
      <Html position={curves[other].getPoint(0.55)} center zIndexRange={[30, 0]}>
        <button type="button" className="route-chip route-chip--alt" onClick={() => onTransferChange(other)}>
          {formatDuration(totalHours(TRANSFERS[other]))} · {TRANSFERS[other].tagline}
        </button>
      </Html>

      {/* Active route */}
      <Line points={curves[transfer].getPoints(200)} color="#EAFE07" lineWidth={4} />
      <Line points={[geo.approach, geo.landingWorld]} color="#EAFE07" lineWidth={2} dashed dashSize={0.05} gapSize={0.04} />
      <Spacecraft curve={curves[transfer]} />

      <Html position={curves[transfer].getPoint(0.1).add(new Vector3(0, 0.35, 0))} center zIndexRange={[30, 0]}>
        <span className="route-chip">TLI · +{active.legs[0].hours} h</span>
      </Html>
      <Html position={curves[transfer].getPoint(transfer === 'direct' ? 0.5 : 0.35).add(new Vector3(0, 0.45, 0))} center zIndexRange={[30, 0]}>
        <span className="route-chip route-chip--main">
          {formatDuration(totalHours(active))} · {transfer === 'direct' ? `${EARTH_MOON_DISTANCE_KM.toLocaleString('en-US')} km` : 'longer path'}
        </span>
      </Html>
      <Html position={geo.approach.clone().add(new Vector3(0.1, 0.4, 0))} center zIndexRange={[30, 0]}>
        <span className="route-chip">LOI · {formatDuration(active.legs[2].hours)}</span>
      </Html>

      <OrbitControls enablePan={false} minDistance={6} maxDistance={13} target={[0.2, 0.3, 0]} enableDamping />
    </Canvas>
  );
}

function buildGeometry(launch: LaunchSite, landing: LatLon) {
  // Earth: spin around its axis (north stays up) so the pad faces the Moon / camera.
  const pad = latLonToVector(launch.lat, launch.lon, EARTH_R);
  const padAz = Math.atan2(pad.z, pad.x);
  const facing = Math.atan2(0.9, 1); // toward +x (Moon) and +z (camera)
  const earthYaw = padAz - facing;
  const launchWorld = pad.clone().applyAxisAngle(Y, earthYaw).add(EARTH_POS);

  // Moon: turn the landing site toward Earth and the camera.
  const site = latLonToVector(landing.lat, landing.lon, 1).normalize();
  const moonQuat = new Quaternion().setFromUnitVectors(site, new Vector3(-0.65, 0.35, 0.68).normalize());
  const landingWorld = site.clone().multiplyScalar(MOON_R).applyQuaternion(moonQuat).add(MOON_POS);
  const outward = landingWorld.clone().sub(MOON_POS).normalize();
  const approach = MOON_POS.clone().add(outward.multiplyScalar(MOON_R * 2.1));

  const direct: Curve<Vector3> = new CubicBezierCurve3(
    launchWorld,
    launchWorld.clone().add(new Vector3(0.6, 2.3, 0.6)),
    approach.clone().add(new Vector3(-1.6, 1.3, 0.5)),
    approach,
  );
  const lowEnergy: Curve<Vector3> = new CatmullRomCurve3([
    launchWorld,
    new Vector3(-1.2, 2.4, 0.6),
    new Vector3(2.6, 2.9, -0.4),
    new Vector3(6.0, 1.6, -0.8),
    new Vector3(6.2, -0.9, -0.4),
    new Vector3(4.3, -1.2, 0.2),
    approach,
  ]);
  return { earthYaw, moonQuat, landingWorld, approach, direct, lowEnergy };
}

function TexturedEarth() {
  const map = useLoader(TextureLoader, EARTH_TEXTURE_URL);
  map.colorSpace = SRGBColorSpace;
  map.anisotropy = 8;
  return <EarthBody map={map} />;
}

function EarthBody({ map }: { map: Texture | null }) {
  return (
    <mesh>
      <sphereGeometry args={[EARTH_R, 96, 64]} />
      <meshStandardMaterial
        map={map}
        color={map ? '#ffffff' : '#0960E1'}
        // Blue Marble oceans are very dark; a little self-light keeps Earth readable on the night side.
        emissiveMap={map}
        emissive={map ? '#ffffff' : '#000000'}
        emissiveIntensity={0.35}
        roughness={0.85}
        metalness={0}
      />
    </mesh>
  );
}

function TexturedMoon() {
  const map = useLoader(TextureLoader, MOON_TEXTURE_URL);
  map.colorSpace = SRGBColorSpace;
  return <MoonBody map={map} />;
}

function MoonBody({ map }: { map: Texture | null }) {
  return (
    <mesh>
      <sphereGeometry args={[MOON_R, 64, 48]} />
      <meshStandardMaterial map={map} color={map ? '#ffffff' : '#9aa1b0'} roughness={1} metalness={0} />
    </mesh>
  );
}

function SurfacePin({ position, label, small = false }: { position: Vector3; label: string; small?: boolean }) {
  const s = small ? 0.5 : 1;
  const quat = useMemo(() => new Quaternion().setFromUnitVectors(Y, position.clone().normalize()), [position]);
  return (
    <group position={position} quaternion={quat}>
      <mesh position={[0, 0.06 * s, 0]}>
        <cylinderGeometry args={[0.006 * s, 0.006 * s, 0.12 * s, 8]} />
        <meshBasicMaterial color="#EAFE07" />
      </mesh>
      <mesh position={[0, 0.13 * s, 0]}>
        <sphereGeometry args={[0.03 * s, 20, 20]} />
        <meshBasicMaterial color="#EAFE07" />
      </mesh>
      <Html position={[0, 0.25 * s, 0]} center zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
        <span className="route-chip route-chip--pin">{label}</span>
      </Html>
    </group>
  );
}

/** A small craft travelling along the active route. */
function Spacecraft({ curve }: { curve: Curve<Vector3> }) {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.position.copy(curve.getPoint((clock.elapsedTime * 0.07) % 1));
  });
  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.05, 16, 16]} />
      <meshBasicMaterial color="#FFFFFF" />
    </mesh>
  );
}