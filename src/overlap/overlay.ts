import type mapboxgl from "mapbox-gl";
import type { TileResult } from "./types";
import { tileCornersForImageSource } from "./controller";

/**
 * Convert a normalized value (0-1) to a heatmap color (RGB)
 * Uses a blue -> cyan -> green -> yellow -> red color scale
 */
function heatmapColor(t: number): [number, number, number] {
  // Clamp t to [0, 1]
  t = Math.max(0, Math.min(1, t));
  
  if (t < 0.25) {
    // Blue to Cyan (0 -> 0.25)
    const s = t / 0.25;
    return [0, Math.round(255 * s), 255];
  } else if (t < 0.5) {
    // Cyan to Green (0.25 -> 0.5)
    const s = (t - 0.25) / 0.25;
    return [0, 255, Math.round(255 * (1 - s))];
  } else if (t < 0.75) {
    // Green to Yellow (0.5 -> 0.75)
    const s = (t - 0.5) / 0.25;
    return [Math.round(255 * s), 255, 0];
  } else {
    // Yellow to Red (0.75 -> 1.0)
    const s = (t - 0.75) / 0.25;
    return [255, Math.round(255 * (1 - s)), 0];
  }
}

/**
 * Convert overlap values to a heatmap visualization
 * Higher overlap = warmer colors (red), lower overlap = cooler colors (blue)
 */
function encodeOverlapToImage(overlap: Uint16Array, size: number, maxValue: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const img = ctx.createImageData(size, size);
  const effectiveMax = Math.max(1, maxValue); // Consistent across tiles

  for (let i = 0, j = 0; i < overlap.length; i++, j += 4) {
    const v = overlap[i];
    if (v === 0) {
      // Transparent for no overlap
      img.data[j] = 0; img.data[j + 1] = 0; img.data[j + 2] = 0; img.data[j + 3] = 0;
      continue;
    }
    // Normalize to 0-1 range (consistent)
    const t = effectiveMax > 0 ? Math.min(1, v / effectiveMax) : 0;
    const [r, g, b] = heatmapColor(t);
    
    img.data[j] = r;
    img.data[j + 1] = g;
    img.data[j + 2] = b;
    img.data[j + 3] = 200; // Good opacity for overlay
  }
  
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Convert GSD values to a heatmap visualization  
 * Higher GSD = worse resolution = warmer colors (red), Lower GSD = better resolution = cooler colors (blue/green)
 */
function encodeGsdToImage(gsd: Float32Array, size: number, gsdMax = 0.50): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const img = ctx.createImageData(size, size);
  const effectiveMax = Math.max(1e-6, gsdMax); // Consistent across tiles
  
  for (let i = 0, j = 0; i < gsd.length; i++, j += 4) {
    const g = gsd[i];
    if (!Number.isFinite(g)) {
      // Transparent for invalid GSD
      img.data[j] = 0; img.data[j + 1] = 0; img.data[j + 2] = 0; img.data[j + 3] = 0;
      continue;
    }
    // Normalize: higher GSD (worse) → 1 (warmer); lower (better) → 0 (cooler)
    const t = Math.max(0, Math.min(1, g / effectiveMax));
    const [r, g_color, b] = heatmapColor(t);
    
    img.data[j] = r;
    img.data[j + 1] = g_color;
    img.data[j + 2] = b;
    img.data[j + 3] = 200; // Good opacity for overlay
  }
  
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function addOrUpdateTileOverlay(
  map: mapboxgl.Map, result: TileResult, opts: { kind: "overlap"|"gsd"; runId: string; opacity?: number; gsdMax?: number }
) {
  const idBase = `ogsd-${opts.runId}-${opts.kind}-${result.z}-${result.x}-${result.y}`;
  const sourceId = idBase;
  const layerId = idBase;

  const corners = tileCornersForImageSource(result.z, result.x, result.y);

  let canvas: HTMLCanvasElement;
  if (opts.kind === "overlap") {
    canvas = encodeOverlapToImage(result.overlap, result.size, result.maxOverlap || 1);
  } else {
    canvas = encodeGsdToImage(result.gsdMin, result.size, opts.gsdMax ?? 0.5);
  }

  // Mapbox image source needs a URL; use data URL for the canvas
  const url = canvas.toDataURL("image/png");

  const exists = !!map.getSource(sourceId);
  if (!exists) {
    map.addSource(sourceId, {
      type: "image",
      url,
      coordinates: corners,
    } as any);
    map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
      paint: { "raster-opacity": opts.opacity ?? 0.85 },
    });
  } else {
    // Update by removing/adding (robust across versions)
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    map.addSource(sourceId, {
      type: "image",
      url,
      coordinates: corners,
    } as any);
    map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
      paint: { "raster-opacity": opts.opacity ?? 0.85 },
    });
  }
}

export function clearRunOverlays(map: mapboxgl.Map, runId: string) {
  const layers = map.getStyle().layers || [];
  for (const layer of layers) {
    const id = layer.id;
    if (id.startsWith(`ogsd-${runId}-`)) {
      if (map.getLayer(id)) map.removeLayer(id);
      const sourceId = id; // we used same id
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }
  }
}
