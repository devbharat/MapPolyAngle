// wingtraGeotags.ts
// Utilities for extracting camera poses from Wingtra geotag JSON files.
// Format example (abridged):
// {
//   "model": "RGB61 v4",
//   "flights": [ { "name":"ProcessedForward", "geotag": [ { "coordinate":["47.3","8.52","542.08"], "yaw":"-3.10", ... } ] } ]
// }
// Notes:
//  - coordinate is [lat, lon, alt] (strings or numbers)
//  - yaw/pitch/roll may be strings or numbers; appear to be in radians (range ~ ±π).
//  - We convert radians -> degrees when absolute value of yaw <= ~3.3 (≈ π) AND any of |yaw|,|pitch|,|roll| <= 3.3.
//  - Returned orientationType will indicate whether the original angles were in radians.

import { CameraPoseWGS84 } from '@/utils/djiGeotags';

interface WingtraGeotagEntryRaw {
  coordinate?: [number|string, number|string, number|string];
  yaw?: number|string; // likely radians
  pitch?: number|string;
  roll?: number|string;
  sequence?: number|string;
  timestamp?: number|string; // epoch ms (string or number)
  version?: number|string;
  hAccuracy?: number|string;
  vAccuracy?: number|string;
  coordSys?: string;
}

interface WingtraFlightBlock {
  name?: string;
  geotag?: WingtraGeotagEntryRaw[];
}

interface WingtraGeotagFile {
  model?: string;            // camera / payload model
  flights?: WingtraFlightBlock[];
  flightId?: string;
  siteId?: string;
  hwVersion?: string;
  swVersion?: string;
}

function isWingtraGeotagFile(x:any): x is WingtraGeotagFile {
  return x && Array.isArray(x.flights);
}

function parseNum(v: any): number|undefined { if (v===undefined||v===null||v==='') return undefined; const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : undefined; }

/** Extract pose list (lat/lon degrees, alt meters, yaw/pitch/roll degrees if present). */
export function extractWingtraPoses(input: WingtraGeotagFile | string): CameraPoseWGS84[] {
  const data: WingtraGeotagFile = typeof input === 'string' ? JSON.parse(input) : input;
  if (!isWingtraGeotagFile(data)) throw new Error('wingtraGeotags.extractWingtraPoses: invalid payload');
  const out: CameraPoseWGS84[] = [];
  const flights = data.flights || [];
  // Prefer flight named 'ProcessedForward' (case-insensitive). If absent, use 'Raw'. Else fallback to first flight.
  const norm = (s?:string) => (s||'').toLowerCase();
  let chosen: WingtraFlightBlock | null = null;
  chosen = flights.find(f => norm(f.name) === 'processedforward') || null;
  if (!chosen) chosen = flights.find(f => norm(f.name) === 'raw') || null;
  if (!chosen) chosen = flights[0] || null;
  const flightsToUse = chosen ? [chosen] : [];
  for (const flight of flightsToUse) {
    for (const g of flight.geotag || []) {
      const coord = g.coordinate;
      if (!coord || coord.length < 2) continue;
      const lat = parseNum(coord[0]);
      const lon = parseNum(coord[1]);
      const alt = parseNum(coord[2]);
      if (lat===undefined || lon===undefined) continue;
      let yaw = parseNum(g.yaw);
      let pitch = parseNum(g.pitch);
      let roll = parseNum(g.roll);
      let orientationType: string|undefined = undefined;
      const looksRad = [yaw,pitch,roll].some(a => a!==undefined) && [yaw,pitch,roll].filter(a=>a!==undefined).every(a => Math.abs(a as number) <= 3.3);
      if (looksRad) {
        if (yaw!==undefined) yaw = (yaw*180)/Math.PI;
        if (pitch!==undefined) pitch = (pitch*180)/Math.PI;
        if (roll!==undefined) roll = (roll*180)/Math.PI;
        orientationType = 'yaw_pitch_roll_radians_was';
      } else if ([yaw,pitch,roll].some(a=>a!==undefined)) {
        orientationType = 'yaw_pitch_roll';
      }
      const id = (g.sequence!==undefined ? String(g.sequence) : `${lat},${lon}`);
      let time: string|undefined;
      const ts = parseNum(g.timestamp);
      if (ts !== undefined) {
        try { time = new Date(ts).toISOString(); } catch {}
      }
      out.push({ id, time, lat, lon, alt, yaw, pitch, roll, orientationType });
    }
  }
  return out;
}

/** Attempt to match Wingtra camera model string to one of our registry keys (names list). */
export function matchWingtraCameraKey(model: string|undefined, registry: Record<string, { names?: string[] }>): string | null {
  if (!model) return null;
  const norm = (s:string) => s.toLowerCase().replace(/[^a-z0-9]+/g,'');
  const mNorm = norm(model);
  for (const [key, cam] of Object.entries(registry)) {
    for (const nm of cam.names || []) {
      if (norm(nm) === mNorm) return key;
      // allow partial begins-with (e.g., RGB61 vs RGB61v4)
      if (mNorm.startsWith(norm(nm)) || norm(nm).startsWith(mNorm)) return key;
    }
  }
  return null;
}
