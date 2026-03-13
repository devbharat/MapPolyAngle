import type {
  DensityStats,
  LidarStripMeters,
  LidarWorkerIn,
  LidarWorkerOut,
  PolygonLngLatWithId,
  PolygonTileStats,
} from "./types";
import { tileMetersBounds, worldToPixel } from "./mercator";
import { rasterizeRingsToMask } from "./rasterize";
import { decodeTerrainRGBToElev } from "./terrain";
import { normalFromDEM } from "./math3d";
import * as egm96 from 'egm96-universal';

type Msg = LidarWorkerIn;
type Ret = LidarWorkerOut;

type PreparedStrip = LidarStripMeters & {
  index: number;
  x1s: number;
  y1s: number;
  x2s: number;
  y2s: number;
  dx: number;
  dy: number;
  lenSq: number;
  minXs: number;
  maxXs: number;
  minYs: number;
  maxYs: number;
  halfWidthSq: number;
  ux: number;
  uy: number;
  perpX: number;
  perpY: number;
};

function erode1px8(src: Uint8Array, size: number, dst: Uint8Array) {
  dst.fill(0);
  for (let y = 1; y < size - 1; y++) {
    const row = y * size;
    for (let x = 1; x < size - 1; x++) {
      const i = row + x;
      if (!src[i]) continue;
      const keep =
        src[i - 1] & src[i + 1] &
        src[i - size] & src[i + size] &
        src[i - size - 1] & src[i - size + 1] &
        src[i + size - 1] & src[i + size + 1];
      if (keep) dst[i] = 1;
    }
  }
}

function erodeN8(src: Uint8Array, size: number, radiusPx: number): Uint8Array {
  if (!(radiusPx > 0)) return src;
  let a: Uint8Array = src;
  let b: Uint8Array = new Uint8Array(size * size);
  for (let k = 0; k < radiusPx; k++) {
    erode1px8(a, size, b);
    const tmp = a;
    a = b;
    b = tmp;
  }
  return a === src ? new Uint8Array(a) : a;
}

function cropCenter(src: Uint8Array, sizePad: number, size: number, pad: number): Uint8Array {
  if (pad === 0) return src;
  const out = new Uint8Array(size * size);
  let w = 0;
  for (let y = pad; y < pad + size; y++) {
    const rowBase = y * sizePad + pad;
    for (let x = 0; x < size; x++) out[w++] = src[rowBase + x];
  }
  return out;
}

function ringsToPixelsWithTx(polygons: PolygonLngLatWithId[], tx: any) {
  const ringsPerPoly: Array<Array<[number, number]>> = [];
  const ids: string[] = [];
  for (let k = 0; k < polygons.length; k++) {
    const ring = polygons[k].ring;
    const ringPx: Array<[number, number]> = [];
    for (let i = 0; i < ring.length; i++) {
      const lng = ring[i][0];
      const lat = Math.max(-85.05112878, Math.min(85.05112878, ring[i][1]));
      const mx = (lng * Math.PI / 180) * 6378137;
      const my = 6378137 * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
      const wp = worldToPixel(tx, mx, my);
      ringPx.push([wp[0], wp[1]]);
    }
    if (ringPx.length >= 3) {
      ringsPerPoly.push(ringPx);
      ids.push(polygons[k].id ?? String(k));
    }
  }
  return { ringsPerPoly, ids };
}

function buildPolygonMasks(
  polygons: PolygonLngLatWithId[],
  z: number,
  x: number,
  y: number,
  size: number,
  erodeRadiusPx: number
): { tx: any; masks: Uint8Array[]; unionMask: Uint8Array; ids: string[] } {
  const base = tileMetersBounds(z, x, y);
  const pix = (base.maxX - base.minX) / size;
  const pad = Math.max(0, erodeRadiusPx);
  const sizePad = size + 2 * pad;
  const txPad = {
    minX: base.minX - pad * pix,
    maxX: base.maxX + pad * pix,
    minY: base.minY - pad * pix,
    maxY: base.maxY + pad * pix,
    pixelSize: pix,
  };
  const { ringsPerPoly, ids } = ringsToPixelsWithTx(polygons, txPad);
  const masks: Uint8Array[] = [];
  for (let i = 0; i < ringsPerPoly.length; i++) {
    const maskPad = rasterizeRingsToMask([ringsPerPoly[i]], sizePad);
    const erodedPad = erodeN8(maskPad, sizePad, pad);
    masks.push(pad > 0 ? cropCenter(erodedPad, sizePad, size, pad) : erodedPad);
  }
  const unionMask = new Uint8Array(size * size);
  for (const m of masks) {
    for (let i = 0; i < m.length; i++) {
      if (m[i]) unionMask[i] = 1;
    }
  }
  return { tx: base, masks, unionMask, ids };
}

