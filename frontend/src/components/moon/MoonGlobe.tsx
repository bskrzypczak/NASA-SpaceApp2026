import { useMemo, useRef, useState, type RefObject } from 'react';
import { useFrame, useLoader, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Group, Quaternion, SRGBColorSpace, TextureLoader, Vector3, type Texture } from 'three';
import { useSelection } from '../../store/selection';
import { SITES } from '../../data/sites';
import { latLonToVector, vectorToLatLon } from '../../lib/geo';
import { formatLat, formatLon, type LatLon } from '../../lib/coords';

/** Put the Moon color map here (see README → "Moon texture"). */
export const MOON_TEXTURE_URL = '/textures/moon_color.jpg';

const UP = new Vector3(0, 1, 0);

interface GlobeProps {
  /** Called on every hover move (null when the cursor leaves the Moon). */
  onHover: (p: LatLon | null) => void;
  /** Called when the user picks a point by clicking the surface or a marker. */
  onPick: () => void;
}

/** Loads the texture (suspends while loading). Wrap in <Suspense> + an error boundary. */
export function TexturedMoonGlobe(props: GlobeProps) {
  const map = useLoader(TextureLoader, MOON_TEXTURE_URL);
  map.colorSpace = SRGBColorSpace;
  map.anisotropy = 8;
  return <MoonGlobe {...props} map={map} />;
}

/** The Moon sphere, the catalog markers and the selection pin. Works without a texture (grey Moon). */
export function MoonGlobe({ onHover, onPick, map }: GlobeProps & { map?: Texture | null }) {
  const { lat, lon, name, selectSite } = useSelection();

  function handleClick(e: ThreeEvent<MouseEvent>) {
    // Ignore the click that ends a drag-to-rotate.
    if (e.delta > 4) return;
    e.stopPropagation();
    onPick();
    selectSite({ ...vectorToLatLon(e.point), name: null });
  }

  return (
    <group>
      <mesh
        onClick={handleClick}
        onPointerMove={(e) => onHover(vectorToLatLon(e.point))}
        onPointerOut={() => onHover(null)}
      >
        <sphereGeometry args={[1, 192, 128]} />
        <meshStandardMaterial map={map ?? null} color={map ? '#ffffff' : '#9aa1b0'} roughness={1} metalness={0} />
      </mesh>

      {SITES.map((s) => (
        <SiteMarker
          key={s.id}
          lat={s.lat}
          lon={s.lon}
          label={s.name}
          onSelect={() => {
            onPick();
            selectSite({ lat: s.lat, lon: s.lon, name: s.name });
          }}
        />
      ))}

      <Pin lat={lat} lon={lon} label={name ?? 'Custom point'} />
    </group>
  );
}

/** Keeps markers a similar size on screen at any zoom, like map pins. */
function useScreenScale(ref: RefObject<Group>, base: number) {
  useFrame(({ camera }) => {
    if (!ref.current) return;
    const dist = camera.position.distanceTo(ref.current.getWorldPosition(new Vector3()));
    ref.current.scale.setScalar(Math.max(0.02, Math.min(1.5, dist * base)));
  });
}

function surfaceTransform(lat: number, lon: number, lift = 1.0015) {
  const pos = latLonToVector(lat, lon, lift);
  const quat = new Quaternion().setFromUnitVectors(UP, pos.clone().normalize());
  return { pos, quat };
}

function SiteMarker({ lat, lon, label, onSelect }: { lat: number; lon: number; label: string; onSelect: () => void }) {
  const ref = useRef<Group>(null);
  const [hovered, setHovered] = useState(false);
  const { pos, quat } = useMemo(() => surfaceTransform(lat, lon), [lat, lon]);
  useScreenScale(ref, 0.5);

  return (
    <group ref={ref} position={pos} quaternion={quat}>
      <mesh
        onClick={(e) => {
          if (e.delta > 4) return;
          e.stopPropagation();
          onSelect();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = '';
        }}
      >
        <sphereGeometry args={[0.012, 16, 16]} />
        <meshBasicMaterial color={hovered ? '#EAFE07' : '#ffffff'} />
      </mesh>
      {hovered && (
        <Html center position={[0, 0.05, 0]} style={{ pointerEvents: 'none' }}>
          <span className="moon-marker-label">{label}</span>
        </Html>
      )}
    </group>
  );
}

function Pin({ lat, lon, label }: { lat: number; lon: number; label: string }) {
  const ref = useRef<Group>(null);
  const { pos, quat } = useMemo(() => surfaceTransform(lat, lon, 1.0), [lat, lon]);
  useScreenScale(ref, 0.6);

  return (
    <group ref={ref} position={pos} quaternion={quat}>
      <mesh position={[0, 0.035, 0]}>
        <cylinderGeometry args={[0.003, 0.003, 0.07, 8]} />
        <meshBasicMaterial color="#EAFE07" />
      </mesh>
      <mesh position={[0, 0.075, 0]}>
        <sphereGeometry args={[0.016, 24, 24]} />
        <meshBasicMaterial color="#EAFE07" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}>
        <ringGeometry args={[0.02, 0.028, 40]} />
        <meshBasicMaterial color="#EAFE07" transparent opacity={0.8} />
      </mesh>
      <Html center occlude position={[0, 0.13, 0]} style={{ pointerEvents: 'none' }}>
        <div className="moon-pin-label" role="status">
          <strong>{label}</strong>
          <span>
            {formatLat(lat)} · {formatLon(lon)}
          </span>
        </div>
      </Html>
    </group>
  );
}
