/***********************************************************************
 * terrainAspect.ts
 *
 * Compute a representative aspect (mean or median) for a polygonal
 * footprint and return the direction 90° from that aspect, i.e. the
 * azimuth along which ground elevation varies least on average.
 *
 * Author : <your‑name>, 2025‑07‑30
 ***********************************************************************/

export type LngLat = [lng: number, lat: number];

/** Simple ring polygon, no holes.  First and last vertex may be equal. */
export interface Polygon {
  coordinates: LngLat[];
}

/** One Mapbox tile worth of raster data that *covers* the polygon. */
export interface TerrainTile {
  /** Slippy‑map indices. */
  x: number;
  y: number;
  z: number;

  /** Raster dimensions – normally 256 × 256, but allow any. */
  width: number;
  height: number;

  /**
   * Pixel payload.
   *  * Terrain‑RGB – supply interleaved R,G,B (ignore A) length = w × h × 3 or 4
   *  * Single‑band DEM – supply float32 (metres) length = w × h
   */
  data: Uint8ClampedArray | Float32Array;

  /** `"terrain-rgb"` | `"dem"` */
  format: 'terrain-rgb' | 'dem';
}

export interface Options {
  /**
   * `'mean'` for circular mean (default, recommended because it is
   * unbiased and fast) or `'median'` for circular median (slower but
   * resistant to bimodality).
   */
  statistic?: 'mean' | 'median';
  /** Skip every *n* pixels to speed up large polygons (default = 1). */
  sampleStep?: number;
}

