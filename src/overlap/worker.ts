/* Faster drop-in worker: identical functionality, optimized hot paths */

import type { WorkerIn, WorkerOut, CameraModel, PoseMeters, GSDStats } from "./types";
import { tileMetersBounds, pixelToWorld, worldToPixel } from "./mercator";
import { decodeTerrainRGBToElev } from "./terrain";
import { rotMat, camRayToPixel, normalFromDEM } from "./math3d";
import { rasterizeRingsToMask } from "./rasterize";

type Msg = WorkerIn;
type Ret = WorkerOut;

type PreparedPose = PoseMeters & {
  RT: Float64Array;
  /** conservative ground-footprint radius (meters) using half-diagonal FOV */
  radius: number;
  radiusSq: number;
};

function preparePoses(poses: PoseMeters[], zMin: number, diagTan: number): PreparedPose[] {
  const out: PreparedPose[] = new Array(poses.length);
  for (let i = 0; i < poses.length; i++) {
    const p = poses[i];
    const R = rotMat(p.omega_deg, p.phi_deg, p.kappa_deg);
    // R^T for world->camera
    const RT = new Float64Array([R[0],R[3],R[6], R[1],R[4],R[7], R[2],R[5],R[8]]);
    const H = Math.max(1.0, p.z - zMin);
    const radius = H * diagTan * 1.25; // safety margin
    out[i] = { ...p, RT, radius, radiusSq: radius * radius };
  }
  return out;
}

function buildPolygonMask(polygons: {ring:[number,number][]}[], z:number, x:number, y:number, size:number): Uint8Array {
  const tx = tileMetersBounds(z, x, y);
  // Use the real tile size to derive pixel size (256 or 512)
  tx.pixelSize = (tx.maxX - tx.minX) / size;
  const ringsPx: Array<Array<[number,number]>> = [];
  for (let k = 0; k < polygons.length; k++) {
    const ring = polygons[k].ring;
    const ringPx: Array<[number,number]> = [];
    for (let i = 0; i < ring.length; i++) {
      const lng = ring[i][0];
      const lat = ring[i][1];
      const mx = (lng * Math.PI/180) * 6378137;
      const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
      const my = 6378137 * Math.log(Math.tan(Math.PI/4 + (clamped*Math.PI/180)/2));
      const wp = worldToPixel(tx, mx, my);
      ringPx.push([wp[0], wp[1]]);
    }
    if (ringPx.length>=3) ringsPx.push(ringPx);
  }
  if (ringsPx.length===0) return new Uint8Array(size*size);
  return rasterizeRingsToMask(ringsPx, size);
}

/** O(n) statistics & histogram over *active* pixels only (no sort, no per-bin filters). */
function calculateGSDStatsFast(
  gsdMin: Float32Array,
  activeIdxs: Uint32Array
): GSDStats {
  let count = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;

  // 1st pass: min, max, mean (sum & count)
  for (let i = 0; i < activeIdxs.length; i++) {
    const idx = activeIdxs[i];
    const gsd = gsdMin[idx];
    if (gsd > 0 && isFinite(gsd)) {
      count++;
      sum += gsd;
      if (gsd < min) min = gsd;
      if (gsd > max) max = gsd;
    }
  }

  if (count === 0 || !isFinite(min)) {
    return { min: 0, max: 0, mean: 0, count: 0, histogram: [] };
  }

  const mean = sum / count;

  // 2nd pass: histogram (20 bins, last bin inclusive)
  const numBins = 20;
  const histogram = new Array<{ bin: number; count: number }>(numBins);
  for (let b = 0; b < numBins; b++) histogram[b] = { bin: 0, count: 0 };

  const span = max - min;
  if (span <= 0) {
    // All values identical → put all into first bin
    histogram[0].count = count;
    histogram[0].bin = min; // center == min
  } else {
    const binSize = span / numBins;
    for (let i = 0; i < activeIdxs.length; i++) {
      const idx = activeIdxs[i];
      const gsd = gsdMin[idx];
      if (!(gsd > 0 && isFinite(gsd))) continue;

      let bi = Math.floor((gsd - min) / binSize);
      if (bi >= numBins) bi = numBins - 1; // include max in last bin
      histogram[bi].count += 1;
    }
    for (let b = 0; b < numBins; b++) {
      histogram[b].bin = min + (b + 0.5) * (span / numBins); // center
    }
  }

  return { min, max, mean, count, histogram };
}

