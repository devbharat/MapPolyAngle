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
import * as egm96 from 'egm96-universal';

type Msg = LidarWorkerIn;
type Ret = LidarWorkerOut;
const FIRST_RETURN_CHANNEL_TILT_DEG = 29;
const FIRST_RETURN_RANGE_TAPER_M = 20;

type PreparedStrip = LidarStripMeters & {
  index: number;
  x1s: number;
  y1s: number;
  x2s: number;
  y2s: number;
  dx: number;
  dy: number;
  dz: number;
  len: number;
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
  frameRateHzResolved: number;
  mappingFovDegResolved: number;
  maxRangeMResolved: number;
  azimuthSectorCenterDegResolved: number;
  verticalAnglesDegResolved: number[];
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
  cosLatPerRow: Float64Array,
  includeZeroDensity: boolean = false
): DensityStats {
  let count = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let totalAreaM2 = 0;

  for (let i = 0; i < activeIdxs.length; i++) {
    const idx = activeIdxs[i];
    const rawValue = density[idx];
    const value = includeZeroDensity
      ? ((Number.isFinite(rawValue) && rawValue > 0) ? rawValue : 0)
      : rawValue;
    if (!(includeZeroDensity || (value > 0 && Number.isFinite(value)))) continue;
    if (!Number.isFinite(value)) continue;
    const row = (idx / size) | 0;
    const cosPhi = cosLatPerRow[row];
    const areaM2 = pixelAreaEquator * cosPhi * cosPhi;
    count++;
    sum += value * areaM2;
    totalAreaM2 += areaM2;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  if (count === 0 || !Number.isFinite(min)) {
    return { min: 0, max: 0, mean: 0, count: 0, totalAreaM2: 0, histogram: [] };
  }

  const mean = totalAreaM2 > 0 ? (sum / totalAreaM2) : 0;
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
      const rawValue = density[idx];
      const value = includeZeroDensity
        ? ((Number.isFinite(rawValue) && rawValue > 0) ? rawValue : 0)
        : rawValue;
      if (!(includeZeroDensity || (value > 0 && Number.isFinite(value)))) continue;
      if (!Number.isFinite(value)) continue;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeVec3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z);
  if (!(len > 1e-9)) return [0, 0, -1];
  return [x / len, y / len, z / len];
}

function rotateAroundAxis(
  v: [number, number, number],
  axis: [number, number, number],
  angleDeg: number
): [number, number, number] {
  if (!(Math.abs(angleDeg) > 1e-9)) return v;
  const [ax, ay, az] = normalizeVec3(axis[0], axis[1], axis[2]);
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const dot = v[0] * ax + v[1] * ay + v[2] * az;
  const crossX = ay * v[2] - az * v[1];
  const crossY = az * v[0] - ax * v[2];
  const crossZ = ax * v[1] - ay * v[0];
  return [
    v[0] * c + crossX * s + ax * dot * (1 - c),
    v[1] * c + crossY * s + ay * dot * (1 - c),
    v[2] * c + crossZ * s + az * dot * (1 - c),
  ];
}

function sampleDemBilinear(
  dem: Float32Array,
  size: number,
  minX: number,
  maxY: number,
  pixelSize: number,
  x: number,
  y: number
): number {
  const colF = (x - minX) / pixelSize - 0.5;
  const rowF = (maxY - y) / pixelSize - 0.5;
  if (!(colF >= -0.5 && colF <= size - 0.5 && rowF >= -0.5 && rowF <= size - 0.5)) return Number.NaN;
  const c0 = clamp(Math.floor(colF), 0, size - 1);
  const r0 = clamp(Math.floor(rowF), 0, size - 1);
  const c1 = clamp(c0 + 1, 0, size - 1);
  const r1 = clamp(r0 + 1, 0, size - 1);
  const tx = clamp(colF - c0, 0, 1);
  const ty = clamp(rowF - r0, 0, 1);
  const i00 = r0 * size + c0;
  const i10 = r0 * size + c1;
  const i01 = r1 * size + c0;
  const i11 = r1 * size + c1;
  const z0 = dem[i00] * (1 - tx) + dem[i10] * tx;
  const z1 = dem[i01] * (1 - tx) + dem[i11] * tx;
  return z0 * (1 - ty) + z1 * ty;
}

