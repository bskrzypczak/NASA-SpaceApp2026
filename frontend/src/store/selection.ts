import { create } from 'zustand';
import type { LatLon } from '../lib/coords';

export const MISSION_LENGTHS = [3, 7, 14, 30] as const;
export type TransferType = 'direct' | 'low-energy';

/** The landing point and mission settings the user is working on. Shared by every screen. */
export interface SelectionState extends LatLon {
  /** Catalog name, or null for a custom point. */
  name: string | null;
  /** Landing time in UTC, "YYYY-MM-DDTHH:mm". */
  landingTime: string;
  missionDays: number;
  /** id from data/launchSites.ts */
  launchSiteId: string;
  transfer: TransferType;
  selectSite: (site: LatLon & { name?: string | null }) => void;
  setMission: (m: Partial<Pick<SelectionState, 'landingTime' | 'missionDays' | 'launchSiteId' | 'transfer'>>) => void;
}

export const useSelection = create<SelectionState>((set) => ({
  name: 'Connecting Ridge',
  lat: -89.45,
  lon: -137.3,
  landingTime: '2027-03-14T06:00',
  missionDays: 14,
  launchSiteId: 'ksc-39b',
  transfer: 'direct',
  selectSite: ({ lat, lon, name = null }) => set({ lat, lon, name }),
  setMission: (m) => set(m),
}));
