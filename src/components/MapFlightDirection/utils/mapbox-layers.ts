/***********************************************************************
 * utils/mapbox-layers.ts
 *
 * Functions for adding and removing Mapbox GL JS layers (flight lines).
 *
 * © 2025 <your-name>. MIT License.
 ***********************************************************************/

import { Map as MapboxMap } from 'mapbox-gl';
import { getPolygonBounds, haversineDistance } from './geometry';
import { destination as geoDestination } from '@/utils/geo';

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
  quality?: string
): { flightLines: number[][][]; lineSpacing: number } {
  removeFlightLinesForPolygon(map, polygonId);

  const bounds = getPolygonBounds(ring);
  const lineSpacing = 100; // Simplified spacing
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