function pointToPixelIndex(
  size: number,
  minX: number,
  maxY: number,
  pixelSize: number,
  x: number,
  y: number
): { row: number; col: number; idx: number } | null {
  const col = Math.floor((x - minX) / pixelSize);
  const row = Math.floor((maxY - y) / pixelSize);
  if (row < 0 || row >= size || col < 0 || col >= size) return null;
  return { row, col, idx: row * size + col };
}

function intersectRayWithTileXYBounds(
  sx: number,
  sy: number,
  dx: number,
  dy: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  maxRangeM: number
): { sEnter: number; sExit: number } | null {
  let sEnter = 0;
  let sExit = maxRangeM;
  const EPS = 1e-9;

  if (Math.abs(dx) < EPS) {
    if (sx < minX || sx > maxX) return null;
  } else {
    let tx0 = (minX - sx) / dx;
    let tx1 = (maxX - sx) / dx;
    if (tx0 > tx1) {
      const tmp = tx0;
      tx0 = tx1;
      tx1 = tmp;
    }
    sEnter = Math.max(sEnter, tx0);
    sExit = Math.min(sExit, tx1);
  }

  if (Math.abs(dy) < EPS) {
    if (sy < minY || sy > maxY) return null;
  } else {
    let ty0 = (minY - sy) / dy;
    let ty1 = (maxY - sy) / dy;
    if (ty0 > ty1) {
      const tmp = ty0;
      ty0 = ty1;
      ty1 = tmp;
    }
    sEnter = Math.max(sEnter, ty0);
    sExit = Math.min(sExit, ty1);
  }

  if (!(sExit >= Math.max(0, sEnter))) return null;
  return { sEnter: Math.max(0, sEnter), sExit: Math.max(0, sExit) };
}

function intersectBeamWithDem(
  dem: Float32Array,
  size: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  maxYOrigin: number,
  pixelSize: number,
  sx: number,
  sy: number,
  sz: number,
  dir: [number, number, number],
  maxRangeM: number,
  stepM: number
): { x: number; y: number; z: number; row: number; col: number; idx: number } | null {
  if (!(dir[2] < -1e-6)) return null;
  const boundsHit = intersectRayWithTileXYBounds(sx, sy, dir[0], dir[1], minX, maxX, minY, maxY, maxRangeM);
  if (!boundsHit) return null;

  const startS = boundsHit.sEnter;
  const endS = Math.min(boundsHit.sExit, maxRangeM);
  if (!(endS >= startS)) return null;

  const evalSignedHeight = (s: number): number => {
    const x = sx + dir[0] * s;
    const y = sy + dir[1] * s;
    const z = sz + dir[2] * s;
    const terrainZ = sampleDemBilinear(dem, size, minX, maxYOrigin, pixelSize, x, y);
    if (!Number.isFinite(terrainZ)) return Number.NaN;
    return z - terrainZ;
  };

  let prevS = startS;
  let prevF = evalSignedHeight(prevS);
  if (!Number.isFinite(prevF)) return null;
  if (prevF <= 0) {
    const hit = pointToPixelIndex(size, minX, maxYOrigin, pixelSize, sx + dir[0] * prevS, sy + dir[1] * prevS);
    if (!hit) return null;
    return { x: sx + dir[0] * prevS, y: sy + dir[1] * prevS, z: sz + dir[2] * prevS, row: hit.row, col: hit.col, idx: hit.idx };
  }

  for (let s = startS + stepM; s <= endS + 1e-6; s += stepM) {
    const currS = Math.min(s, endS);
    const currF = evalSignedHeight(currS);
    if (!Number.isFinite(currF)) {
      prevS = currS;
      prevF = currF;
      continue;
    }
    if (currF <= 0) {
      let lo = prevS;
      let hi = currS;
      let flo = prevF;
      for (let iter = 0; iter < 8; iter++) {
        const mid = 0.5 * (lo + hi);
        const fmid = evalSignedHeight(mid);
        if (!Number.isFinite(fmid)) break;
        if (fmid > 0) {
          lo = mid;
          flo = fmid;
        } else {
          hi = mid;
        }
      }
      const hitS = flo > 0 ? hi : lo;
      const x = sx + dir[0] * hitS;
      const y = sy + dir[1] * hitS;
      const z = sz + dir[2] * hitS;
      const hit = pointToPixelIndex(size, minX, maxYOrigin, pixelSize, x, y);
      if (!hit) return null;
      return { x, y, z, row: hit.row, col: hit.col, idx: hit.idx };
    }
    prevS = currS;
    prevF = currF;
  }

  return null;
}

