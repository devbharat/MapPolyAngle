// djiGeotags.ts
//
// Utils for extracting camera poses from OPF-style input_cameras.json
// that already stores WGS-84 (EPSG:4326) coordinates in [lat, lon, alt] order.
//
// This is browser/server safe (no fs). Pass the parsed JSON object or a JSON string.
//
// Example:
//   import { extractPoses, wgs84ToWebMercator } from "./djiGeotags";
//   const poses = extractPoses(inputCamerasJsonObject); // or JSON string
//   const { x, y } = wgs84ToWebMercator(poses[0].lat, poses[0].lon);

export interface CameraPoseWGS84 {
  id: number | string;
  time?: string;          // ISO timestamp if present
  lat: number;            // degrees
  lon: number;            // degrees
  alt?: number;           // meters (ellipsoidal or orthometric as provided)
  yaw?: number;           // degrees (forward/right/down, order as given)
  pitch?: number;         // degrees
  roll?: number;          // degrees
  orientationType?: string; // e.g., "yaw_pitch_roll"
}

// NEW: Camera model extraction support
import type { CameraModel } from '@/domain/types';

interface DjiSensorInternals {
  distortion_type?: string;
  focal_length_px?: number; // focal length expressed in pixels
  principal_point_px?: [number, number];
  radial_distortion?: number[];
  tangential_distortion?: number[];
  type?: string; // perspective
}
interface DjiSensor {
  id?: number | string;
  name?: string;
  image_size_px?: [number, number]; // [w,h]
  internals?: DjiSensorInternals;
  pixel_size_um?: number; // pixel pitch in micrometers (assumed square)
  shutter_type?: string;
  bands?: Array<{ central_wavelength_nm?: number; weight?: number }>;
}

interface InputCapture {
  id?: number | string;
  time?: string;
  cameras?: Array<{ id: number | string }>;
  geolocation?: {
    coordinates?: [number, number, number]; // [lat, lon, alt]
    crs?: { definition?: string };          // expects "EPSG:4326"
  };
  orientation?: {
    type?: string;                          // "yaw_pitch_roll" preferred
    angles_deg?: [number, number, number];
  };
}

interface InputCamerasFile {
  captures: InputCapture[];
  sensors?: DjiSensor[]; // optional sensors block
  version?: string;
}

/** Type guard for InputCamerasFile (minimal). */
function isInputCamerasFile(x: any): x is InputCamerasFile {
  return !!x && Array.isArray(x.captures);
}

/** True if CRS definition is WGS-84 / EPSG:4326 (case/format tolerant). */
function isEPSG4326(def?: string): boolean {
  if (!def) return true; // many producers omit it; input spec implies 4326
  return /4326/.test(def);
}

/**
 * Extract camera poses from an OPF-style input_cameras.json payload.
 * Accepts either a parsed object or a JSON string.
 *
 * - Enforces EPSG:4326; entries not in 4326 are skipped.
 * - Keeps yaw/pitch/roll (degrees) if present, along with the declared orientation type.
 * - Uses capture.id, falling back to first camera.id if capture.id is missing.
 */
export function extractPoses(input: InputCamerasFile | string): CameraPoseWGS84[] {
  const data: InputCamerasFile =
    typeof input === "string" ? (JSON.parse(input) as InputCamerasFile) : input;

  if (!isInputCamerasFile(data)) {
    throw new Error("djiGeotags.extractPoses: invalid input_cameras payload");
    }
  const out: CameraPoseWGS84[] = [];

  for (const cap of data.captures) {
    const coords = cap.geolocation?.coordinates; // [lat, lon, alt]
    const crsDef = cap.geolocation?.crs?.definition;

    if (!coords) continue;           // skip incomplete
    if (!isEPSG4326(crsDef)) continue; // skip non-4326 to avoid misprojection

    const [lat, lon, alt] = coords;
    const id = cap.id ?? cap.cameras?.[0]?.id ?? `${lat},${lon}`;

    let yaw: number | undefined;
    let pitch: number | undefined;
    let roll: number | undefined;
    let orientationType: string | undefined;

    if (cap.orientation?.angles_deg && cap.orientation.angles_deg.length === 3) {
      const [a, b, c] = cap.orientation.angles_deg;
      orientationType = cap.orientation.type;
      // If type is "yaw_pitch_roll", we label a,b,c accordingly.
      // If not specified, we still pass through the triple as yaw/pitch/roll fields
      // but retain orientationType so downstream can handle interpretation explicitly.
      yaw = a; pitch = b; roll = c;
    }

    out.push({ id, time: cap.time, lat, lon, alt, yaw, pitch, roll, orientationType });
  }

  return out;
}

/**
 * WGS-84 (lat, lon in degrees) -> Web Mercator (EPSG:3857) meters.
 * Latitude is clamped to the valid Web Mercator range.
 */
export function wgs84ToWebMercator(latDeg: number, lonDeg: number): { x: number; y: number } {
  const R = 6378137.0;
  const max = 85.05112878;
  const lat = Math.max(Math.min(latDeg, max), -max);
  const lon = lonDeg;

  const x = R * (lon * Math.PI / 180);
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
  return { x, y };
}

/** Optional convenience: convert extracted poses to a minimal GeoJSON FeatureCollection (Point). */
export function posesToGeoJSON(poses: CameraPoseWGS84) {
  // Allow both single pose and array input
  const arr = Array.isArray(poses) ? poses : [poses];
  return {
    type: "FeatureCollection",
    features: arr.map(p => ({
      type: "Feature",
      properties: {
        id: p.id,
        time: p.time,
        alt: p.alt,
        yaw: p.yaw,
        pitch: p.pitch,
        roll: p.roll,
        orientationType: p.orientationType,
      },
      geometry: {
        type: "Point",
        coordinates: [p.lon, p.lat, p.alt ?? null],
      },
    })),
  } as const;
}

/**
 * Extract a CameraModel from the first suitable DJI sensor definition.
 * Preference order: first sensor with internals.focal_length_px & image_size_px & pixel_size_um.
 * Returns null if requirements not met.
 */
export function extractCameraModel(input: InputCamerasFile | string): CameraModel | null {
  const data: InputCamerasFile = typeof input === 'string' ? JSON.parse(input) : input;
  if (!data || !Array.isArray(data.sensors) || data.sensors.length === 0) return null;
  const sensor = data.sensors.find(s => (
    s?.internals?.focal_length_px &&
    Array.isArray(s.image_size_px) && s.image_size_px.length === 2 &&
    typeof s.pixel_size_um === 'number'
  )) || null;
  if (!sensor) return null;
  const [w, h] = sensor.image_size_px as [number, number];
  const px_um = sensor.pixel_size_um!; // micrometers
  const pixelSizeM = px_um * 1e-6; // convert to meters
  const f_px = sensor.internals?.focal_length_px!; // focal length in pixels
  const f_m = f_px * pixelSizeM; // f_pixels = f_m / pixel_size  => f_m = f_px * pixel_size
  const principal = sensor.internals?.principal_point_px;
  const cx_px = principal?.[0] ?? w / 2;
  const cy_px = principal?.[1] ?? h / 2;
  const model: CameraModel = {
    f_m,
    sx_m: pixelSizeM,
    sy_m: pixelSizeM,
    w_px: w,
    h_px: h,
    cx_px,
    cy_px,
  };
  return model;
}
