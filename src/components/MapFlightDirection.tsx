/***********************************************************************
 * MapFlightDirection.tsx
 *
 * Updated version: draw a polygon, compute dominant aspect using hybrid
 * plane fitting approach, show the 90° "constant-height" flight direction.
 *
 * Required npm packages (peer deps): react, mapbox-gl, @mapbox/mapbox-gl-draw
 *
 * © 2025 <your-name>. MIT License.
 ***********************************************************************/

import React, { useRef, useEffect, useState } from 'react';
import mapboxgl, { Map, LngLatLike, GeoJSONSource } from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';

import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

import {
  dominantContourDirectionPlaneFit,
  Polygon as AspectPolygon,
  TerrainTile,
  AspectResult,
} from '../utils/terrainAspectHybrid';

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
  /** Callback when analysis is complete */
  onAnalysisComplete?: (result: AspectResult | null) => void;
  /** Callback when analysis starts */
  onAnalysisStart?: () => void;
  /** Callback for errors */
  onError?: (error: string) => void;
}

/* ----------------------- main React component ----------------------- */
export const MapFlightDirection: React.FC<Props> = ({
  mapboxToken,
  center = [8.54, 47.37],
  zoom = 13,
  terrainZoom = 12,
  sampleStep = 2,
  onAnalysisComplete,
  onAnalysisStart,
  onError,
}) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map>();
  const drawRef = useRef<MapboxDraw>();
  const abortControllerRef = useRef<AbortController | null>(null);

  /* init map once ---------------------------------------------------- */
  useEffect(() => {
    if (!mapContainer.current) return;
    
    if (!mapboxToken) {
      console.error('Mapbox token is missing');
      return;
    }

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
      
      /* When user finishes (or updates) a polygon --------------------- */
      map.on('draw.create', handleDraw);
      map.on('draw.update', handleDraw);
      map.on('draw.delete', () => {
        removeFlightLine(map);
        onAnalysisComplete?.(null);
      });
    });
    
    map.on('error', (e) => {
      console.error('Map error:', e);
      onError?.(`Map loading error: ${e.error?.message || 'Unknown error'}`);
    });

    return () => {
      // Cancel any ongoing requests
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      map.remove();
    };
  }, [mapboxToken, center, zoom]);

  /* -------------- handle polygon draw / update --------------------- */
  const handleDraw = async () => {
    const map = mapRef.current!;
    const draw = drawRef.current!;
    const f = draw.getAll();

    /* Cancel any ongoing analysis */
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    /* Expect exactly one polygon */
    if (!f.features.length || f.features[0].geometry.type !== 'Polygon') {
      removeFlightLine(map);
      onAnalysisComplete?.(null);
      return;
    }

    const ring = (f.features[0].geometry.coordinates as number[][][])[0];
    const polygon: AspectPolygon = { coordinates: ring as [number, number][] };

    try {
      onAnalysisStart?.();

      /* Create new abort controller for this analysis */
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      /* Fetch terrain tiles at desired zoom --------------------------- */
      const tiles = await fetchTilesForPolygon(polygon, terrainZoom, mapboxToken, signal);
      
      if (signal.aborted) return;
      
      if (!tiles.length) {
        const errorMsg = 'Terrain tiles not found – polygon outside coverage?';
        onError?.(errorMsg);
        return;
      }

      /* Compute dominant aspect / flight direction using PLANE FITTING */
      const res = dominantContourDirectionPlaneFit(polygon, tiles, {
        sampleStep,
      });

      if (signal.aborted) return;

      if (!Number.isFinite(res.contourDirDeg)) {
        const errorMsg = res.fitQuality === 'poor' 
          ? 'Could not determine reliable direction (insufficient data or flat terrain)'
          : 'Could not determine aspect (flat terrain?)';
        onError?.(errorMsg);
        return;
      }

      // Enhanced quality feedback
      if (res.fitQuality === 'poor') {
        console.warn(`Low quality fit: ${res.fitQuality} (R²: ${res.rSquared?.toFixed(3) || 'N/A'}, samples: ${res.samples})`);
      } else {
        console.log(`Plane fit quality: ${res.fitQuality} (R²: ${res.rSquared?.toFixed(3) || 'N/A'}, RMSE: ${res.rmse?.toFixed(1) || 'N/A'}m, samples: ${res.samples})`);
      }

      /* Draw the direction line --------------------------------------- */
      addFlightLine(map, ring, res.contourDirDeg, res.fitQuality);
      onAnalysisComplete?.(res);
    } catch (error) {
      if (error instanceof Error && (error.message.includes('cancelled') || error.message.includes('aborted'))) {
        // Silently ignore cancelled requests
        return;
      }
      const errorMsg = error instanceof Error ? error.message : 'Analysis failed';
      onError?.(errorMsg);
    } finally {
      abortControllerRef.current = null;
    }
  };

  /* Public method to clear drawings */
  const clearDrawings = () => {
    const draw = drawRef.current;
    if (draw) {
      draw.deleteAll();
      removeFlightLine(mapRef.current!);
      onAnalysisComplete?.(null);
    }
  };

  /* Public method to activate polygon drawing */
  const startPolygonDrawing = () => {
    const draw = drawRef.current;
    if (draw) {
      (draw as any).changeMode('draw_polygon');
      console.log('Activated polygon drawing mode');
    }
  };

  /* Expose methods via ref */
  React.useImperativeHandle(undefined, () => ({
    clearDrawings,
    startPolygonDrawing,
  }), []);

  /* ------------------------ render div ----------------------------- */
  return (
    <div
      ref={mapContainer}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    />
  );
};