function chooseAzimuthSampleCount(mappingFovDeg: number, swathWidthM: number, pixelSizeM: number): number {
  const targetByWidth = Math.max(7, Math.round(swathWidthM / Math.max(1, pixelSizeM * 2)));
  const targetByAngle = Math.max(7, Math.round(mappingFovDeg / 6));
  const count = clamp(Math.max(targetByWidth, targetByAngle), 7, 25);
  return count % 2 === 0 ? count + 1 : count;
}

function buildBeamDirection(
  alongAxis: [number, number, number],
  crossAxis: [number, number, number],
  azimuthDeg: number,
  channelDeg: number,
  boresightYawDeg: number,
  boresightPitchDeg: number,
  boresightRollDeg: number
): [number, number, number] {
  let dir: [number, number, number] = [0, 0, -1];
  dir = rotateAroundAxis(dir, alongAxis, azimuthDeg);
  dir = rotateAroundAxis(dir, crossAxis, channelDeg);
  dir = rotateAroundAxis(dir, [0, 0, -1], boresightYawDeg);
  dir = rotateAroundAxis(dir, crossAxis, boresightPitchDeg);
  dir = rotateAroundAxis(dir, alongAxis, boresightRollDeg);
  return normalizeVec3(dir[0], dir[1], dir[2]);
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

  const prepared: PreparedStrip[] = strips
    .map((strip, index) => {
      const x1s = strip.x1 * scale;
      const y1s = strip.y1 * scale;
      const x2s = strip.x2 * scale;
      const y2s = strip.y2 * scale;
      const dx = x2s - x1s;
      const dy = y2s - y1s;
      const dz = (strip.z2 ?? strip.z1 ?? 0) - (strip.z1 ?? strip.z2 ?? 0);
      const len = Math.hypot(dx, dy);
      const ux = len > 1e-6 ? dx / len : 0;
      const uy = len > 1e-6 ? dy / len : 0;
      const halfWidth = Math.max(0, strip.halfWidthM);
      const frameRateHzResolved = Math.max(1, Number.isFinite(strip.frameRateHz) ? strip.frameRateHz! : 10);
      const mappingFovDegResolved = clamp(
        Number.isFinite(strip.mappingFovDeg) ? strip.mappingFovDeg! : 90,
        1,
        180
      );
      const maxRangeMResolved = Math.max(1, Number.isFinite(strip.maxRangeM) ? strip.maxRangeM! : Number.POSITIVE_INFINITY);
      const azimuthSectorCenterDegResolved = Number.isFinite(strip.azimuthSectorCenterDeg) ? strip.azimuthSectorCenterDeg! : 0;
      const verticalAnglesDegResolved = Array.isArray(strip.verticalAnglesDeg) && strip.verticalAnglesDeg.length > 0
        ? strip.verticalAnglesDeg.filter((value): value is number => Number.isFinite(value))
        : [0];
      return {
        ...strip,
        index,
        x1s,
        y1s,
        x2s,
        y2s,
        dx,
        dy,
        dz,
        len,
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
        frameRateHzResolved,
        mappingFovDegResolved,
        maxRangeMResolved,
        azimuthSectorCenterDegResolved,
        verticalAnglesDegResolved,
      };
    })
    .filter((strip) => strip.densityPerPass > 0 && strip.halfWidthM > 0);

  if (prepared.length === 0) {
    const ret = emptyResult(z, x, y, size);
    (self as any).postMessage(ret, [ret.overlap.buffer, ret.gsdMin.buffer, ret.density!.buffer]);
    return;
  }

  const overlap = new Uint16Array(size * size);
  const gsdMin = new Float32Array(size * size).fill(Number.POSITIVE_INFINITY);
  const density = new Float32Array(size * size);
  const hitLinesPerPolygon: Array<Set<number>> = polyIds.map(() => new Set<number>());
  const lastPassSeen = new Int32Array(size * size).fill(-1);
  const polyIndexById = new Map<string, number>();
  for (let i = 0; i < polyIds.length; i++) polyIndexById.set(polyIds[i], i);
  const pixelAreaEquator = pixSize * pixSize;
  const pixelAreaByRow = new Float64Array(size);
  for (let row = 0; row < size; row++) {
    const cosPhi = cosLatPerRow[row];
    pixelAreaByRow[row] = pixelAreaEquator * cosPhi * cosPhi;
  }

  let maxOverlap = 0;
  let maxDensity = 0;
  const stepM = Math.max(1.5, pixSize * 0.75);

  for (let i = 0; i < prepared.length; i++) {
    const strip = prepared[i];
    const polygonId = strip.polygonId ?? null;
    if (!polygonId) continue;
    const polyIndex = polyIndexById.get(polygonId);
    if (polyIndex === undefined) continue;
    const polyMask = polyMasks[polyIndex];
    const speedMps = strip.speedMps ?? 0;
    const effectivePointRate = strip.effectivePointRate ?? 0;
    if (!(speedMps > 0) || !(effectivePointRate > 0) || !(strip.len > 1e-6)) continue;

    const alongSpacingM = Math.max(speedMps / strip.frameRateHzResolved, pixSize * 0.75);
    const sampleCount = Math.max(1, Math.ceil(strip.len / alongSpacingM));
    const representedDistancePerSampleM = strip.len / sampleCount;
    const pointsPerSample = effectivePointRate * (representedDistancePerSampleM / speedMps);
    const rawChannelAngles = strip.verticalAnglesDegResolved;
    const comparisonMode = strip.comparisonMode ?? 'first-return';
    const channelAngles = comparisonMode === 'first-return'
      ? rawChannelAngles.filter((angle) => angle <= 0)
      : rawChannelAngles;
    if (channelAngles.length === 0) continue;
    const swathWidthM = Math.max(2, strip.halfWidthM * 2);
    const azimuthSampleCount = chooseAzimuthSampleCount(strip.mappingFovDegResolved, swathWidthM, pixSize);
    const beamWeight = pointsPerSample / (rawChannelAngles.length * azimuthSampleCount);
    if (!(beamWeight > 0)) continue;

    const alongAxis: [number, number, number] = [strip.ux, strip.uy, 0];
    const crossAxis: [number, number, number] = [-strip.uy, strip.ux, 0];
    const z1 = strip.z1 ?? strip.z2 ?? 0;
    const z2 = strip.z2 ?? strip.z1 ?? z1;
    const boresightYawDeg = Number.isFinite(strip.boresightYawDeg) ? strip.boresightYawDeg! : 0;
    const boresightPitchDeg = Number.isFinite(strip.boresightPitchDeg) ? strip.boresightPitchDeg! : 0;
    const boresightRollDeg = Number.isFinite(strip.boresightRollDeg) ? strip.boresightRollDeg! : 0;
    const passIndex = strip.passIndex ?? strip.index;

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
      const t = sampleCount === 1 ? 0.5 : (sampleIndex + 0.5) / sampleCount;
      const sx = strip.x1s + strip.dx * t;
      const sy = strip.y1s + strip.dy * t;
      const sz = z1 + (z2 - z1) * t;
      const terrainUnderSensor = sampleDemBilinear(elev, size, minX, maxY, pixSize, sx, sy);
      const localAltitudeAGL = Number.isFinite(terrainUnderSensor) ? (sz - terrainUnderSensor) : Number.NaN;

      for (let azimuthIndex = 0; azimuthIndex < azimuthSampleCount; azimuthIndex++) {
        const azimuthFraction = azimuthSampleCount === 1 ? 0.5 : azimuthIndex / (azimuthSampleCount - 1);
        const azimuthDeg = strip.azimuthSectorCenterDegResolved + (azimuthFraction - 0.5) * strip.mappingFovDegResolved;

        for (let channelIndex = 0; channelIndex < channelAngles.length; channelIndex++) {
          const channelDeg = channelAngles[channelIndex];
          let channelWeight = 1;
          if (comparisonMode === 'first-return' && Number.isFinite(localAltitudeAGL) && localAltitudeAGL > 0) {
            const downwardLookDeg = FIRST_RETURN_CHANNEL_TILT_DEG - channelDeg;
            if (!(downwardLookDeg > 0)) continue;
            const downRad = (downwardLookDeg * Math.PI) / 180;
            const expectedFlatRange = localAltitudeAGL / Math.sin(downRad);
            if (!(expectedFlatRange < strip.maxRangeMResolved + FIRST_RETURN_RANGE_TAPER_M)) continue;
            if (expectedFlatRange > strip.maxRangeMResolved) {
              channelWeight = clamp(
                1 - (expectedFlatRange - strip.maxRangeMResolved) / FIRST_RETURN_RANGE_TAPER_M,
                0,
                1
              );
            }
          }

          const dir = buildBeamDirection(
            alongAxis,
            crossAxis,
            azimuthDeg,
            channelDeg,
            boresightYawDeg,
            boresightPitchDeg,
            boresightRollDeg
          );
          if (!(dir[2] < -1e-4)) continue;

          const hit = intersectBeamWithDem(
            elev,
            size,
            minX,
            maxX,
            minY,
            maxY,
            maxY,
            pixSize,
            sx,
            sy,
            sz,
            dir,
            strip.maxRangeMResolved,
            stepM
          );
          if (!hit) continue;
          if (!polyMask[hit.idx]) continue;

          const areaM2 = pixelAreaByRow[hit.row];
          const densityContribution = areaM2 > 0 ? ((beamWeight * channelWeight) / areaM2) : 0;
          if (!(densityContribution > 0)) continue;
          density[hit.idx] += densityContribution;
          if (density[hit.idx] > maxDensity) maxDensity = density[hit.idx];

          if (lastPassSeen[hit.idx] !== passIndex) {
            lastPassSeen[hit.idx] = passIndex;
            overlap[hit.idx] += 1;
            if (overlap[hit.idx] > maxOverlap) maxOverlap = overlap[hit.idx];
          }
          hitLinesPerPolygon[polyIndex].add(passIndex);
        }
      }
    }
  }

  const perPolygon: PolygonTileStats[] = [];
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
    let polygonPixelCount = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) polygonPixelCount++;
    }
    const polygonPixels = new Uint32Array(polygonPixelCount);
    for (let i = 0, w = 0; i < mask.length; i++) {
      if (mask[i]) polygonPixels[w++] = i;
    }

    const stats = calculateDensityStats(density, polygonPixels, pixelAreaEquator, size, cosLatPerRow, true);
    const hitSet = hitLinesPerPolygon[p];
    const hitLineIds = new Uint32Array(hitSet.size);
    let w = 0;
    hitSet.forEach((id) => {
      hitLineIds[w++] = id;
    });
    perPolygon.push({
      polygonId: polyIds[p],
      activePixelCount: activePolygonPixels.length,
      densityStats: stats,
      hitLineIds,
    });
  }

  const densityStats = calculateDensityStats(density, activeIdxs, pixelAreaEquator, size, cosLatPerRow, true);
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