/** Return value. */
export interface AspectResult {
  /** Average or median aspect of the ground under the polygon [deg 0–360). */
  aspectDeg: number;
  /**
   * Direction 90° clockwise from aspect (constant‑height flight line),
   * again in degrees clockwise from north [deg 0–360).
   */
  contourDirDeg: number;
  /** Number of raster samples that contributed. 0 → polygon too small. */
  samples: number;
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export function dominantContourDirection(
  polygon: Polygon,
  tiles: TerrainTile[],
  opts: Options = {},
): AspectResult {
  const {
    statistic = 'mean',
    sampleStep = 1,
  } = opts;

  /* ------------------------------------------------------------------ */
  /* Gather per‑pixel aspect values (radians) inside the polygon        */
  /* ------------------------------------------------------------------ */
  const aspects: number[] = [];

  for (const tile of tiles) {
    const proj = new WebMercatorProjector(tile.z);

    for (let py = 1; py < tile.height - 1; py += sampleStep) {
      for (let px = 1; px < tile.width - 1; px += sampleStep) {
        // Convert pixel centre to lng/lat
        const [lng, lat] = proj.pixelToLngLat(tile.x, tile.y, px + 0.5, py + 0.5, tile.width);

        if (!pointInPolygon(lng, lat, polygon.coordinates)) continue;

        // Decode 3×3 neighbourhood elevations
        const elev = neighbourhood9(tile, px, py);
        if (elev === null) continue; // edge cases

        // Horizontal resolution (metres) at this latitude and zoom
        const res = proj.pixelResolution(lat, tile.width);

        const aspectRad = hornAspect(elev, res);
        if (!Number.isFinite(aspectRad)) continue;

        aspects.push(aspectRad);
      }
    }
  }

  if (aspects.length === 0) {
    return { aspectDeg: NaN, contourDirDeg: NaN, samples: 0 };
  }

  /* ------------------------------------------------------------------ */
  /* Combine aspects (circular statistic)                               */
  /* ------------------------------------------------------------------ */

  let aspectRad: number;

  if (statistic === 'mean') {
    // Circular mean via vector summation
    let sx = 0, sy = 0;
    for (const a of aspects) {
      sx += Math.cos(a);
      sy += Math.sin(a);
    }
    aspectRad = Math.atan2(sy, sx); // ‑π..π
    if (aspectRad < 0) aspectRad += 2 * Math.PI;
  } else {
    // Circular median via angular distance minimisation (Weiss, 1966)
    aspectRad = circularMedian(aspects);
  }

  const contourRad = (aspectRad + Math.PI / 2) % (2 * Math.PI);

  return {
    aspectDeg: radToDeg(aspectRad),
    contourDirDeg: radToDeg(contourRad),
    samples: aspects.length,
  };
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

/**
 * Decode 3×3 Horn kernel neighbourhood centred on (px,py).
 * Returns a length‑9 float[] in row‑major (Z1..Z9) order or null on edge.
 */
function neighbourhood9(tile: TerrainTile, px: number, py: number): number[] | null {
  const { width, height } = tile;
  if (px < 1 || py < 1 || px >= width - 1 || py >= height - 1) return null;

  const elev = new Array<number>(9);
  let idx = 0;
  for (let dy = -1; dy <= 1; ++dy) {
    for (let dx = -1; dx <= 1; ++dx) {
      elev[idx++] = getElevation(tile, px + dx, py + dy);
    }
  }
  return elev;
}

/** Horn (1981) aspect in *radians 0–2π*, following GIS conventions. */
function hornAspect(z: number[], res: number): number {
  // z index mapping:
  // 0 1 2
  // 3 4 5
  // 6 7 8
  const dzdx = ((z[2] + 2 * z[5] + z[8]) - (z[0] + 2 * z[3] + z[6])) / (8 * res);
  const dzdy = ((z[6] + 2 * z[7] + z[8]) - (z[0] + 2 * z[1] + z[2])) / (8 * res);

  // Aspect measured clockwise from north: atan2(dz/dy, -dz/dx)
  const aspect = Math.atan2(dzdy, -dzdx);
  return (aspect < 0) ? aspect + 2 * Math.PI : aspect;
}

/** Read elevation (metres) for pixel (px,py) in a tile. */
function getElevation(tile: TerrainTile, px: number, py: number): number {
  const idx = py * tile.width + px;
  if (tile.format === 'dem') {
    // Float32 DEM – 1 band
    return (tile.data as Float32Array)[idx];
  } else {
    // Terrain‑RGB – 4 bands (RGBA) or 3 bands (RGB)
    const base = idx * (tile.data.length === tile.width * tile.height * 4 ? 4 : 3);
    const r = tile.data[base];
    const g = tile.data[base + 1];
    const b = tile.data[base + 2];
    // Mapbox formula  height = -10000 + ((R*256*256 + G*256 + B)*0.1)  docs:
    // https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-rgb-v1/ :contentReference[oaicite:0]{index=0}
    return -10000 + ((r * 256 * 256 + g * 256 + b) * 0.1);
  }
}

/** Projector utilities for Web‑Mercator tile mathematics. */
class WebMercatorProjector {
  private readonly z2: number;
  constructor(private readonly z: number) { this.z2 = 2 ** z; }

  /**
   * Convert pixel to lng/lat (EPSG:4326).
   * px/py are pixel indices inside the tile (0..width).
   * width = height because Mapbox tiles are square – pass width as arg.
   */
  pixelToLngLat(tx: number, ty: number, px: number, py: number, width: number): LngLat {
    const normX = (tx * width + px) / (this.z2 * width);
    const normY = (ty * width + py) / (this.z2 * width);

    const lng = normX * 360 - 180;
    const n = Math.PI - 2 * Math.PI * normY;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return [lng, lat];
  }

  /** Horizontal ground resolution (metres per pixel) at latitude. */
  pixelResolution(lat: number, tilePx: number): number {
    const earthCircum = 40075016.68557849; // metres
    return Math.cos(degToRad(lat)) * earthCircum / (this.z2 * tilePx);
  }
}

/** Ray–crossing even–odd test for a single ring polygon. */
function pointInPolygon(lng: number, lat: number, ring: LngLat[]): boolean {
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

/** Fast circular median using angular sort (O(n log n)). */
function circularMedian(angles: number[]): number {
  // Map to unit circle
  const sorted = angles.slice().sort((a, b) => a - b);
  // Trick: duplicate list shifted by 2π so we can treat wrap‑around windows
  const dup = sorted.concat(sorted.map(a => a + 2 * Math.PI));

  // Sliding window of length n to find minimal range
  const n = angles.length;
  let bestRange = Infinity, bestStart = 0;
  let j = 0;
  for (let i = 0; i < n; ++i) {
    while (j < i + n && dup[j] - dup[i] <= Math.PI) ++j;
    const range = dup[j - 1] - dup[i];
    if (range < bestRange) {
      bestRange = range;
      bestStart = i;
    }
  }
  // The median is middle element of this minimal‑range window
  const medianIdx = bestStart + Math.floor(n / 2);
  return dup[medianIdx] % (2 * Math.PI);
}

/* Utility deg↔rad */
const degToRad = (d: number) => d * Math.PI / 180;
const radToDeg = (r: number) => (r * 180 / Math.PI + 360) % 360;

/* ------------------------------------------------------------------ */
/*                    End of terrainAspect.ts                         */
/* ------------------------------------------------------------------ */
