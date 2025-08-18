/* Faster drop-in worker: identical functionality + per‑polygon stats */

import type { WorkerIn, WorkerOut, PoseMeters, GSDStats, PolygonLngLatWithId, PolygonTileStats } from "./types";
import { tileMetersBounds, worldToPixel } from "./mercator";
import { decodeTerrainRGBToElev } from "./terrain";
import { rotMat, camRayToPixel, normalFromDEM } from "./math3d";
import { rasterizeRingsToMask } from "./rasterize";

type Msg = WorkerIn;
type Ret = WorkerOut;

type PreparedPose = PoseMeters & {
  RT: Float64Array;
  radius: number;
  radiusSq: number;
};

function preparePoses(poses: PoseMeters[], zMin: number, diagTan: number): PreparedPose[] {
  const out: PreparedPose[] = new Array(poses.length);
  for (let i = 0; i < poses.length; i++) {
    const p = poses[i];
    const R = rotMat(p.omega_deg, p.phi_deg, p.kappa_deg);
    const RT = new Float64Array([R[0],R[3],R[6], R[1],R[4],R[7], R[2],R[5],R[8]]);
    const H = Math.max(1.0, p.z - zMin);
    const radius = H * diagTan * 1.25;
    out[i] = { ...p, RT, radius, radiusSq: radius * radius };
  }
  return out;
}

function ringsToPixels(
  polygons: PolygonLngLatWithId[],
  z:number, x:number, y:number, size:number
) {
  const tx = tileMetersBounds(z, x, y);
  tx.pixelSize = (tx.maxX - tx.minX) / size;

  const ringsPerPoly: Array<Array<[number,number]>> = [];
  const ids: string[] = [];

  for (let k = 0; k < polygons.length; k++) {
    const ring = polygons[k].ring;
    const ringPx: Array<[number,number]> = [];
    for (let i = 0; i < ring.length; i++) {
      const lng = ring[i][0];
      const lat = Math.max(-85.05112878, Math.min(85.05112878, ring[i][1]));
      const mx = (lng * Math.PI/180) * 6378137;
      const my = 6378137 * Math.log(Math.tan(Math.PI/4 + (lat*Math.PI/180)/2));
      const wp = worldToPixel(tx, mx, my);
      ringPx.push([wp[0], wp[1]]);
    }
    if (ringPx.length>=3) {
      ringsPerPoly.push(ringPx);
      ids.push(polygons[k].id ?? String(k));
    }
  }
  return { tx, ringsPerPoly, ids };
}

function buildPolygonMasks(
  polygons: PolygonLngLatWithId[], z:number, x:number, y:number, size:number
): { tx: any; masks: Uint8Array[]; unionMask: Uint8Array; ids: string[] } {
  const { tx, ringsPerPoly, ids } = ringsToPixels(polygons, z, x, y, size);
  const masks: Uint8Array[] = [];
  const unionMask = new Uint8Array(size*size);

  for (let i=0; i<ringsPerPoly.length; i++) {
    const mask = rasterizeRingsToMask([ringsPerPoly[i]], size);
    masks.push(mask);
    // union
    for (let j=0; j<unionMask.length; j++) if (mask[j]) unionMask[j] = 1;
  }
  return { tx, masks, unionMask, ids };
}

/** O(n) stats & histogram for a subset of indices with Mercator area correction. */
function calculateGSDStatsFast(
  gsdMin: Float32Array,
  activeIdxs: Uint32Array,
  pixelAreaEquator: number, // (pix*pix) at equator
  size: number,
  cosLatPerRow: Float64Array
): GSDStats {
  let count = 0, sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let totalAreaM2 = 0;

  // First pass: collect extrema, mean numerator, total area
  for (let i = 0; i < activeIdxs.length; i++) {
    const idx = activeIdxs[i];
    const gsd = gsdMin[idx];
    if (!(gsd > 0 && isFinite(gsd))) continue;
    count++; sum += gsd;
    const row = (idx / size) | 0;
    const cosφ = cosLatPerRow[row];
    const area = pixelAreaEquator * cosφ * cosφ; // scale correction
    totalAreaM2 += area;
    if (gsd < min) min = gsd;
    if (gsd > max) max = gsd;
  }

  if (count === 0 || !isFinite(min)) {
    return { min: 0, max: 0, mean: 0, count: 0, totalAreaM2: 0, histogram: [] } as any;
  }

  const mean = sum / count;
  const MAX_BINS = 20;
  const MIN_BIN_SIZE = 0.01; // 1 cm
  const span = max - min;
  let numBins = (span <= 0) ? 1 : MAX_BINS;
  if (span > 0 && (span / numBins) < MIN_BIN_SIZE) {
    numBins = Math.max(1, Math.floor(span / MIN_BIN_SIZE));
  }

  const histogram = new Array<{ bin: number; count: number; areaM2?: number }>(numBins);
  for (let b = 0; b < numBins; b++) histogram[b] = { bin: 0, count: 0, areaM2: 0 };

  if (span <= 0) {
    histogram[0].count = count;
    histogram[0].bin = min;
    histogram[0].areaM2 = totalAreaM2;
  } else {
    const binSize = span / numBins;
    for (let i = 0; i < activeIdxs.length; i++) {
      const idx = activeIdxs[i];
      const v = gsdMin[idx];
      if (!(v > 0 && isFinite(v))) continue;
      let bi = Math.floor((v - min) / binSize);
      if (bi >= numBins) bi = numBins - 1;
      const row = (idx / size) | 0;
      const cosφ = cosLatPerRow[row];
      const area = pixelAreaEquator * cosφ * cosφ;
      histogram[bi].count += 1;
      histogram[bi].areaM2 = (histogram[bi].areaM2 || 0) + area;
    }
    for (let b = 0; b < numBins; b++) histogram[b].bin = min + (b + 0.5) * binSize;
  }
  return { min, max, mean, count, totalAreaM2, histogram } as any;
}

