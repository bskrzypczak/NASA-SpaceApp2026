import { Suspense, useEffect } from 'react';
import { useLoader, useThree } from '@react-three/fiber';
import { Stars } from '@react-three/drei';
import { EquirectangularReflectionMapping, SRGBColorSpace, TextureLoader } from 'three';
import { TextureBoundary } from '../moon/TextureBoundary';

/** Put a star map here (see README → "Starry sky"). */
export const STAR_MAP_URL = '/textures/starmap.jpg';

/** Starry sky for any <Canvas>: NASA star map if present, procedural stars otherwise. */
export function SpaceBackground({ intensity = 0.6 }: { intensity?: number }) {
  return (
    <>
      <color attach="background" args={['#020611']} />
      <TextureBoundary fallback={<ProceduralStars />}>
        <Suspense fallback={<ProceduralStars />}>
          <StarMapBackground intensity={intensity} />
        </Suspense>
      </TextureBoundary>
    </>
  );
}

/** Real all-sky star map (NASA SVS Deep Star Maps) as the scene background. */
function StarMapBackground({ intensity }: { intensity: number }) {
  const tex = useLoader(TextureLoader, STAR_MAP_URL);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    tex.mapping = EquirectangularReflectionMapping;
    tex.colorSpace = SRGBColorSpace;
    const prev = { bg: scene.background, intensity: scene.backgroundIntensity };
    scene.background = tex;
    scene.backgroundIntensity = intensity; // keep stars subtle so the UI stays readable
    return () => {
      scene.background = prev.bg;
      scene.backgroundIntensity = prev.intensity;
    };
  }, [tex, scene, intensity]);
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
