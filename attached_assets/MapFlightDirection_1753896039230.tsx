/***********************************************************************
 * MapFlightDirection.tsx
 *
 * Minimal demo: draw a polygon, compute dominant aspect inside it,
 * show the 90 ° “constant‑height” flight direction on the map.
 *
 * Required npm packages (peer deps): react, mapbox-gl, @mapbox/mapbox-gl-draw
 *
 * © 2025 <your‑name>. MIT License.
 ***********************************************************************/

import React, { useRef, useEffect } from 'react';
import mapboxgl, { Map, LngLatLike, GeoJSONSourceRaw } from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';

import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

import {
  dominantContourDirection,
  Polygon as AspectPolygon,
  TerrainTile,
} from './terrainAspect';          // <- path to the utility file

/* ----------------------------- props -------------------------------- */
interface Props {
  mapboxToken: string;
  /** Initial map centre. */
  center?: LngLatLike;
  zoom?: number;
  /** Terrain tile zoom level to sample (10‑14 reasonable). */
  terrainZoom?: number;
}

/* ----------------------- main React component ----------------------- */
export const MapFlightDirection: React.FC<Props> = ({
  mapboxToken,
  center = [8.54, 47.37],
  zoom = 13,
  terrainZoom = 12,
}) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map>();
  const drawRef = useRef<MapboxDraw>();

  /* init map once ---------------------------------------------------- */
  useEffect(() => {
    if (!mapContainer.current) return;

    mapboxgl.accessToken = mapboxToken;

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/outdoors-v12',
      center,
      zoom,
    });
    mapRef.current = map;

    const draw = new MapboxDraw({
      displayControlsDefault: false,
      controls: { polygon: true, trash: true },
    });
    drawRef.current = draw;
    map.addControl(draw, 'top-left');

    /* When user finishes (or updates) a polygon --------------------- */
    map.on('draw.create', handleDraw);
    map.on('draw.update', handleDraw);
    map.on('draw.delete', () => removeFlightLine(map));

    return () => {
      map.remove();
    };
  }, []);

  /* -------------- handle polygon draw / update --------------------- */
  const handleDraw = async () => {
    const map = mapRef.current!;
    const draw = drawRef.current!;
    const f = draw.getAll();

    /* Expect exactly one polygon */
    if (!f.features.length || f.features[0].geometry.type !== 'Polygon') {
      removeFlightLine(map);
      return;
    }

    const ring = (f.features[0].geometry.coordinates as number[][][])[0];
    const polygon: AspectPolygon = { coordinates: ring as [number, number][] };

    /* Fetch terrain tiles at desired zoom --------------------------- */
    const tiles = await fetchTilesForPolygon(polygon, terrainZoom, mapboxToken);
    if (!tiles.length) {
      alert('Terrain tiles not found – polygon outside coverage?');
      return;
    }

    /* Compute dominant aspect / flight direction -------------------- */
    const res = dominantContourDirection(polygon, tiles, {
      statistic: 'mean',
      sampleStep: 2,            // skip every 2nd pixel for speed
    });

    if (!Number.isFinite(res.contourDirDeg)) {
      alert('Could not determine aspect (flat terrain?)');
      return;
    }

    /* Draw the direction line --------------------------------------- */
    addFlightLine(map, ring, res.contourDirDeg);
  };

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

/* Add flight‑line as a simple 2‑km segment centred on polygon centroid */
function addFlightLine(
  map: Map,
  ring: number[][],
  bearingDeg: number,
  lengthM = 1000,
) {
  removeFlightLine(map);

  const centroid = ring.reduce(
    (acc, p) => [acc[0] + p[0], acc[1] + p[1]],
    [0, 0],
  ).map((v) => v / ring.length) as [number, number];

  const p1 = destination(centroid, bearingDeg, lengthM);
  const p2 = destination(centroid, (bearingDeg + 180) % 360, lengthM);

  const source: GeoJSONSourceRaw = {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [p1, p2],
      },
      properties: {},
    },
  };
  map.addSource('flight-line', source);

  map.addLayer({
    id: 'flight-line',
    type: 'line',
    source: 'flight-line',
    paint: {
      'line-color': '#ff00ff',
      'line-width': 3,
    },
  });
}

/* Haversine destination (spheroid not needed for ~1 km) */
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

/* Fetch & decode Mapbox Terrain‑RGB tile into TerrainTile object */
async function fetchTerrainTile(
  x: number,
  y: number,
  z: number,
  token: string,
): Promise<TerrainTile> {
  const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}.pngraw?access_token=${token}`;

  const img = await loadImage(url); // HTMLImageElement
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
}

/* Utility to load image via Blob */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}

/* Fetch *all* tiles that overlap polygon */
async function fetchTilesForPolygon(
  polygon: AspectPolygon,
  z: number,
  token: string,
): Promise<TerrainTile[]> {
  const tilesXY = tilesCoveringPolygon(polygon, z);
  const promises = tilesXY.map((t) => fetchTerrainTile(t.x, t.y, z, token));
  return Promise.all(promises);
}