/* ==================================================================== */
/* ------------------------- helper utils ----------------------------- */
/* ==================================================================== */

/* Remove previous flight‑line source/layer if present */
function removeFlightLine(map: Map) {
  if (map.getLayer('flight-line')) map.removeLayer('flight-line');
  if (map.getSource('flight-line')) map.removeSource('flight-line');
}

/* Add flight‑line with quality-based styling */
function addFlightLine(
  map: Map,
  ring: number[][],
  bearingDeg: number,
  fitQuality?: string,
  lengthM = 1000,
) {
  removeFlightLine(map);

  const centroid = ring.reduce(
    (acc, p) => [acc[0] + p[0], acc[1] + p[1]],
    [0, 0],
  ).map((v) => v / ring.length) as [number, number];

  const p1 = destination(centroid, bearingDeg, lengthM);
  const p2 = destination(centroid, (bearingDeg + 180) % 360, lengthM);

  // Color and styling based on fit quality
  let lineColor = '#FF4081'; // Default pink
  let lineWidth = 3;
  let lineOpacity = 1;

  switch (fitQuality) {
    case 'excellent':
      lineColor = '#00E676'; // Bright green
      lineWidth = 4;
      break;
    case 'good':
      lineColor = '#2196F3'; // Blue
      lineWidth = 3;
      break;
    case 'fair':
      lineColor = '#FF9800'; // Orange
      lineWidth = 3;
      lineOpacity = 0.8;
      break;
    case 'poor':
      lineColor = '#F44336'; // Red
      lineWidth = 2;
      lineOpacity = 0.6;
      break;
  }

  const source: any = {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [p1, p2],
      },
      properties: {
        quality: fitQuality || 'unknown'
      },
    },
  };
  map.addSource('flight-line', source);

  map.addLayer({
    id: 'flight-line',
    type: 'line',
    source: 'flight-line',
    paint: {
      'line-color': lineColor,
      'line-width': lineWidth,
      'line-opacity': lineOpacity,
    },
  });

  // Add a subtle glow effect for high-quality fits
  if (fitQuality === 'excellent' || fitQuality === 'good') {
    map.addLayer({
      id: 'flight-line-glow',
      type: 'line',
      source: 'flight-line',
      paint: {
        'line-color': lineColor,
        'line-width': lineWidth + 4,
        'line-opacity': 0.3,
        'line-blur': 2,
      },
    }, 'flight-line'); // Add behind the main line
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

/* ------------------- terrain‑RGB tile helpers ---------------------- */

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