function calculateDensityStats(
  density: Float32Array,
  activeIdxs: Uint32Array,
  pixelAreaEquator: number,
  size: number,
  cosLatPerRow: Float64Array
): DensityStats {
  let count = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let totalAreaM2 = 0;

  for (let i = 0; i < activeIdxs.length; i++) {
    const idx = activeIdxs[i];
    const value = density[idx];
    if (!(value > 0 && Number.isFinite(value))) continue;
    count++;
    sum += value;
    const row = (idx / size) | 0;
    const cosPhi = cosLatPerRow[row];
    totalAreaM2 += pixelAreaEquator * cosPhi * cosPhi;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  if (count === 0 || !Number.isFinite(min)) {
    return { min: 0, max: 0, mean: 0, count: 0, totalAreaM2: 0, histogram: [] };
  }

  const mean = sum / count;
  const MAX_BINS = 20;
  const histogram = new Array<{ bin: number; count: number; areaM2?: number }>(MAX_BINS);
  for (let i = 0; i < MAX_BINS; i++) histogram[i] = { bin: 0, count: 0, areaM2: 0 };

  const span = max - min;
  if (span <= 0) {
    histogram[0].bin = min;
    histogram[0].count = count;
    histogram[0].areaM2 = totalAreaM2;
  } else {
    const binSize = span / MAX_BINS;
    for (let i = 0; i < activeIdxs.length; i++) {
      const idx = activeIdxs[i];
      const value = density[idx];
      if (!(value > 0 && Number.isFinite(value))) continue;
      let binIndex = Math.floor((value - min) / binSize);
      if (binIndex >= MAX_BINS) binIndex = MAX_BINS - 1;
      const row = (idx / size) | 0;
      const cosPhi = cosLatPerRow[row];
      const areaM2 = pixelAreaEquator * cosPhi * cosPhi;
      histogram[binIndex].count += 1;
      histogram[binIndex].areaM2 = (histogram[binIndex].areaM2 || 0) + areaM2;
    }
    for (let i = 0; i < MAX_BINS; i++) histogram[i].bin = min + (i + 0.5) * binSize;
  }

  return {
    min,
    max,
    mean,
    count,
    totalAreaM2,
    histogram: histogram.filter((bin) => bin.count > 0 || (bin.areaM2 || 0) > 0),
  };
}

function convertElevationsToWGS84Ellipsoid(
  elevEGM96: Float32Array,
  size: number,
  tx: { minX: number; maxX: number; minY: number; maxY: number }
): Float32Array {
  const elevWGS84 = new Float32Array(size * size);
  const pixelSize = (tx.maxX - tx.minX) / size;
  const R = 6378137;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const idx = row * size + col;
      const x = tx.minX + (col + 0.5) * pixelSize;
      const y = tx.maxY - (row + 0.5) * pixelSize;
      const lon = (x / R) * (180 / Math.PI);
      const lat = Math.atan(Math.sinh(y / R)) * (180 / Math.PI);
      elevWGS84[idx] = egm96.egm96ToEllipsoid(lat, lon, elevEGM96[idx]);
    }
  }

  return elevWGS84;
}

function pointToSegmentProjection(x: number, y: number, strip: PreparedStrip): { t: number; distSq: number; px: number; py: number } {
  if (strip.lenSq <= 1e-6) {
    const dx = x - strip.x1s;
    const dy = y - strip.y1s;
    return { t: 0, distSq: dx * dx + dy * dy, px: strip.x1s, py: strip.y1s };
  }
  const t = Math.max(0, Math.min(1, ((x - strip.x1s) * strip.dx + (y - strip.y1s) * strip.dy) / strip.lenSq));
  const px = strip.x1s + t * strip.dx;
  const py = strip.y1s + t * strip.dy;
  const dx = x - px;
  const dy = y - py;
  return { t, distSq: dx * dx + dy * dy, px, py };
}

