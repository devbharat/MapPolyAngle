/***********************************************************************
 * utils/geo.ts
 *
 * Geographic utility functions for great circle calculations.
 * Extracted from terrainAspectHybrid.ts for reusability.
 *
 * © 2025 <your-name>. MIT License.
 ***********************************************************************/

const degToRad = (d: number) => d * Math.PI / 180;
const radToDeg = (r: number) => (r * 180 / Math.PI + 360) % 360;

// Calculate destination point given start point, bearing, and distance
export function destination(start: [number, number], bearing: number, distance: number): [number, number] {
  const φ1 = degToRad(start[1]);
  const λ1 = degToRad(start[0]);
  const brng = degToRad(bearing);
  
  const R = 6371000; // Earth's radius in meters
  const δ = distance / R; // angular distance in radians
  
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + 
    Math.cos(φ1) * Math.sin(δ) * Math.cos(brng)
  );
  
  const λ2 = λ1 + Math.atan2(
    Math.sin(brng) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
  );
  
  return [radToDeg(λ2), radToDeg(φ2)];
}

// Calculate bearing between two points
export function calculateBearing(from: [number, number], to: [number, number]): number {
  const φ1 = degToRad(from[1]);
  const φ2 = degToRad(to[1]);
  const Δλ = degToRad(to[0] - from[0]);

  const x = Math.sin(Δλ) * Math.cos(φ2);
  const y = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  const bearing = Math.atan2(x, y);
  return (radToDeg(bearing) + 360) % 360;
}

// Calculate distance between two points using Haversine formula
export function haversineDistance(coords1: [number, number], coords2: [number, number]): number {
  const R = 6371e3; // metres
  const φ1 = degToRad(coords1[1]);
  const φ2 = degToRad(coords2[1]);
  const Δφ = degToRad(coords2[1] - coords1[1]);
  const Δλ = degToRad(coords2[0] - coords1[0]);

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}
