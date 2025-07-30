/***********************************************************************
 * MapFlightDirection.tsx
 *
 * Multi-polygon version: draw multiple polygons, compute dominant aspect 
 * using hybrid plane fitting for each, show 90° "constant-height" flight 
 * directions for all polygons simultaneously.
 *
 * Required npm packages (peer deps): react, mapbox-gl, @mapbox/mapbox-gl-draw
 *
 * © 2025 <your-name>. MIT License.
 ***********************************************************************/

import React, { useRef, useEffect, useState } from 'react';
import mapboxgl, { Map as MapboxMap, LngLatLike, GeoJSONSource } from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';

import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

import {
  dominantContourDirectionPlaneFit,
  Polygon as AspectPolygon,
  TerrainTile,
  AspectResult,
} from '../utils/terrainAspectHybrid';

/* Enhanced result interface for multiple polygons */
interface PolygonAnalysisResult {
  polygonId: string;
  result: AspectResult;
  polygon: AspectPolygon;
}

/* ----------------------------- props -------------------------------- */
interface Props {
  mapboxToken: string;
  /** Initial map centre. */
  center?: LngLatLike;
  zoom?: number;
  /** Terrain tile zoom level to sample (10‑14 reasonable). */
  terrainZoom?: number;
  /** Sample step for terrain analysis */
  sampleStep?: number;
  /** Spacing between parallel flight lines (meters) */
  lineSpacingM?: number;
  /** Callback when any polygon analysis completes - receives all results */
  onAnalysisComplete?: (results: PolygonAnalysisResult[]) => void;
  /** Callback when analysis starts for a specific polygon */
  onAnalysisStart?: (polygonId: string) => void;
  /** Callback for errors */
  onError?: (error: string, polygonId?: string) => void;
}

/* ----------------------- main React component ----------------------- */
export const MapFlightDirection = React.forwardRef<
  {
    clearAllDrawings: () => void;
    clearPolygon: (polygonId: string) => void;
    startPolygonDrawing: () => void;
    getPolygonResults: () => PolygonAnalysisResult[];
  },
  Props