function emptyResult(z: number, x: number, y: number, size: number): Ret {
  return {
    z,
    x,
    y,
    size,
    overlap: new Uint16Array(size * size),
    maxOverlap: 0,
    minGsd: Number.POSITIVE_INFINITY,
    gsdMin: new Float32Array(size * size).fill(Number.POSITIVE_INFINITY),
    density: new Float32Array(size * size),
    maxDensity: 0,
    densityStats: { min: 0, max: 0, mean: 0, count: 0, totalAreaM2: 0, histogram: [] },
    perPolygon: [],
  };
}

self.onmessage = (ev: MessageEvent<Msg>) => {
  const { tile, polygons, strips, options } = ev.data;
  const { z, x, y, size, data } = tile;

  const tileBounds = tileMetersBounds(z, x, y);
  const clipM = Math.max(0, options?.clipInnerBufferM ?? 0);
  const pixM = (tileBounds.maxX - tileBounds.minX) / size;
  const radiusPx = clipM > 0 ? Math.max(1, Math.ceil(clipM / pixM)) : 0;
  const { tx, masks: polyMasks, unionMask: polyMask, ids: polyIds } = buildPolygonMasks(polygons, z, x, y, size, radiusPx);

  let polyPixelCount = 0;
  for (let i = 0; i < polyMask.length; i++) polyPixelCount += polyMask[i];
  if (polyPixelCount === 0 || !Array.isArray(strips) || strips.length === 0) {
    const ret = emptyResult(z, x, y, size);
    (self as any).postMessage(ret, [ret.overlap.buffer, ret.gsdMin.buffer, ret.density!.buffer]);
    return;
  }

  const elevEGM96 = decodeTerrainRGBToElev(data, size);
  const elev = convertElevationsToWGS84Ellipsoid(elevEGM96, size, tileBounds);

  const Rm = 6378137;
  const pixSizeRaw = (tx.maxX - tx.minX) / size;
  const xwColRaw = new Float64Array(size);
  const ywRowRaw = new Float64Array(size);
  for (let c = 0; c < size; c++) xwColRaw[c] = tx.minX + (c + 0.5) * pixSizeRaw;
  for (let r = 0; r < size; r++) ywRowRaw[r] = tx.maxY - (r + 0.5) * pixSizeRaw;

  const cosLatPerRow = new Float64Array(size);
  for (let r = 0; r < size; r++) {
    const latRad = Math.atan(Math.sinh(ywRowRaw[r] / Rm));
    cosLatPerRow[r] = Math.cos(latRad);
  }

  const latCenter = Math.atan(Math.sinh(((tx.minY + tx.maxY) * 0.5) / Rm));
  const scale = Math.cos(latCenter);
  const minX = tx.minX * scale;
  const maxX = tx.maxX * scale;
  const minY = tx.minY * scale;
  const maxY = tx.maxY * scale;
  const pixSize = pixSizeRaw * scale;
  const xwCol = new Float64Array(size);
  const ywRow = new Float64Array(size);
  for (let c = 0; c < size; c++) xwCol[c] = minX + (c + 0.5) * pixSize;
  for (let r = 0; r < size; r++) ywRow[r] = maxY - (r + 0.5) * pixSize;

  const activeIdxs = new Uint32Array(polyPixelCount);
  for (let i = 0, w = 0; i < polyMask.length; i++) {
    if (!polyMask[i]) continue;
    activeIdxs[w++] = i;
  }

  const normals = new Float32Array(size * size * 3);
  for (let i = 0; i < activeIdxs.length; i++) {
    const idx = activeIdxs[i];
    const row = (idx / size) | 0;
    const col = idx - row * size;
    const pixSizeGround = pixSizeRaw * cosLatPerRow[row];
    const n = normalFromDEM(elev, size, row, col, pixSizeGround);
    const base = idx * 3;
    normals[base] = n[0];
    normals[base + 1] = n[1];
    normals[base + 2] = n[2];
  }

  const prepared: PreparedStrip[] = strips
    .map((strip, index) => {
      const x1s = strip.x1 * scale;
      const y1s = strip.y1 * scale;
      const x2s = strip.x2 * scale;
      const y2s = strip.y2 * scale;
      const dx = x2s - x1s;
      const dy = y2s - y1s;
      const len = Math.hypot(dx, dy);
      const ux = len > 1e-6 ? dx / len : 0;
      const uy = len > 1e-6 ? dy / len : 0;
      const halfWidth = Math.max(0, strip.halfWidthM);
      return {
        ...strip,
        index,
        x1s,
        y1s,
        x2s,
        y2s,
        dx,
        dy,
        lenSq: dx * dx + dy * dy,
        minXs: Math.min(x1s, x2s) - halfWidth,
        maxXs: Math.max(x1s, x2s) + halfWidth,
        minYs: Math.min(y1s, y2s) - halfWidth,
        maxYs: Math.max(y1s, y2s) + halfWidth,
        halfWidthSq: halfWidth * halfWidth,
        ux,
        uy,
        perpX: -uy,
        perpY: ux,
      };
    })
    .filter((strip) => strip.densityPerPass > 0 && strip.halfWidthM > 0);

  if (prepared.length === 0) {
    const ret = emptyResult(z, x, y, size);
    (self as any).postMessage(ret, [ret.overlap.buffer, ret.gsdMin.buffer, ret.density!.buffer]);
    return;
  }

  const gridSize = 8;
  const cellW = (maxX - minX) / gridSize;
  const cellH = (maxY - minY) / gridSize;
  const grid: number[][] = new Array(gridSize * gridSize);
  for (let i = 0; i < grid.length; i++) grid[i] = [];

  for (let idx = 0; idx < prepared.length; idx++) {
    const strip = prepared[idx];
    if (strip.maxXs < minX || strip.minXs > maxX || strip.maxYs < minY || strip.minYs > maxY) continue;
    const x0 = Math.max(0, Math.floor((strip.minXs - minX) / cellW));
    const x1 = Math.min(gridSize - 1, Math.floor((strip.maxXs - minX) / cellW));
    const y0 = Math.max(0, Math.floor((maxY - strip.maxYs) / cellH));
    const y1 = Math.min(gridSize - 1, Math.floor((maxY - strip.minYs) / cellH));
    for (let gy = y0; gy <= y1; gy++) {
      const rowBase = gy * gridSize;
      for (let gx = x0; gx <= x1; gx++) grid[rowBase + gx].push(idx);
    }
  }

  const col2cellX = new Uint16Array(size);
  const row2cellY = new Uint16Array(size);
  for (let c = 0; c < size; c++) col2cellX[c] = Math.min(gridSize - 1, (c * gridSize / size) | 0);
  for (let r = 0; r < size; r++) row2cellY[r] = Math.min(gridSize - 1, (r * gridSize / size) | 0);

  const overlap = new Uint16Array(size * size);
  const gsdMin = new Float32Array(size * size).fill(Number.POSITIVE_INFINITY);
  const density = new Float32Array(size * size);
  const hitLinesPerPolygon: Array<Set<number>> = polyIds.map(() => new Set<number>());

  let maxOverlap = 0;
  let maxDensity = 0;

  for (let t = 0; t < activeIdxs.length; t++) {
    const idx = activeIdxs[t];
    const row = (idx / size) | 0;
    const col = idx - row * size;
    const xw = xwCol[col];
    const yw = ywRow[row];
    const cellIdx = (row2cellY[row] * gridSize + col2cellX[col]) | 0;
    const cellList = grid[cellIdx];
    if (cellList.length === 0) continue;

    const polysHere: number[] = [];
    for (let p = 0; p < polyMasks.length; p++) {
      if (polyMasks[p][idx]) polysHere.push(p);
    }
    if (polysHere.length === 0) continue;

    const bestByPass = new Map<number, { density: number; distSq: number }>();

    for (let i = 0; i < cellList.length; i++) {
      const strip = prepared[cellList[i]];
      const proj = pointToSegmentProjection(xw, yw, strip);
      if (proj.distSq > strip.halfWidthSq) continue;
      const sensorZ = Number.isFinite(strip.z1) && Number.isFinite(strip.z2)
        ? (strip.z1 as number) + proj.t * ((strip.z2 as number) - (strip.z1 as number))
        : Number.NaN;
      const zw = elev[idx];
      const heightAboveGround = Number.isFinite(sensorZ) ? (sensorZ - zw) : Number.NaN;
      const halfFovTan = strip.halfFovTan ?? 1;
      const localHalfWidth = Number.isFinite(heightAboveGround) && heightAboveGround > 0
        ? Math.max(0.01, heightAboveGround * halfFovTan)
        : strip.halfWidthM;
      if (!(localHalfWidth > 0)) continue;
      const crossTrack = Math.abs((xw - proj.px) * strip.perpX + (yw - proj.py) * strip.perpY);
      if (crossTrack > localHalfWidth) continue;
      if (Number.isFinite(sensorZ) && !(sensorZ > zw)) continue;
      const vx = xw - proj.px;
      const vy = yw - proj.py;
      const vz = zw - (Number.isFinite(sensorZ) ? sensorZ : zw);
      const range = Math.hypot(vx, vy, vz);
      if (!(range > 0)) continue;
      const maxRangeM = strip.maxRangeM ?? Number.POSITIVE_INFINITY;
      if (range > maxRangeM) continue;
      const nb = idx * 3;
      const nx = normals[nb];
      const ny = normals[nb + 1];
      const nz = normals[nb + 2];
      const cosInc = -(nx * (vx / range) + ny * (vy / range) + nz * (vz / range));
      if (!(cosInc > 1e-3)) continue;
      const effectivePointRate = strip.effectivePointRate ?? 0;
      const speedMps = strip.speedMps ?? 0;
      const localDensityContribution = (effectivePointRate > 0 && speedMps > 0)
        ? (effectivePointRate / (speedMps * (2 * localHalfWidth))) * cosInc
        : strip.densityPerPass;
      const passIndex = strip.passIndex ?? strip.index;
      const existing = bestByPass.get(passIndex);
      if (!existing || proj.distSq < existing.distSq) {
        bestByPass.set(passIndex, { density: localDensityContribution, distSq: proj.distSq });
      }
    }

    let localOverlap = 0;
    let localDensity = 0;
    bestByPass.forEach((entry, passIndex) => {
      localOverlap += 1;
      localDensity += entry.density;
      for (let p = 0; p < polysHere.length; p++) hitLinesPerPolygon[polysHere[p]].add(passIndex);
    });

    if (localOverlap > 0) {
      overlap[idx] = localOverlap;
      density[idx] = localDensity;
      if (localOverlap > maxOverlap) maxOverlap = localOverlap;
      if (localDensity > maxDensity) maxDensity = localDensity;
    }
  }

  const perPolygon: PolygonTileStats[] = [];
  const pixelAreaEquator = pixSize * pixSize;
  for (let p = 0; p < polyMasks.length; p++) {
    const mask = polyMasks[p];
    let count = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] && density[i] > 0 && Number.isFinite(density[i])) count++;
    }
    if (count === 0) {
      perPolygon.push({
        polygonId: polyIds[p],
        activePixelCount: 0,
        densityStats: { min: 0, max: 0, mean: 0, count: 0, totalAreaM2: 0, histogram: [] },
        hitLineIds: new Uint32Array(0),
      });
      continue;
    }
    const activePolygonPixels = new Uint32Array(count);
    for (let i = 0, w = 0; i < mask.length; i++) {
      if (mask[i] && density[i] > 0 && Number.isFinite(density[i])) activePolygonPixels[w++] = i;
    }
    const stats = calculateDensityStats(density, activePolygonPixels, pixelAreaEquator, size, cosLatPerRow);
    const hitSet = hitLinesPerPolygon[p];
    const hitLineIds = new Uint32Array(hitSet.size);
    let w = 0;
    hitSet.forEach((id) => {
      hitLineIds[w++] = id;
    });
    perPolygon.push({
      polygonId: polyIds[p],
      activePixelCount: stats.count,
      densityStats: stats,
      hitLineIds,
    });
  }

  const densityStats = calculateDensityStats(density, activeIdxs, pixelAreaEquator, size, cosLatPerRow);
  const ret: Ret = {
    z,
    x,
    y,
    size,
    overlap,
    maxOverlap,
    minGsd: Number.POSITIVE_INFINITY,
    gsdMin,
    density,
    maxDensity,
    densityStats,
    perPolygon,
  };
  (self as any).postMessage(ret, [overlap.buffer, gsdMin.buffer, density.buffer]);
};
