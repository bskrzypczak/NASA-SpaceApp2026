import { create } from 'zustand';
import type { LatLon } from '../lib/coords';

/** The landing point the user is working on. Shared by every screen. */
export interface SelectionState extends LatLon {
  /** Catalog name, or null for a custom point. */
  name: string | null;
  selectSite: (site: LatLon & { name?: string | null }) => void;
}

export const useSelection = create<SelectionState>((set) => ({
  name: 'Connecting Ridge',
  lat: -89.45,
  lon: -137.3,
  selectSite: ({ lat, lon, name = null }) => set({ lat, lon, name }),
}));
