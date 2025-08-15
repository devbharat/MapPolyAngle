/***********************************************************************
 * utils/mapbox-layers.ts
 *
 * Functions for adding and removing Mapbox GL JS layers (flight lines).
 *
 * © 2025 <your-name>. MIT License.
 ***********************************************************************/

import { Map as MapboxMap } from 'mapbox-gl';
import { getPolygonBounds, haversineDistance } from './geometry';
import { destination as geoDestination } from '@/utils/terrainAspectHybrid';

function getLineColor(quality?: string) {
  switch (quality) {
    case 'excellent':
      return '#22c55e'; // green-500
    case 'good':
      return '#3b82f6'; // blue-500
    case 'fair':
      return '#f97316'; // orange-500
    case 'poor':
      return '#ef4444'; // red-500
    default:
      return '#6b7280'; // gray-500
  }
}

export function addFlightLinesForPolygon(
  map: MapboxMap,
  polygonId: string,
  ring: number[][],
  bearingDeg: number,
  lineSpacingM: number,
  quality?: string
): { flightLines: number[][][]; lineSpacing: number } {
  removeFlightLinesForPolygon(map, polygonId);

  const bounds = getPolygonBounds(ring);
  const lineSpacing = lineSpacingM;
  const flightLines: number[][][] = [];

  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const centerLng = (bounds.minLng + bounds.maxLng) / 2;
  const diagonal = haversineDistance([bounds.minLng, bounds.minLat], [bounds.maxLng, bounds.maxLat]);

  const numLines = Math.ceil(diagonal / lineSpacing);
  const perpBearing = (bearingDeg + 90) % 360;

  // Create a polygon check function
  const pointInPolygon = (lng: number, lat: number): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  };

  for (let i = -numLines; i <= numLines; i++) {
    const distance = i * lineSpacing;
    const [centerLineLng, centerLineLat] = geoDestination([centerLng, centerLat], perpBearing, distance);

    // Create a longer line and then clip it to the polygon
    const extendDistance = diagonal * 0.6; // Extend beyond polygon bounds
    const p1 = geoDestination([centerLineLng, centerLineLat], bearingDeg, extendDistance);
    const p2 = geoDestination([centerLineLng, centerLineLat], (bearingDeg + 180) % 360, extendDistance);

    // Sample points along the line and find entry/exit points of polygon
    const linePoints: [number, number][] = [];
    const samples = 50;
    
    for (let s = 0; s <= samples; s++) {
      const t = s / samples;
      const lng = p2[0] + t * (p1[0] - p2[0]);
      const lat = p2[1] + t * (p1[1] - p2[1]);
      
      if (pointInPolygon(lng, lat)) {
        linePoints.push([lng, lat]);
      }
    }

    // Only add lines that have points inside the polygon
    if (linePoints.length > 0) {
      // Find the start and end of the continuous segment inside the polygon
      const startPoint = linePoints[0];
      const endPoint = linePoints[linePoints.length - 1];
      flightLines.push([startPoint, endPoint]);
    }
  }

  const sourceId = `flight-lines-source-${polygonId}`;
  if (map.getSource(sourceId)) {
    (map.getSource(sourceId) as any).setData({
      type: 'FeatureCollection',
      features: flightLines.map((line) => ({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: line,
        },
        properties: {},
      })),
    });
  } else {
    map.addSource(sourceId, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: flightLines.map((line) => ({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: line,
          },
          properties: {},
        })),
      },
    });
  }

  const layerId = `flight-lines-layer-${polygonId}`;
  map.addLayer({
    id: layerId,
    type: 'line',
    source: sourceId,
    layout: {
      'line-join': 'round',
      'line-cap': 'round',
    },
    paint: {
      'line-color': getLineColor(quality),
      'line-width': 2,
      'line-opacity': 0.8,
    },
  });

  return { flightLines, lineSpacing };
}

export function removeFlightLinesForPolygon(map: MapboxMap, polygonId: string) {
  const layerId = `flight-lines-layer-${polygonId}`;
  const sourceId = `flight-lines-source-${polygonId}`;
  
  if (map.getLayer(layerId)) {
    map.removeLayer(layerId);
  }
  if (map.getSource(sourceId)) {
    map.removeSource(sourceId);
  }
}

// -------------------------------------------------------------------
// Trigger tick marks (camera trigger positions) along flight lines
// -------------------------------------------------------------------

function sampleTriggerPoints(line: [number, number][], spacingM: number): [number, number][] {
  if (line.length < 2 || spacingM <= 0) return [];
  const [A, B] = line as [[number, number], [number, number]];
  const total = haversineDistance(A, B);
  if (total === 0) return [A];
  
  // Calculate bearing from A to B
  const dLng = B[0] - A[0];
  const dLat = B[1] - A[1];
  const bearing = Math.atan2(dLng * Math.cos(A[1] * Math.PI / 180), dLat) * 180 / Math.PI;

  const pts: [number, number][] = [];
  // Place a trigger at the line start
  pts.push(A);
  let d = spacingM;
  while (d < total) {
    pts.push(geoDestination(A, bearing, d) as [number, number]);
    d += spacingM;
  }
  // Always place one at the end to avoid uncovered tail
  pts.push(B);
  return pts;
}

export function addTriggerPointsForPolygon(
  map: MapboxMap,
  polygonId: string,
  flightLines: number[][][],
  spacingM: number
) {
  const points: any[] = [];
  for (const ln of flightLines) {
    const pts = sampleTriggerPoints(ln as [number, number][], spacingM);
    for (const p of pts) {
      points.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: p },
        properties: { spacing: spacingM }
      });
    }
  }

  const sourceId = `flight-triggers-source-${polygonId}`;
  const circleLayerId = `flight-triggers-layer-${polygonId}`;
  const labelLayerId = `flight-triggers-label-${polygonId}`;

  if (map.getLayer(circleLayerId)) map.removeLayer(circleLayerId);
  if (map.getLayer(labelLayerId)) map.removeLayer(labelLayerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);

  map.addSource(sourceId, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: points },
  } as any);

  map.addLayer({
    id: circleLayerId,
    type: 'circle',
    source: sourceId,
    paint: {
      'circle-radius': 3,
      'circle-color': '#111827',
      'circle-stroke-width': 1,
      'circle-stroke-color': '#ffffff'
    }
  });

  map.addLayer({
    id: labelLayerId,
    type: 'symbol',
    source: sourceId,
    layout: {
      'text-field': ['concat', ['to-string', ['round', ['get', 'spacing']]], ' m'],
      'text-size': 10,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'symbol-avoid-edges': true
    },
    paint: {
      'text-color': '#374151',
      'text-halo-color': '#ffffff',
      'text-halo-width': 0.75
    }
  });
}

export function removeTriggerPointsForPolygon(map: MapboxMap, polygonId: string) {
  const sourceId = `flight-triggers-source-${polygonId}`;
  const circleLayerId = `flight-triggers-layer-${polygonId}`;
  const labelLayerId = `flight-triggers-label-${polygonId}`;
  if (map.getLayer(circleLayerId)) map.removeLayer(circleLayerId);
  if (map.getLayer(labelLayerId)) map.removeLayer(labelLayerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}