self.onmessage = (ev: MessageEvent<Msg>) => {
  const { tile, polygons, poses, camera, options } = ev.data;
  const { z, x, y, size, data } = tile;

  const elev = decodeTerrainRGBToElev(data, size);

  // --- Polygon masks: per‑polygon + union (for overlay/hot loop)
  const { tx, masks: polyMasksOriginal, unionMask: polyMaskOriginal, ids: polyIds } = buildPolygonMasks(polygons, z, x, y, size);

  // Optional interior erosion (clipInnerBufferM in meters)
  let polyMasks = polyMasksOriginal;
  let polyMask = polyMaskOriginal;
  const clipInnerBufferM = options?.clipInnerBufferM ?? 0;
  if (clipInnerBufferM > 0) {
    const pixelSizeM = (tileMetersBounds(z, x, y).maxX - tileMetersBounds(z, x, y).minX) / size; // width in meters / size
    const radiusPx = Math.max(1, Math.floor(clipInnerBufferM / pixelSizeM));
    if (radiusPx > 0) {
      // Erode each polygon mask independently then rebuild union
      const erodeOnce = (src: Uint8Array, size:number): Uint8Array => {
        const dst = new Uint8Array(src.length);
        for (let r=1; r<size-1; r++) {
          const rowBase = r*size;
            for (let c=1; c<size-1; c++) {
              const idx = rowBase + c;
              if (!src[idx]) continue;
              if (src[idx - 1] && src[idx + 1] && src[idx - size] && src[idx + size]) dst[idx] = 1;
            }
        }
        return dst;
      };
      const erode = (src: Uint8Array, k:number): Uint8Array => {
        let cur = src;
        for (let i=0; i<k; i++) cur = erodeOnce(cur, size);
        return cur;
      };
      polyMasks = polyMasksOriginal.map(m => erode(m, radiusPx));
      polyMask = new Uint8Array(size*size);
      for (const m of polyMasks) for (let i=0;i<m.length;i++) if (m[i]) polyMask[i] = 1;
    }
  }

  // If nothing intersects this tile → early out
  let polyPixelCount = 0;
  for (let i = 0; i < polyMask.length; i++) polyPixelCount += polyMask[i];
  if (polyPixelCount === 0) {
    const ret: Ret = {
      z, x, y, size,
      overlap: new Uint16Array(size*size),
      gsdMin: new Float32Array(size*size).fill(Number.POSITIVE_INFINITY),
      maxOverlap: 0,
      minGsd: Number.POSITIVE_INFINITY,
      perPolygon: [] // explicit empty
    };
    (self as any).postMessage(ret, [ret.overlap.buffer, ret.gsdMin.buffer]);
    return;
  }

  // --- z min (for footprint radius)
  let zMin = +Infinity;
  for (let i = 0; i < elev.length; i++) { const ez = elev[i]; if (ez < zMin) zMin = ez; }

  // --- Precompute world coords
  tx.pixelSize = (tx.maxX - tx.minX) / size;
  const xwCol = new Float64Array(size);
  const ywRow = new Float64Array(size);
  const minX = tx.minX, maxY = tx.maxY, pix = tx.pixelSize;
  for (let c = 0; c < size; c++) xwCol[c] = minX + (c + 0.5) * pix;
  for (let r = 0; r < size; r++) ywRow[r] = maxY - (r + 0.5) * pix;
  // Mercator latitude cos factor per row for area correction
  const Rm = 6378137;
  const cosLatPerRow = new Float64Array(size);
  for (let r = 0; r < size; r++) {
    const latRad = Math.atan(Math.sinh(ywRow[r] / Rm));
    cosLatPerRow[r] = Math.cos(latRad);
  }

  // --- Precompute normals (active/union pixels) & active index list
  const normals = new Float32Array(size * size * 3);
  const activeIdxs = new Uint32Array(polyPixelCount);
  {
    let w = 0;
    for (let idx = 0; idx < elev.length; idx++) {
      if (polyMask[idx] === 0) continue;
      const row = (idx / size) | 0;
      const col = idx - row * size;
      const n = normalFromDEM(elev, size, row, col, pix);
      const base = idx * 3;
      normals[base]     = n[0];
      normals[base + 1] = n[1];
      normals[base + 2] = n[2];
      activeIdxs[w++] = idx;
    }
  }

  // --- Camera optics constants
  const sensorW = camera.w_px * camera.sx_m;
  const sensorH = camera.h_px * camera.sy_m;
  const diagFovHalf = Math.atan(0.5 * Math.hypot(sensorW, sensorH) / camera.f_m);
  const diagTan = Math.tan(diagFovHalf);
  const s_over_f = camera.sx_m / camera.f_m;
  const cosIncMin = 1e-3;

  // --- Prepared poses
  const P = preparePoses(poses, zMin, diagTan);

  // --- Stage-1 pose culling vs tile box
  const rectMinX = tx.minX, rectMaxX = tx.maxX, rectMinY = tx.minY, rectMaxY = tx.maxY;
  const candidateIdxs: number[] = [];
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    const dx = (p.x < rectMinX) ? (rectMinX - p.x) : (p.x > rectMaxX) ? (p.x - rectMaxX) : 0;
    const dy = (p.y < rectMinY) ? (rectMinY - p.y) : (p.y > rectMaxY) ? (p.y - rectMaxY) : 0;
    if (dx*dx + dy*dy <= p.radiusSq) candidateIdxs.push(i);
  }
  const useIdxs = (polyPixelCount > 0 && candidateIdxs.length === 0) ? P.map((_, i) => i) : candidateIdxs;

  // --- Stage-2: spatial grid of candidate poses
  const gridSize = Math.max(2, Math.min(32, options?.gridSize ?? 8));
  const cellW = (tx.maxX - tx.minX) / gridSize;
  const cellH = (tx.maxY - tx.minY) / gridSize;
  const grid: number[][] = new Array(gridSize * gridSize); for (let i = 0; i < grid.length; i++) grid[i] = [];

  for (let j = 0; j < useIdxs.length; j++) {
    const i = useIdxs[j];
    const p = P[i];
    const minXb = Math.max(tx.minX, p.x - p.radius);
    const maxXb = Math.min(tx.maxX, p.x + p.radius);
    const minYb = Math.max(tx.minY, p.y - p.radius);
    const maxYb = Math.min(tx.maxY, p.y + p.radius);
    if (minXb > maxXb || minYb > maxYb) continue;
    const x0 = Math.max(0, Math.floor((minXb - tx.minX) / cellW));
    const x1 = Math.min(gridSize - 1, Math.floor((maxXb - tx.minX) / cellW));
    const y0 = Math.max(0, Math.floor((tx.maxY - maxYb) / cellH));
    const y1 = Math.min(gridSize - 1, Math.floor((tx.maxY - minYb) / cellH));
    for (let gy = y0; gy <= y1; gy++) {
      const rowBase = gy * gridSize;
      for (let gx = x0; gx <= x1; gx++) {
        grid[rowBase + gx].push(j); // compact index j
      }
    }
  }

  // --- Precompute pixel->cell lookups
  const col2cellX = new Uint16Array(size);
  const row2cellY = new Uint16Array(size);
  for (let c = 0; c < size; c++) col2cellX[c] = Math.min(gridSize - 1, (c * gridSize / size) | 0);
  for (let r = 0; r < size; r++) row2cellY[r] = Math.min(gridSize - 1, (r * gridSize / size) | 0);

  // --- Flatten candidate pose fields
  const nCand = useIdxs.length;
  const pX = new Float64Array(nCand);
  const pY = new Float64Array(nCand);
  const pZ = new Float64Array(nCand);
  const pRadSq = new Float64Array(nCand);
  const pRTs: Float64Array[] = new Array(nCand);
  for (let k = 0; k < nCand; k++) {
    const p = P[useIdxs[k]];
    pX[k] = p.x; pY[k] = p.y; pZ[k] = p.z; pRadSq[k] = p.radiusSq; pRTs[k] = p.RT;
  }

  // --- Outputs (union)
  const N = size * size;
  const overlap = new Uint16Array(N);
  const gsdMin = new Float32Array(N);
  gsdMin.fill(Number.POSITIVE_INFINITY);

  const maxOverlapNeeded = Number.isFinite(options?.maxOverlapNeeded!) ? (options!.maxOverlapNeeded as number) : Infinity;

  // --- Per‑polygon pose-hit sets (use global pose indices – stable across tiles)
  const poseHitsPerPoly: Array<Set<number>> = polyIds.map(() => new Set<number>());

  // --- Main loop over active pixels only
  for (let t = 0; t < activeIdxs.length; t++) {
    const idx = activeIdxs[t];

    const row = (idx / size) | 0;
    const col = idx - row*size;
    const xw = xwCol[col];
    const yw = ywRow[row];
    const zw = elev[idx];

    // Find which polygons include this pixel (can be multiple; normally 1)
    const polysHere: number[] = [];
    for (let p = 0; p < polyMasks.length; p++) if (polyMasks[p][idx]) polysHere.push(p);
    if (polysHere.length === 0) continue;

    const nb = idx * 3;
    const nx = normals[nb], ny = normals[nb + 1], nz = normals[nb + 2];

    let localOverlap = 0;
    let localMinG = Number.POSITIVE_INFINITY;

    const cellIdx = (row2cellY[row] * gridSize + col2cellX[col]) | 0;
    const cellList = grid[cellIdx];
    if (cellList.length === 0) continue;

    for (let u = 0; u < cellList.length; u++) {
      const k = cellList[u];
      const dx2 = xw - pX[k], dy2 = yw - pY[k];
      if (dx2*dx2 + dy2*dy2 > pRadSq[k]) continue;

      const camHit = camRayToPixel(camera, pRTs[k], pX[k], pY[k], pZ[k], xw, yw, zw);
      if (!camHit) continue;

      // angle/gsd
      const vz = (zw - pZ[k]);
      const L = Math.hypot(dx2, dy2, vz);
      const invL = 1 / L;
      const rx = dx2*invL, ry = dy2*invL, rz = vz*invL;
      const cosInc = -(nx*rx + ny*ry + nz*rz);
      if (cosInc <= cosIncMin) continue;

      const gsd = (L * s_over_f) * (1 / cosInc);

      // Mark pose hit for *all* polygons covering this pixel
      const globalPoseIndex = useIdxs[k]; // index in original 'poses' array
      for (let pi = 0; pi < polysHere.length; pi++) {
        poseHitsPerPoly[polysHere[pi]].add(globalPoseIndex);
      }

      localOverlap++;
      if (gsd < localMinG) localMinG = gsd;
      if (localOverlap >= maxOverlapNeeded) break;
    }

    if (localOverlap > 0) {
      overlap[idx] = localOverlap;
      gsdMin[idx] = localMinG;
    }
  }

  // --- Union summaries
  let maxOverlap = 0, minGsd = Number.POSITIVE_INFINITY;
  for (let t = 0; t < activeIdxs.length; t++) {
    const idx = activeIdxs[t];
    const ov = overlap[idx];
    if (ov > maxOverlap) maxOverlap = ov;
    const g = gsdMin[idx];
    if (g > 0 && isFinite(g) && g < minGsd) minGsd = g;
  }

  // --- Per‑polygon stats: build index lists from masks and compute per‑polygon GSD stats
  const perPolygon: PolygonTileStats[] = [];
  for (let p = 0; p < polyMasks.length; p++) {
    // count active pixels for this polygon
    let cnt = 0;
    const mask = polyMasks[p];
    for (let i = 0; i < mask.length; i++) if (mask[i] && isFinite(gsdMin[i]) && gsdMin[i] > 0) cnt++;
    if (cnt === 0) {
      perPolygon.push({
        polygonId: polyIds[p],
        activePixelCount: 0,
        gsdStats: { min:0, max:0, mean:0, count:0, histogram: [] },
        hitPoseIds: new Uint32Array(0),
      });
      continue;
    }
    // build active idxs for this polygon
    const activeP = new Uint32Array(cnt);
    for (let i = 0, w=0; i < mask.length; i++) {
      if (mask[i] && isFinite(gsdMin[i]) && gsdMin[i] > 0) activeP[w++] = i;
    }
    const stats = calculateGSDStatsFast(gsdMin, activeP, pix*pix, size, cosLatPerRow);
    const hits = poseHitsPerPoly[p];
    const hitPoseIds = new Uint32Array(hits.size);
    let w = 0; 
    hits.forEach(id => { hitPoseIds[w++] = id; });

    perPolygon.push({
      polygonId: polyIds[p],
      activePixelCount: stats.count,
      gsdStats: stats,
      hitPoseIds
    });
  }

  // Tile‑level stats over union (kept for overlay legend if needed)
  const gsdStatsUnion: GSDStats = calculateGSDStatsFast(gsdMin, activeIdxs, pix*pix, size, cosLatPerRow);

  const ret: Ret = { z, x, y, size, overlap, gsdMin, maxOverlap, minGsd, gsdStats: gsdStatsUnion, perPolygon };
  (self as any).postMessage(ret, [overlap.buffer, gsdMin.buffer]);
};
