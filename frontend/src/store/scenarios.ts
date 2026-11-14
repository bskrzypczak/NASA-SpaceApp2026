import { create } from 'zustand';
import type { ScenarioRequirements } from '../api/types';

export const MAX_SCENARIOS = 4;

/** One row in the comparison: a site + landing date (+ mission length). */
export interface ScenarioDraft {
  id: string;
  label: string;
  name: string | null;
  lat: number;
  lon: number;
  /** "YYYY-MM-DDTHH:mm" UTC, same format as the selection store */
  landingTime: string;
  missionDays: number;
}

interface ScenariosState {
  items: ScenarioDraft[];
  requirements: ScenarioRequirements;
  add: (s: Omit<ScenarioDraft, 'id'>) => boolean;
  remove: (id: string) => void;
  rename: (id: string, label: string) => void;
  setRequirements: (r: Partial<ScenarioRequirements>) => void;
  clear: () => void;
}

let seq = 0;

export const useScenarios = create<ScenariosState>((set, get) => ({
  items: [],
  requirements: { minSocPct: 20, minEarthVisiblePct: 50 },
  add: (s) => {
    const items = get().items;
    if (items.length >= MAX_SCENARIOS) return false;
    const dup = items.some((x) => x.lat === s.lat && x.lon === s.lon && x.landingTime === s.landingTime && x.missionDays === s.missionDays);
    if (dup) return false;
    set({ items: [...items, { ...s, id: `sc${++seq}` }] });
    return true;
  },
  remove: (id) => set((st) => ({ items: st.items.filter((x) => x.id !== id) })),
  rename: (id, label) => set((st) => ({ items: st.items.map((x) => (x.id === id ? { ...x, label } : x)) })),
  setRequirements: (r) => set((st) => ({ requirements: { ...st.requirements, ...r } })),
  clear: () => set({ items: [] }),
}));

/** "YYYY-MM-DDTHH:mm" + days → same format. */
export function shiftDays(landingTime: string, days: number) {
  return new Date(Date.parse(`${landingTime}:00Z`) + days * 86_400_000).toISOString().slice(0, 16);
}
