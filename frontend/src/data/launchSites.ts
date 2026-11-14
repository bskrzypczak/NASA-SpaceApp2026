/** Launch sites. Coordinates are APPROXIMATE (pad level ±1 km) — fine for the route picture. */
export interface LaunchSite {
  id: string;
  name: string;
  short: string;
  operator: string;
  country: string;
  lat: number;
  lon: number;
}

export const LAUNCH_SITES: LaunchSite[] = [
  { id: 'ksc-39b', name: 'Kennedy Space Center LC-39B', short: 'KSC LC-39B', operator: 'NASA · SLS / Artemis', country: 'USA', lat: 28.627, lon: -80.621 },
  { id: 'ksc-39a', name: 'Kennedy Space Center LC-39A', short: 'KSC LC-39A', operator: 'SpaceX · Falcon 9 / Heavy', country: 'USA', lat: 28.608, lon: -80.604 },
  { id: 'ccsfs-40', name: 'Cape Canaveral SLC-40', short: 'CCSFS SLC-40', operator: 'SpaceX · Falcon 9', country: 'USA', lat: 28.562, lon: -80.577 },
  { id: 'vsfb-4e', name: 'Vandenberg SLC-4E', short: 'VSFB SLC-4E', operator: 'SpaceX · Falcon 9', country: 'USA', lat: 34.632, lon: -120.611 },
  { id: 'kourou', name: 'Guiana Space Centre', short: 'Kourou', operator: 'ESA / Arianespace · Ariane 6', country: 'French Guiana', lat: 5.24, lon: -52.77 },
  { id: 'baikonur', name: 'Baikonur Cosmodrome', short: 'Baikonur', operator: 'Roscosmos', country: 'Kazakhstan', lat: 45.92, lon: 63.34 },
  { id: 'wenchang', name: 'Wenchang Space Launch Site', short: 'Wenchang', operator: 'CNSA · Long March 5', country: 'China', lat: 19.61, lon: 110.95 },
  { id: 'sriharikota', name: 'Satish Dhawan Space Centre', short: 'Sriharikota', operator: 'ISRO · LVM3', country: 'India', lat: 13.72, lon: 80.23 },
  { id: 'tanegashima', name: 'Tanegashima Space Center', short: 'Tanegashima', operator: 'JAXA · H3', country: 'Japan', lat: 30.4, lon: 130.97 },
];

export const DEFAULT_LAUNCH_SITE_ID = 'ksc-39b';

export function launchSiteById(id: string): LaunchSite {
  return LAUNCH_SITES.find((s) => s.id === id) ?? LAUNCH_SITES[0];
}