self.onmessage = (ev: MessageEvent<Msg>) => {
  const { tile, polygons, poses, camera, options } = ev.data;
  const { z, x, y, size, data } = tile;

  // --- DEM decode & tile geometry
  const elev = decodeTerrainRGBToElev(data, size);
  const tx = tileMetersBounds(z, x, y);
  tx.pixelSize = (tx.maxX - tx.minX) / size;

  // --- z-range (for footprint estimation)
  let zMin = +Infinity;
  for (let i = 0; i < elev.length; i++) {
    const ez = elev[i];
    if (ez < zMin) zMin = ez;
  }

  // --- Polygon mask & active pixels
  const polyMask = buildPolygonMask(polygons, z, x, y, size);
  let polyPixelCount = 0;
  for (let i = 0; i < polyMask.length; i++) polyPixelCount += polyMask[i];
  if (polyPixelCount === 0) {
    const ret: Ret = {
      z, x, y, size,
      overlap: new Uint16Array(size*size),
      gsdMin: new Float32Array(size*size).fill(Number.POSITIVE_INFINITY),
      maxOverlap: 0,
      minGsd: Number.POSITIVE_INFINITY
    };
    (self as any).postMessage(ret, [ret.overlap.buffer, ret.gsdMin.buffer]);
    return;
  }

  // --- Precompute per-column/row world coords
  const xwCol = new Float64Array(size);
  const ywRow = new Float64Array(size);
  const minX = tx.minX, maxY = tx.maxY, pix = tx.pixelSize;
  for (let c = 0; c < size; c++) xwCol[c] = minX + (c + 0.5) * pix;
  for (let r = 0; r < size; r++) ywRow[r] = maxY - (r + 0.5) * pix;

  // --- Precompute normals (active pixels only) & active indices
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

  // --- Camera optics
  const sensorW = camera.w_px * camera.sx_m;
  const sensorH = camera.h_px * camera.sy_m;
  const diagFovHalf = Math.atan(0.5 * Math.hypot(sensorW, sensorH) / camera.f_m);
  const diagTan = Math.tan(diagFovHalf);
  const s_over_f = camera.sx_m / camera.f_m;
  const cosIncMin = 1e-3;

  // --- Prepared poses
  const P = preparePoses(poses, zMin, diagTan);

  // --- Stage-1 culling against tile AABB
  const rectMinX = tx.minX, rectMaxX = tx.maxX, rectMinY = tx.minY, rectMaxY = tx.maxY;
  const candidateIdxs: number[] = [];
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    // distance from point to AABB (2D)
    const dx = (p.x < rectMinX) ? (rectMinX - p.x) : (p.x > rectMaxX) ? (p.x - rectMaxX) : 0;
    const dy = (p.y < rectMinY) ? (rectMinY - p.y) : (p.y > rectMaxY) ? (p.y - rectMaxY) : 0;
    if (dx*dx + dy*dy <= p.radiusSq) candidateIdxs.push(i);
  }
  const useIdxs = (polyPixelCount > 0 && candidateIdxs.length === 0) ? P.map((_, i) => i) : candidateIdxs;

  // --- Stage-2: spatial grid of candidate poses
  const gridSize = Math.max(2, Math.min(32, options?.gridSize ?? 8));
  const cellW = (tx.maxX - tx.minX) / gridSize;
  const cellH = (tx.maxY - tx.minY) / gridSize;
  const grid: number[][] = new Array(gridSize * gridSize);
  for (let i = 0; i < grid.length; i++) grid[i] = [];

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
    const y0 = Math.max(0, Math.floor((tx.maxY - maxYb) / cellH)); // inverted Y
    const y1 = Math.min(gridSize - 1, Math.floor((tx.maxY - minYb) / cellH));
    for (let gy = y0; gy <= y1; gy++) {
      const rowBase = gy * gridSize;
      for (let gx = x0; gx <= x1; gx++) {
        grid[rowBase + gx].push(j); // push compact index j, not global index i
      }
    }
  }

  // --- Precompute pixel->cell lookups
  const col2cellX = new Uint16Array(size);
  const row2cellY = new Uint16Array(size);
  for (let c = 0; c < size; c++) col2cellX[c] = Math.min(gridSize - 1, (c * gridSize / size) | 0);
  for (let r = 0; r < size; r++) row2cellY[r] = Math.min(gridSize - 1, (r * gridSize / size) | 0);

  // --- Flatten candidate pose fields into typed arrays (hot-loop friendly)
  const nCand = useIdxs.length;
  const pX = new Float64Array(nCand);
  const pY = new Float64Array(nCand);
  const pZ = new Float64Array(nCand);
  const pRadSq = new Float64Array(nCand);
  const pRTs: Float64Array[] = new Array(nCand);
  for (let k = 0; k < nCand; k++) {
    const p = P[useIdxs[k]];
    pX[k] = p.x;
    pY[k] = p.y;
    pZ[k] = p.z;
    pRadSq[k] = p.radiusSq;
    pRTs[k] = p.RT;
  }

  // --- Outputs
  const N = size * size;
  const overlap = new Uint16Array(N);
  const gsdMin = new Float32Array(N);
  gsdMin.fill(Number.POSITIVE_INFINITY);

  // Optional early-exit target (per pixel)
  const maxOverlapNeeded = Number.isFinite(options?.maxOverlapNeeded!)
    ? (options!.maxOverlapNeeded as number)
    : Infinity;

  // --- Main loop over active pixels only
  for (let t = 0; t < activeIdxs.length; t++) {
    const idx = activeIdxs[t];

    const row = (idx / size) | 0;
    const col = idx - row*size;
    const xw = xwCol[col];
    const yw = ywRow[row];
    const zw = elev[idx];

    // normal (precomputed) for oblique correction
    const nb = idx * 3;
    const nx = normals[nb], ny = normals[nb + 1], nz = normals[nb + 2];

    let localOverlap = 0;
    let localMinG = Number.POSITIVE_INFINITY;

    // Fetch candidate poses for this pixel's grid cell
    const cellIdx = (row2cellY[row] * gridSize + col2cellX[col]) | 0;
    const cellList = grid[cellIdx];
    if (cellList.length === 0) continue;

    for (let u = 0; u < cellList.length; u++) {
      // cellList now contains compact indices j (0 to nCand-1)
      const k = cellList[u]; // compact index into pX/Y/Z/RTs/pRadSq

      const dx2 = xw - pX[k];
      const dy2 = yw - pY[k];
      if (dx2*dx2 + dy2*dy2 > pRadSq[k]) continue;

      const camHit = camRayToPixel(camera, pRTs[k], pX[k], pY[k], pZ[k], xw, yw, zw);
      if (!camHit) continue;

      // Incidence correction & GSD
      const vz = (zw - pZ[k]);
      const L = Math.hypot(dx2, dy2, vz);
      const invL = 1 / L;
      const rx = dx2*invL, ry = dy2*invL, rz = vz*invL;
      const cosInc = -(nx*rx + ny*ry + nz*rz);
      if (cosInc <= cosIncMin) continue;

      const gsd = (L * s_over_f) * (1 / cosInc);

      localOverlap++;
      if (gsd < localMinG) localMinG = gsd;
      if (localOverlap >= maxOverlapNeeded) break; // early exit for this pixel
    }

    if (localOverlap > 0) {
      overlap[idx] = localOverlap;
      gsdMin[idx] = localMinG;
    }
  }

  // --- Summaries over active pixels only
  let maxOverlap = 0, minGsd = Number.POSITIVE_INFINITY;
  for (let t = 0; t < activeIdxs.length; t++) {
    const idx = activeIdxs[t];
    const ov = overlap[idx];
    if (ov > maxOverlap) maxOverlap = ov;
    const g = gsdMin[idx];
    if (g > 0 && isFinite(g) && g < minGsd) minGsd = g;
  }

  // --- GSD statistics (fast version on active pixels)
  const gsdStats: GSDStats = calculateGSDStatsFast(gsdMin, activeIdxs);

  const ret: Ret = { z, x, y, size, overlap, gsdMin, maxOverlap, minGsd, gsdStats };
  (self as any).postMessage(ret, [overlap.buffer, gsdMin.buffer]);
};
