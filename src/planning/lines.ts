// src/planning/lines.ts
//
// Pure utilities (no Mapbox) to generate clipped flight lines within a polygon,
// and to sample trigger/camera positions along those lines.
//

import type { LngLat } from "@/domain/types";

// Haversine and simple geodesy helpers (reuse same math as MapFlightDirection)
const R = 6371000;
function toRad(d: number) { return (d * Math.PI) / 180; }
function toDeg(r: number) { return (r * 180) / Math.PI; }

export function haversine(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a, [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export function destination(start: LngLat, bearingDeg: number, distM: number): LngLat {
  const [lng, lat] = start;
  const br = toRad(bearingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lng);
  const δ = distM / R;

  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(br);
  const φ2 = Math.asin(sinφ2);

  const y = Math.sin(br) * Math.sin(δ) * Math.cos(φ1);
  const x = Math.cos(δ) - Math.sin(φ1) * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);

  return [toDeg(λ2), toDeg(φ2)];
}

export function bearing(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a, [lng2, lat2] = b;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Ray casting point-in-polygon for [lng,lat]
export function pointInPolygon(p: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > p[1]) !== (yj > p[1])) &&
      (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Generate flight lines clipped to a polygon by sampling a long line that crosses the polygon
 * and keeping the continuous interval inside the polygon.
 * - bearingDeg: direction of flight (° CW from North)
 * - lineSpacingM: spacing between lines perpendicular to bearing
 */
export function generateClippedFlightLines(
  ring: LngLat[],
  bearingDeg: number,
  lineSpacingM: number
): LngLat[][] {
  if (!ring || ring.length < 3) return [];

  // Compute a very rough bbox center and diagonal to set an "extension" length
  let minLng = +Infinity, minLat = +Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const center: LngLat = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
  const diagM = haversine([minLng, minLat], [maxLng, maxLat]);
  const perpBearing = (bearingDeg + 90) % 360;

  // We create candidate parallel lines on both sides of center
  const n = Math.ceil((diagM * 1.2) / lineSpacingM);
  const lines: LngLat[][] = [];

  for (let i = -n; i <= n; i++) {
    const offset = i * lineSpacingM;
    const centerOnThisLine = destination(center, perpBearing, offset);

    // Build a long segment (extend beyond bbox), then sample it and clip
    const extend = diagM * 0.8;
    const p1 = destination(centerOnThisLine, bearingDeg, extend);
    const p2 = destination(centerOnThisLine, (bearingDeg + 180) % 360, extend);

    // Uniformly sample and keep the longest continuous run inside polygon
    const samples = 64;
    const inPts: LngLat[] = [];
    for (let s = 0; s <= samples; s++) {
      const t = s / samples;
      const pt: LngLat = [
        p2[0] + (p1[0] - p2[0]) * t,
        p2[1] + (p1[1] - p2[1]) * t,
      ];
      if (pointInPolygon(pt, ring)) inPts.push(pt);
    }
    if (inPts.length > 0) {
      const first = inPts[0];
      const last  = inPts[inPts.length - 1];
      lines.push([first, last]);
    }
  }
  return lines;
}

/** Sample tick points (trigger positions) along a 2‑point line at fixed spacing. */
export function sampleTriggerPoints(line: [LngLat, LngLat], spacingM: number): LngLat[] {
  const [A, B] = line;
  const total = haversine(A, B);
  if (total <= 0) return [A];

  const brg = bearing(A, B);
  const pts: LngLat[] = [A];
  let d = spacingM;
  while (d < total) {
    pts.push(destination(A, brg, d));
    d += spacingM;
  }
  pts.push(B);
  return pts;
}

/**
 * 2D camera positions along lines (flat path fallback).
 * If you have terrain & your 3D path, prefer your existing:
 *   build3DFlightPath(...) + sampleCameraPositionsOnFlightPath(...)
 */
export function sampleCameraPositions2D(
  lines: LngLat[][],
  triggerSpacingM: number,
  defaultAltitudeMSL: number,
  bearingDeg: number
): Array<[number, number, number, number]> {
  const cams: Array<[number, number, number, number]> = [];
  for (const ln of lines) {
    if (ln.length < 2) continue;
    for (const p of sampleTriggerPoints([ln[0], ln[1]], triggerSpacingM)) {
      cams.push([p[0], p[1], defaultAltitudeMSL, bearingDeg]); // [lng, lat, altMSL, yaw]
    }
  }
  return cams;
}
