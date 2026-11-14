import type { TransferType } from '../store/selection';

/**
 * Planning estimates for the Earth → Moon trip, shown in the confirm popup.
 * Will be replaced by GET /route when the backend has it. Not a trajectory solution.
 */
export const EARTH_MOON_DISTANCE_KM = 384_400; // average

export interface RouteLeg {
  name: string;
  hours: number;
}

export interface Transfer {
  id: TransferType;
  label: string;
  tagline: string;
  legs: RouteLeg[];
}

export const TRANSFERS: Record<TransferType, Transfer> = {
  direct: {
    id: 'direct',
    label: 'Direct transfer',
    tagline: 'fastest',
    legs: [
      { name: 'Launch + TLI', hours: 2 },
      { name: 'Coast to Moon', hours: 74 },
      { name: 'Lunar orbit', hours: 24 },
      { name: 'Descent', hours: 1 },
    ],
  },
  'low-energy': {
    id: 'low-energy',
    label: 'Low-energy transfer',
    tagline: 'less fuel',
    legs: [
      { name: 'Launch + TLI', hours: 2 },
      { name: 'Ballistic lunar transfer', hours: 42 * 24 },
      { name: 'Lunar orbit', hours: 72 },
      { name: 'Descent', hours: 1 },
    ],
  },
};

export function totalHours(t: Transfer) {
  return t.legs.reduce((a, l) => a + l.hours, 0);
}

export function formatDuration(hours: number) {
  const d = Math.floor(hours / 24);
  const h = Math.round(hours - d * 24);
  if (d === 0) return `${h} h`;
  if (d >= 10) return `~${Math.round(hours / 24)} d`;
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** "YYYY-MM-DDTHH:mm" (UTC) minus hours → same format. */
export function subtractHours(isoLocalUtc: string, hours: number) {
  const t = Date.parse(`${isoLocalUtc}:00Z`) - hours * 3_600_000;
  return new Date(t).toISOString().slice(0, 16);
}
