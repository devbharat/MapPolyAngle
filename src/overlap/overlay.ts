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

// Log some test colors to verify the function works
console.log('Heatmap color test:');
console.log('t=0.0 (blue):', heatmapColor(0.0));
console.log('t=0.25 (cyan):', heatmapColor(0.25));
console.log('t=0.5 (green):', heatmapColor(0.5));
console.log('t=0.75 (yellow):', heatmapColor(0.75));
console.log('t=1.0 (red):', heatmapColor(1.0));

/**
 * Convert overlap values to a heatmap visualization
 * Higher overlap = warmer colors (red), lower overlap = cooler colors (blue)
 */
function encodeOverlapToImage(overlap: Uint16Array, size: number, maxValue: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const img = ctx.createImageData(size, size);
  
  // Collect statistics for debugging
  let minVal = Infinity, maxVal = -Infinity, sum = 0, count = 0;
  const values: number[] = [];
  
  for (let i = 0; i < overlap.length; i++) {
    const v = overlap[i];
    if (v > 0) {
      values.push(v);
      minVal = Math.min(minVal, v);
      maxVal = Math.max(maxVal, v);
      sum += v;
      count++;
    }
  }
  
  const meanVal = count > 0 ? sum / count : 0;
  console.log(`OVERLAP Stats - Count: ${count}, Min: ${minVal}, Max: ${maxVal}, Mean: ${meanVal.toFixed(2)}, Provided maxValue: ${maxValue}`);
  
  // Auto-adjust maxValue based on actual data if the provided value seems off
  let effectiveMax = maxValue;
  if (count > 0) {
    if (maxVal < maxValue * 0.1) {
      // If actual max is much smaller than provided max, use actual data range
      effectiveMax = Math.max(maxVal * 1.2, meanVal * 2);
      console.log(`Auto-adjusting overlap max from ${maxValue} to ${effectiveMax.toFixed(1)} based on small data range`);
    } else if (maxVal > maxValue * 2) {
      // If actual max is much larger than provided max, expand the range
      effectiveMax = maxVal * 1.1;
      console.log(`Auto-adjusting overlap max from ${maxValue} to ${effectiveMax.toFixed(1)} based on large data range`);
    }
  }
  
  console.log(`Using effective overlap max: ${effectiveMax.toFixed(1)}`);
  
  for (let i = 0, j = 0; i < overlap.length; i++, j += 4) {
    const v = overlap[i];
    if (v === 0) {
      // Transparent for no overlap
      img.data[j] = 0; img.data[j + 1] = 0; img.data[j + 2] = 0; img.data[j + 3] = 0;
      continue;
    }
    
    // Normalize to 0-1 range
    const t = effectiveMax > 0 ? Math.min(1, v / effectiveMax) : 0;
    const [r, g, b] = heatmapColor(t);
    
    img.data[j] = r;
    img.data[j + 1] = g;
    img.data[j + 2] = b;
    img.data[j + 3] = 200; // Good opacity for overlay
  }
  
  console.log(`OVERLAP - Sample normalized values: ${values.slice(0, 10).map(v => (v / effectiveMax).toFixed(3)).join(', ')}`);
  
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
  
  // Collect statistics for debugging
  let minVal = Infinity, maxVal = -Infinity, sum = 0, count = 0;
  const values: number[] = [];
  
  for (let i = 0; i < gsd.length; i++) {
    const g = gsd[i];
    if (Number.isFinite(g)) {
      values.push(g);
      minVal = Math.min(minVal, g);
      maxVal = Math.max(maxVal, g);
      sum += g;
      count++;
    }
  }
  
  const meanVal = count > 0 ? sum / count : 0;
  console.log(`GSD Stats - Count: ${count}, Min: ${minVal.toFixed(4)}, Max: ${maxVal.toFixed(4)}, Mean: ${meanVal.toFixed(4)}, Provided gsdMax: ${gsdMax}`);
  
  // Auto-adjust gsdMax based on actual data if the provided value seems too high
  let effectiveMax = gsdMax;
  if (count > 0 && maxVal < gsdMax * 0.2) {
    // If actual max is less than 20% of provided gsdMax, use a better range
    effectiveMax = Math.max(maxVal * 1.2, meanVal * 2); // Use 120% of max or 2x mean, whichever is larger
    console.log(`Auto-adjusting GSD max from ${gsdMax} to ${effectiveMax.toFixed(4)} based on data range`);
  }
  
  console.log(`Using effective GSD max: ${effectiveMax.toFixed(4)}`);
  
  for (let i = 0, j = 0; i < gsd.length; i++, j += 4) {
    const g = gsd[i];
    if (!Number.isFinite(g)) {
      // Transparent for invalid GSD
      img.data[j] = 0; img.data[j + 1] = 0; img.data[j + 2] = 0; img.data[j + 3] = 0;
      continue;
    }
    
    // Normalize: higher GSD (worse resolution) → closer to 1 (warmer colors = red)
    // Lower GSD (better resolution) → closer to 0 (cooler colors = blue/green)
    const t = Math.max(0, Math.min(1, g / effectiveMax));
    const [r, g_color, b] = heatmapColor(t);
    
    img.data[j] = r;
    img.data[j + 1] = g_color;
    img.data[j + 2] = b;
    img.data[j + 3] = 200; // Good opacity for overlay
  }
  
    console.log(`GSD - Sample normalized values: ${values.slice(0, 10).map(v => (v / effectiveMax).toFixed(3)).join(', ')}`);

/**
 * Convert GSD values to a heatmap visualization  
 * Higher GSD = worse resolution = warmer colors (red), Lower GSD = better resolution = cooler colors (blue/green)
 */
  
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
