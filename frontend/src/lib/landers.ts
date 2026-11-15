import type { Hardware } from '../api/types';

/**
 * Lander presets. The simulation is only as good as these numbers, so every preset says where
 * its values come from and which ones are our assumptions.
 */
export interface LanderPreset {
  id: 'reference' | 'small-clps' | 'night-survivor';
  name: string;
  short: string;
  hardware: Hardware;
  /** One line shown under the preset: sources and assumptions. */
  basis: string;
}

const MOUNT = { reservePct: 20, panelHeightM: 2, mastHeightM: 3.5 };

export const LANDER_PRESETS: LanderPreset[] = [
  {
    id: 'reference',
    name: 'Reference lander (VIPER-class)',
    short: 'Reference · VIPER-class',
    hardware: { batteryWh: 5_400, solarW: 450, dayLoadW: 200, nightLoadW: 80, ...MOUNT },
    basis:
      'Battery and array from NASA VIPER (5,420 Wh, 450 W peak). Loads assumed: 80 W at night ≈ 54 h of darkness to the 20 % reserve, close to VIPER’s ~50 h low-power survival.',
  },
  {
    id: 'small-clps',
    name: 'Small CLPS lander (Nova-C-class)',
    short: 'Small CLPS · Nova-C-class',
    hardware: { batteryWh: 700, solarW: 200, dayLoadW: 150, nightLoadW: 60, ...MOUNT },
    basis: 'Array 200 W and ~0.7 kWh battery (25 Ah at 28 V) as on Nova-C. Loads assumed. Built for one lunar day — expect it to fail at the first long night.',
  },
  {
    id: 'night-survivor',
    name: 'Night-survival concept (20 kWh)',
    short: 'Night-survival · 20 kWh',
    hardware: { batteryWh: 20_000, solarW: 600, dayLoadW: 300, nightLoadW: 140, ...MOUNT },
    basis: 'Hypothetical lander sized to ride out ~4–5 days of darkness. Larger battery than any lander flown so far (our previous default).',
  },
];

export const REFERENCE_LANDER = LANDER_PRESETS[0];

const KEYS: (keyof Hardware)[] = ['batteryWh', 'solarW', 'dayLoadW', 'nightLoadW', 'reservePct', 'panelHeightM', 'mastHeightM'];

export function presetFor(hw: Partial<Hardware> | undefined): LanderPreset | null {
  const full = { ...REFERENCE_LANDER.hardware, ...hw };
  return LANDER_PRESETS.find((p) => KEYS.every((k) => p.hardware[k] === full[k])) ?? null;
}

export function landerName(hw: Partial<Hardware> | undefined, short = false): string {
  const p = presetFor(hw);
  return p ? (short ? p.short : p.name) : 'Custom lander';
}

/** Hours of darkness the battery covers from full charge down to the reserve. */
export function nightEnduranceH(hw: Hardware): number {
  return hw.nightLoadW > 0 ? (hw.batteryWh * (1 - hw.reservePct / 100)) / hw.nightLoadW : Infinity;
}