>(({
  mapboxToken,
  center = [8.54, 47.37],
  zoom = 13,
  terrainZoom = 12,
  sampleStep = 2,
  lineSpacingM = 150,
  onAnalysisComplete,
  onAnalysisStart,
  onError,
}, ref) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap>();
  const drawRef = useRef<MapboxDraw>();
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  
  // Store analysis results for each polygon
  const [polygonResults, setPolygonResults] = useState<Map<string, PolygonAnalysisResult>>(new Map());

  /* Handle new polygon creation */
  const handleDrawCreate = async (e: any) => {
    const features = e.features;
    for (const feature of features) {
      if (feature.geometry.type === 'Polygon') {
        await analyzePolygon(feature.id, feature);
      }
    }
  };

  /* Handle polygon updates */
  const handleDrawUpdate = async (e: any) => {
    const features = e.features;
    for (const feature of features) {
      if (feature.geometry.type === 'Polygon') {
        await analyzePolygon(feature.id, feature);
      }
    }
  };

  /* Handle polygon deletion */
  const handleDrawDelete = (e: any) => {
    const features = e.features;
    for (const feature of features) {
      if (feature.geometry.type === 'Polygon') {
        const polygonId = feature.id;
        
        // Cancel ongoing analysis for this polygon
        const controller = abortControllersRef.current.get(polygonId);
        if (controller) {
          controller.abort();
          abortControllersRef.current.delete(polygonId);
        }
        
        // Remove flight lines for this polygon
        removeFlightLinesForPolygon(mapRef.current!, polygonId);
        
        // Remove from results
        setPolygonResults((prev) => {
          const newResults = new Map(prev);
          newResults.delete(polygonId);
          
          // Notify callback with updated results
          onAnalysisComplete?.(Array.from(newResults.values()));
          
          return newResults;
        });
      }
    }
  };

  /* init map once ---------------------------------------------------- */
  useEffect(() => {
    // Ensure the container exists and is properly mounted
    if (!mapContainer.current) {
      console.warn('Map container not ready yet');
      return;
    }
    
    if (!mapboxToken) {
      console.error('Mapbox token is missing');
      onError?.('Mapbox token is missing');
      return;
    }

    // Small delay to ensure DOM is fully ready
    const timeoutId = setTimeout(() => {
      // Double-check container is still available
      if (!mapContainer.current) {
        console.error('Map container became unavailable');
        onError?.('Map container is not available');
        return;
      }

      try {
        mapboxgl.accessToken = mapboxToken;

        const map = new mapboxgl.Map({
          container: mapContainer.current,
          style: 'mapbox://styles/mapbox/satellite-streets-v12',
          center,
          zoom,
          pitch: 45, // Enable 3D perspective
          bearing: 0,
          attributionControl: true,
        });
        mapRef.current = map;

        const draw = new MapboxDraw({
          displayControlsDefault: true,
          controls: { 
            polygon: true, 
            trash: true,
            line_string: false,
            point: false,
            combine_features: false,
            uncombine_features: false
          }
        });
        drawRef.current = draw;
        
        map.on('load', () => {
          // Add terrain source for 3D elevation
          map.addSource('mapbox-dem', {
            type: 'raster-dem',
            url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
            tileSize: 512,
            maxzoom: 14
          });

          // Add terrain layer for 3D visualization
          map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 });

          // Add 3D navigation controls
          map.addControl(new mapboxgl.NavigationControl({
            visualizePitch: true
          }), 'top-right');

          // Add drawing controls
          map.addControl(draw, 'top-left');
          
          // Handle multiple polygon events
          map.on('draw.create', handleDrawCreate);
          map.on('draw.update', handleDrawUpdate);
          map.on('draw.delete', handleDrawDelete);
        });
        
        map.on('error', (e) => {
          console.error('Map error:', e);
          onError?.(`Map loading error: ${e.error?.message || 'Unknown error'}`);
        });
      } catch (error) {
        console.error('Failed to initialize map:', error);
        onError?.(`Failed to initialize map: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }, 100); // Small delay to ensure DOM is ready

    return () => {
      clearTimeout(timeoutId);
      // Cancel all ongoing requests
      abortControllersRef.current.forEach((controller: AbortController) => controller.abort());
      abortControllersRef.current.clear();
      if (mapRef.current) {
        mapRef.current.remove();
      }
    };
  }, [mapboxToken, center, zoom, onError]);

  /* Analyze a specific polygon */
  const analyzePolygon = async (polygonId: string, feature: any) => {
    const map = mapRef.current!;
    
    // Cancel any existing analysis for this polygon
    const existingController = abortControllersRef.current.get(polygonId);
    if (existingController) {
      existingController.abort();
    }

    const ring = feature.geometry.coordinates[0];
    const polygon: AspectPolygon = { coordinates: ring as [number, number][] };

    try {
      onAnalysisStart?.(polygonId);

      // Create new abort controller for this polygon
      const controller = new AbortController();
      abortControllersRef.current.set(polygonId, controller);
      const signal = controller.signal;

      // Fetch terrain tiles
      const tiles = await fetchTilesForPolygon(polygon, terrainZoom, mapboxToken, signal);
      
      if (signal.aborted) return;
      
      if (!tiles.length) {
        onError?.('Terrain tiles not found – polygon outside coverage?', polygonId);
        return;
      }

      // Compute aspect analysis
      const result = dominantContourDirectionPlaneFit(polygon, tiles, {
        sampleStep,
      });

      if (signal.aborted) return;

      if (!Number.isFinite(result.contourDirDeg)) {
        const errorMsg = result.fitQuality === 'poor' 
          ? 'Could not determine reliable direction (insufficient data or flat terrain)'
          : 'Could not determine aspect (flat terrain?)';
        onError?.(errorMsg, polygonId);
        return;
      }

      // Log quality info
      if (result.fitQuality === 'poor') {
        console.warn(`Polygon ${polygonId} - Low quality fit: ${result.fitQuality} (R²: ${result.rSquared?.toFixed(3) || 'N/A'}, samples: ${result.samples})`);
      } else {
        console.log(`Polygon ${polygonId} - Plane fit quality: ${result.fitQuality} (R²: ${result.rSquared?.toFixed(3) || 'N/A'}, RMSE: ${result.rmse?.toFixed(1) || 'N/A'}m, samples: ${result.samples})`);
      }

      // Draw flight lines for this polygon
      addFlightLinesForPolygon(map, polygonId, ring, result.contourDirDeg, result.fitQuality, lineSpacingM);
      
      // Update results
      const polygonResult: PolygonAnalysisResult = {
        polygonId,
        result,
        polygon,
      };

      setPolygonResults((prev) => {
        const newResults = new Map(prev);
        newResults.set(polygonId, polygonResult);
        
        // Notify callback with all current results
        onAnalysisComplete?.(Array.from(newResults.values()));
        
        return newResults;
      });

    } catch (error) {
      if (error instanceof Error && (error.message.includes('cancelled') || error.message.includes('aborted'))) {
        return; // Silently ignore cancelled requests
      }
      const errorMsg = error instanceof Error ? error.message : 'Analysis failed';
      onError?.(errorMsg, polygonId);
    } finally {
      abortControllersRef.current.delete(polygonId);
    }
  };

  /* Public methods */
  const clearAllDrawings = () => {
    const draw = drawRef.current;
    if (draw) {
      draw.deleteAll();
      // This will trigger handleDrawDelete for all polygons
    }
  };

  const clearPolygon = (polygonId: string) => {
    const draw = drawRef.current;
    if (draw) {
      try {
        draw.delete(polygonId);
        // This will trigger handleDrawDelete for this specific polygon
      } catch (error) {
        console.warn(`Failed to delete polygon ${polygonId}:`, error);
      }
    }
  };

  const startPolygonDrawing = () => {
    const draw = drawRef.current;
    if (draw) {
      (draw as any).changeMode('draw_polygon');
    }
  };

  const getPolygonResults = (): PolygonAnalysisResult[] => {
    return Array.from(polygonResults.values());
  };

  // Expose methods via ref
  React.useImperativeHandle(ref, () => ({
    clearAllDrawings,
    clearPolygon,
    startPolygonDrawing,
    getPolygonResults,
  }), [polygonResults]);

  /* ------------------------ render div ----------------------------- */
  return (
    <div
      ref={mapContainer}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    />
  );
});

/* ==================================================================== */
/* ------------------------- helper utils ----------------------------- */
/* ==================================================================== */

/* Remove flight lines for a specific polygon */
function removeFlightLinesForPolygon(map: MapboxMap, polygonId: string) {
  const layersToRemove = [
    `flight-lines-${polygonId}`,
    `flight-lines-glow-${polygonId}`,
    `flight-arrows-${polygonId}`
  ];
  const sourcesToRemove = [
    `flight-lines-${polygonId}`,
    `flight-arrows-${polygonId}`
  ];
  
  layersToRemove.forEach(layerId => {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  });
  
  sourcesToRemove.forEach(sourceId => {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  });
}

/* Add multiple parallel flight lines for a specific polygon */
function addFlightLinesForPolygon(
  map: MapboxMap,
  polygonId: string,
  ring: number[][],
  bearingDeg: number,
  fitQuality?: string,
  lineSpacingM = 150,
) {
  // Remove existing flight lines for this polygon
  removeFlightLinesForPolygon(map, polygonId);

  // Calculate polygon bounds and dimensions
  const bounds = getPolygonBounds(ring);
  const { minLng, maxLng, minLat, maxLat, centroid } = bounds;
  
  // Calculate polygon dimensions in meters (approximate)
  const widthM = haversineDistance([minLng, centroid[1]], [maxLng, centroid[1]]);
  const heightM = haversineDistance([centroid[0], minLat], [centroid[0], maxLat]);
  
  // Determine the extent perpendicular to flight direction
  const perpBearing = (bearingDeg + 90) % 360;
  const maxExtentM = Math.max(widthM, heightM);
  
  // Calculate how many lines we need
  const numLines = Math.ceil(maxExtentM / lineSpacingM);
  const totalSpan = (numLines - 1) * lineSpacingM;
  
  // Color and styling based on fit quality
  const { lineColor, lineWidth, lineOpacity } = getStyleForQuality(fitQuality);

  // Generate multiple parallel lines
  const lines: number[][][] = [];
  
  for (let i = 0; i < numLines; i++) {
    // Calculate offset from center line
    const offsetM = (i - (numLines - 1) / 2) * lineSpacingM;
    
    // Find the center point of this line (offset perpendicular to flight direction)
    const lineCenter = destination(centroid, perpBearing, offsetM);
    
    // Create a line extending in both directions along flight direction
    const lineLength = maxExtentM * 1.2; // Make lines longer than polygon
    const p1 = destination(lineCenter, bearingDeg, lineLength / 2);
    const p2 = destination(lineCenter, (bearingDeg + 180) % 360, lineLength / 2);
    
    // Clip line to polygon bounds (simplified - using bounding box)
    const clippedLine = clipLineToPolygon([p1, p2], ring);
    if (clippedLine && clippedLine.length >= 2) {
      lines.push(clippedLine);
    }
  }

  if (lines.length === 0) return;

  // Create GeoJSON with all lines for this polygon
  const flightLines = {
    type: 'FeatureCollection' as const,
    features: lines.map((lineCoords, index) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: lineCoords,
      },
      properties: {
        polygonId,
        quality: fitQuality || 'unknown',
        lineIndex: index,
        isMainLine: index === Math.floor(lines.length / 2), // Middle line is main
      },
    })),
  };

  // Add source with unique polygon ID
  map.addSource(`flight-lines-${polygonId}`, {
    type: 'geojson',
    data: flightLines,
  });

  // Add glow effect for high-quality fits
  if (fitQuality === 'excellent' || fitQuality === 'good') {
    map.addLayer({
      id: `flight-lines-glow-${polygonId}`,
      type: 'line',
      source: `flight-lines-${polygonId}`,
      paint: {
        'line-color': lineColor,
        'line-width': lineWidth + 3,
        'line-opacity': 0.2,
        'line-blur': 3,
      },
    });
  }

  // Add main flight lines
  map.addLayer({
    id: `flight-lines-${polygonId}`,
    type: 'line',
    source: `flight-lines-${polygonId}`,
    paint: {
      'line-color': lineColor,
      'line-width': [
        'case',
        ['get', 'isMainLine'],
        lineWidth + 1, // Main line slightly thicker
        lineWidth
      ],
      'line-opacity': [
        'case',
        ['get', 'isMainLine'],
        Math.min(lineOpacity + 0.2, 1), // Main line more opaque
        lineOpacity
      ],
    },
  });

  // Add direction arrows on the main line
  const mainLineIndex = Math.floor(lines.length / 2);
  if (lines[mainLineIndex]) {
    addDirectionArrowsForPolygon(map, polygonId, lines[mainLineIndex], bearingDeg, lineColor);
  }
}

/* Get styling based on fit quality */
function getStyleForQuality(fitQuality?: string) {
  let lineColor = '#FF4081'; // Default pink
  let lineWidth = 2;
  let lineOpacity = 0.8;

  switch (fitQuality) {
    case 'excellent':
      lineColor = '#00E676'; // Bright green
      lineWidth = 2.5;
      lineOpacity = 0.9;
      break;
    case 'good':
      lineColor = '#2196F3'; // Blue
      lineWidth = 2;
      lineOpacity = 0.85;
      break;
    case 'fair':
      lineColor = '#FF9800'; // Orange
      lineWidth = 2;
      lineOpacity = 0.7;
      break;
    case 'poor':
      lineColor = '#F44336'; // Red
      lineWidth = 1.5;
      lineOpacity = 0.6;
      break;
  }

  return { lineColor, lineWidth, lineOpacity };
}

/* Add direction arrows for a specific polygon */
function addDirectionArrowsForPolygon(
  map: MapboxMap,
  polygonId: string,
  lineCoords: number[][],
  bearingDeg: number,
  color: string
) {
  if (lineCoords.length < 2) return;
  
  // Create arrow symbols at intervals along the main line
  const arrows: any[] = [];
  const numArrows = Math.min(3, Math.floor(lineCoords.length / 10)); // 3 arrows max
  
  for (let i = 0; i < numArrows; i++) {
    const t = (i + 1) / (numArrows + 1); // Position along line
    const pointIndex = Math.floor(t * (lineCoords.length - 1));
    const point = lineCoords[pointIndex];
    
    arrows.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: point,
      },
      properties: {
        polygonId,
        bearing: bearingDeg,
        color: color,
      },
    });
  }
  
  if (arrows.length > 0) {
    map.addSource(`flight-arrows-${polygonId}`, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: arrows,
      },
    });

    map.addLayer({
      id: `flight-arrows-${polygonId}`,
      type: 'symbol',
      source: `flight-arrows-${polygonId}`,
      layout: {
        'icon-image': 'arrow', // Will fall back gracefully if not available
        'icon-size': 0.5,
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        // Fallback to text arrow if icon not available
        'text-field': '→',
        'text-size': 16,
        'text-rotate': ['get', 'bearing'],
        'text-rotation-alignment': 'map',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': 'white',
        'text-halo-width': 1,
      },
    });
  }
}

/* Haversine destination (spheroid not needed for ~1 km) */
function destination(
  [lng, lat]: [number, number],
  bearingDeg: number,
  distM: number,
): [number, number] {
  const R = 6371000; // Earth radius (m)
  const br = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lng * Math.PI) / 180;
  const δ = distM / R;

  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(br),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(br) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return [(λ2 * 180) / Math.PI, (φ2 * 180) / Math.PI];
}

/* Calculate polygon bounds and centroid */
function getPolygonBounds(ring: number[][]) {
  const lngs = ring.map(p => p[0]);
  const lats = ring.map(p => p[1]);
  
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  
  const centroid = ring.reduce(
    (acc, p) => [acc[0] + p[0], acc[1] + p[1]],
    [0, 0],
  ).map((v) => v / ring.length) as [number, number];
  
  return { minLng, maxLng, minLat, maxLat, centroid };
}

/* Calculate distance between two points using Haversine formula */
function haversineDistance([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]): number {
  const R = 6371000; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c;
}

/* Clip line to polygon bounds (simplified version using polygon bounding box and basic intersection) */
function clipLineToPolygon(line: [number, number][], polygonRing: number[][]): number[][] | null {
  const [start, end] = line;
  const result: number[][] = [];
  
  // Sample points along the line and check if they're inside the polygon
  const numSamples = 50;
  let lastInside = false;
  let currentSegment: number[][] = [];
  
  for (let i = 0; i <= numSamples; i++) {
    const t = i / numSamples;
    const point: [number, number] = [
      start[0] + t * (end[0] - start[0]),
      start[1] + t * (end[1] - start[1])
    ];
    
    const isInside = isPointInPolygon(point[0], point[1], polygonRing.map(p => p as [number, number]));
    
    if (isInside && !lastInside) {
      // Entering polygon
      currentSegment = [point];
    } else if (isInside && lastInside) {
      // Still inside
      currentSegment.push(point);
    } else if (!isInside && lastInside) {
      // Exiting polygon
      if (currentSegment.length > 0) {
        currentSegment.push(point);
        if (currentSegment.length >= 2) {
          return currentSegment;
        }
      }
    }
    
    lastInside = isInside;
  }
  
  // If we end inside the polygon
  if (currentSegment.length >= 2) {
    return currentSegment;
  }
  
  return null;
}

/* Point in polygon test */
function isPointInPolygon(lng: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];

    const intersect =
      ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/* Convert lng/lat → slippy tile (x,y) at zoom z */
function lngLatToTile(lng: number, lat: number, z: number) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(
    ((1 -
      Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) /
        Math.PI) /
      2) *
      n,
  );
  return { x, y };
}

/* Determine all (x,y) tiles intersecting polygon bbox */
function tilesCoveringPolygon(polygon: AspectPolygon, z: number) {
  const lons = polygon.coordinates.map((c) => c[0]);
  const lats = polygon.coordinates.map((c) => c[1]);
  const min = { lon: Math.min(...lons), lat: Math.min(...lats) };
  const max = { lon: Math.max(...lons), lat: Math.max(...lats) };

  const tMin = lngLatToTile(min.lon, max.lat, z); // note: y axis inverted
  const tMax = lngLatToTile(max.lon, min.lat, z);

  const tiles: { x: number; y: number }[] = [];
  for (let x = tMin.x; x <= tMax.x; ++x) {
    for (let y = tMin.y; y <= tMax.y; ++y) tiles.push({ x, y });
  }
  return tiles;
}

/* Fetch & decode Mapbox Terrain‑RGB tile into TerrainTile object */
async function fetchTerrainTile(
  x: number,
  y: number,
  z: number,
  token: string,
  signal?: AbortSignal,
): Promise<TerrainTile> {
  const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}.pngraw?access_token=${token}`;

  try {
    const img = await loadImage(url, signal); // HTMLImageElement
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, img.width, img.height);

    return {
      x,
      y,
      z,
      width: img.width,
      height: img.height,
      data: imgData.data,
      format: 'terrain-rgb',
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Terrain tile fetch was cancelled');
    }
    throw error;
  }
}

/* Utility to load image via Blob */
function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    
    const cleanup = () => {
      img.onload = null;
      img.onerror = null;
      if (signal) {
        signal.removeEventListener('abort', handleAbort);
      }
    };
    
    const handleAbort = () => {
      cleanup();
      rej(new DOMException('Image load aborted', 'AbortError'));
    };
    
    img.onload = () => {
      cleanup();
      res(img);
    };
    
    img.onerror = () => {
      cleanup();
      rej(new Error('Failed to load terrain tile image'));
    };
    
    if (signal) {
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener('abort', handleAbort);
    }
    
    img.src = url;
  });
}

/* Fetch *all* tiles that overlap polygon */
async function fetchTilesForPolygon(
  polygon: AspectPolygon,
  z: number,
  token: string,
  signal?: AbortSignal,
): Promise<TerrainTile[]> {
  const tilesXY = tilesCoveringPolygon(polygon, z);
  const promises = tilesXY.map((t) => fetchTerrainTile(t.x, t.y, z, token, signal));
  
  try {
    return await Promise.all(promises);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Terrain tile fetch was cancelled');
    }
    throw error;
  }
}