/***********************************************************************
 * utils/geometry.ts
 *
 * Geometric and geographic utility functions.
 *
 * © 2025 <your-name>. MIT License.
 ***********************************************************************/

import {
  queryElevationAtPoint,
  queryMaxElevationAlongLine,
  destination as geoDestination,
  calculateBearing as geoBearing,
  TerrainTile,
} from '@/utils/terrainAspectHybrid';

export function haversineDistance(coords1: [number, number], coords2: [number, number]): number {
  const R = 6371e3; // metres
  const φ1 = (coords1[1] * Math.PI) / 180;
  const φ2 = (coords2[1] * Math.PI) / 180;
  const Δφ = ((coords2[1] - coords1[1]) * Math.PI) / 180;
  const Δλ = ((coords2[0] - coords1[0]) * Math.PI) / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

export function getPolygonBounds(ring: number[][]) {
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
  }
  return {
    minLng,
    minLat,
    maxLng,
    maxLat,
    centroid: [(minLng + maxLng) / 2, (minLat + maxLat) / 2] as [number, number],
  };
}

export function calculateOptimalLineSpacing(ring: number[][], bearingDeg: number): number {
  const bounds = getPolygonBounds(ring);
  const { centroid } = bounds;

  const perpBearing = (bearingDeg + 90) % 360;

  let minProjection = Infinity;
  let maxProjection = -Infinity;

  for (const point of ring) {
    if (point.length < 2) continue;

    const distanceM = haversineDistance(centroid, [point[0], point[1]]);
    const pointBearing = geoBearing(centroid, [point[0], point[1]]);
    const angleDiff = ((pointBearing - perpBearing + 540) % 360) - 180;
    const projection = distanceM * Math.cos((angleDiff * Math.PI) / 180);

    minProjection = Math.min(minProjection, projection);
    maxProjection = Math.max(maxProjection, projection);
  }

  const perpendicularWidthM = maxProjection - minProjection;

  let spacing: number;
  if (perpendicularWidthM < 200) {
    spacing = 25;
  } else if (perpendicularWidthM < 500) {
    spacing = 50;
  } else if (perpendicularWidthM < 1000) {
    spacing = 100;
  } else if (perpendicularWidthM < 2000) {
    spacing = 150;
  } else {
    spacing = 200;
  }

  const estimatedLines = Math.ceil(perpendicularWidthM / spacing);
  if (estimatedLines < 3) {
    spacing = perpendicularWidthM / 3;
  } else if (estimatedLines > 20) {
    spacing = perpendicularWidthM / 20;
  }

  console.log(`Polygon perpendicular width: ${perpendicularWidthM.toFixed(1)}m, line spacing: ${spacing.toFixed(1)}m, estimated lines: ${Math.ceil(perpendicularWidthM / spacing)}`);

  return spacing;
}

function buildFillet(
  P0: [number, number, number],
  P2: [number, number, number],
  dir0: number,
  dir2: number,
  r: number
): [number, number, number][] {
  const directDistance = haversineDistance([P0[0], P0[1]], [P2[0], P2[1]]);
  if (directDistance < r * 0.1) {
    return [P0, P2];
  }

  let turnAngle = ((dir2 - dir0 + 540) % 360) - 180;
  if (Math.abs(turnAngle) < 5) {
    return [P0, P2];
  }

  // Control distance should be proportional to the turn radius and geometry
  const controlDistance = Math.min(r, directDistance * 0.4);
  
  // FIX: For tangential connections, control points must be along the line directions
  // P1_control: move from P0 in the direction of the incoming line (dir0)
  // P2_control: move from P2 in the REVERSE direction of the outgoing line (dir2)
  const P1_control = geoDestination([P0[0], P0[1]], dir0, controlDistance);
  const P2_control = geoDestination([P2[0], P2[1]], (dir2 + 180) % 360, controlDistance);

  const numPoints = Math.max(16, Math.ceil(directDistance / 15));
  const points: [number, number, number][] = [];

  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;

    const lng = mt3 * P0[0] + 3 * mt2 * t * P1_control[0] + 3 * mt * t2 * P2_control[0] + t3 * P2[0];
    const lat = mt3 * P0[1] + 3 * mt2 * t * P1_control[1] + 3 * mt * t2 * P2_control[1] + t3 * P2[1];
    const alt = P0[2] + t * (P2[2] - P0[2]);

    points.push([lng, lat, alt]);
  }
  return points;
}

export function build3DFlightPath(
  lines: number[][][],
  tiles: TerrainTile[],
  lineSpacing: number,
  baseAltitude: number = 100
): [number, number, number][][] {
  const path: [number, number, number][][] = [];

  lines.forEach((line, i) => {
    let lineMaxElevation = -Infinity;

    for (let j = 0; j < line.length - 1; j++) {
      const [startLng, startLat] = line[j];
      const [endLng, endLat] = line[j + 1];
      const segmentMaxElevation = queryMaxElevationAlongLine(startLng, startLat, endLng, endLat, tiles, 20);
      if (Number.isFinite(segmentMaxElevation)) {
        lineMaxElevation = Math.max(lineMaxElevation, segmentMaxElevation);
      }
    }

    for (const [lng, lat] of line) {
      const pointElevation = queryElevationAtPoint(lng, lat, tiles);
      if (Number.isFinite(pointElevation)) {
        lineMaxElevation = Math.max(lineMaxElevation, pointElevation);
      }
    }

    const flightAltitude = Number.isFinite(lineMaxElevation) ? lineMaxElevation + baseAltitude : baseAltitude;
    const coords = (i % 2 === 0 ? line : [...line].reverse()).map(
      ([lng, lat]) => [lng, lat, flightAltitude] as [number, number, number]
    );

    if (i > 0 && path.length > 0) {
      const lastSeg = path[path.length - 1];
      const P0 = lastSeg[lastSeg.length - 1];
      const P2 = coords[0];

      const dirPrev =
        lastSeg.length >= 2
          ? geoBearing([lastSeg[lastSeg.length - 2][0], lastSeg[lastSeg.length - 2][1]], [P0[0], P0[1]])
          : geoBearing([P0[0], P0[1]], [P2[0], P2[1]]);
      const dirNext =
        coords.length >= 2
          ? geoBearing([P2[0], P2[1]], [coords[1][0], coords[1][1]])
          : geoBearing([P0[0], P0[1]], [P2[0], P2[1]]);

      const filletRadius = Math.max(30, lineSpacing / 2);
      const fillet = buildFillet(P0, P2, dirPrev, dirNext, filletRadius);

      if (fillet.length > 2) {
        path.push(fillet);
      } else {
        const connectorAltitude = Math.max(P0[2], P2[2]);
        path.push([[P0[0], P0[1], connectorAltitude], [P2[0], P2[1], connectorAltitude]]);
      }
    }
    path.push(coords);
  });
  return path;
}

export function calculateOptimalTerrainZoom(polygon: { coordinates: number[][] }): number {
  const coords = polygon.coordinates;
  if (coords.length < 3) return 15;

  let area = 0;
  const n = coords.length;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [lng1, lat1] = coords[i];
    const [lng2, lat2] = coords[j];

    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;

    area += Δλ * (2 + Math.sin(φ1) + Math.sin(φ2));
  }

  area = (Math.abs(area * 6371000 * 6371000)) / 2;

  if (area < 100000) {
    return 15;
  } else if (area < 1000000) {
    return 14;
  } else if (area < 10000000) {
    return 13;
  } else {
    return 12;
  }
}
