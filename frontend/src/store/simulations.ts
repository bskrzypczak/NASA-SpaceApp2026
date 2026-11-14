import { create } from 'zustand';
import type { SimulationResult } from '../api/types';

/** Client-side cache of simulation results (the backend keeps them only in memory). */
interface SimulationsState {
  results: Record<string, SimulationResult>;
  /** real-terrain id → flat-horizon twin id */
  flatTwin: Record<string, string>;
  lastId: string | null;
  put: (r: SimulationResult) => void;
  linkFlat: (realId: string, flatId: string) => void;
}

export const useSimulations = create<SimulationsState>((set) => ({
  results: {},
  flatTwin: {},
  lastId: null,
  put: (r) => set((s) => ({ results: { ...s.results, [r.id]: r } })),
  linkFlat: (realId, flatId) => set((s) => ({ flatTwin: { ...s.flatTwin, [realId]: flatId } })),
}));

export function setLastSimulation(id: string) {
  useSimulations.setState({ lastId: id });
}
