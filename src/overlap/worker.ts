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
    const radius = H * diagTan * 1.25; // keep safety margin
    out[i] = { ...p, RT, radius, radiusSq: radius * radius };
  }
  return out;
}

function buildPolygonMask(polygons: {ring:[number,number][]}[], z:number, x:number, y:number, size:number): Uint8Array {
  const tx = tileMetersBounds(z, x, y);
  // ✅ CRITICAL: use the real tile size to derive pixel size
  // (Mapbox terrain-rgb .pngraw is 256px unless explicitly requested otherwise)
  tx.pixelSize = (tx.maxX - tx.minX) / size;
  const ringsPx: Array<Array<[number,number]>> = [];
  for (const poly of polygons) {
    const ringPx: Array<[number,number]> = [];
    for (const [lng,lat] of poly.ring) {
      const mx = (lng * Math.PI/180) * 6378137;
      const my = 6378137 * Math.log(Math.tan(Math.PI/4 + (Math.max(-85.05112878, Math.min(85.05112878, lat))*Math.PI/180)/2));
      // worldToPixel now uses the corrected tx.pixelSize
      const [col,row] = worldToPixel(tx, mx, my);
      ringPx.push([col,row]);
    }
    if (ringPx.length>=3) ringsPx.push(ringPx);
  }
  if (ringsPx.length===0) return new Uint8Array(size*size);
  return rasterizeRingsToMask(ringsPx, size);
}

function calculateGSDStats(gsdMin: Float32Array, polyMask: Uint8Array): GSDStats {
  // Collect valid GSD values for pixels inside polygons
  const validGsds: number[] = [];
  for (let i = 0; i < gsdMin.length; i++) {
    if (polyMask[i] > 0) {
      const gsd = gsdMin[i];
      if (isFinite(gsd) && gsd > 0) {
        validGsds.push(gsd);
      }
    }
  }

  if (validGsds.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      count: 0,
      histogram: []
    };
  }

  // Sort for min/max calculation
  validGsds.sort((a, b) => a - b);
  const min = validGsds[0];
  const max = validGsds[validGsds.length - 1];
  const mean = validGsds.reduce((sum, gsd) => sum + gsd, 0) / validGsds.length;

  // Create histogram with 20 bins
  const numBins = 20;
  const binSize = (max - min) / numBins;
  const histogram: { bin: number; count: number }[] = [];
  
  for (let i = 0; i < numBins; i++) {
    const binStart = min + i * binSize;
    const binEnd = binStart + binSize;
    const count = validGsds.filter(gsd => 
      (i === numBins - 1) ? (gsd >= binStart && gsd <= binEnd) : (gsd >= binStart && gsd < binEnd)
    ).length;
    
    histogram.push({
      bin: binStart + binSize / 2, // Use bin center
      count
    });
  }

  return {
    min,
    max, 
    mean,
    count: validGsds.length,
    histogram
  };
}

self.onmessage = (ev: MessageEvent<Msg>) => {
  const { tile, polygons, poses, camera, options } = ev.data;
  const { z, x, y, size, data } = tile;
  const elev = decodeTerrainRGBToElev(data, size);
  const tx = tileMetersBounds(z, x, y);
  tx.pixelSize = (tx.maxX - tx.minX) / size;

  // --- Quick z range (used both for footprint and normals)
  let zMin = +Infinity, zMax = -Infinity;
  for (let i = 0; i < elev.length; i++) {
    const ez = elev[i];
    if (ez < zMin) zMin = ez;
    if (ez > zMax) zMax = ez;
  }

  // Build polygon mask (uses correct per-tile pixel size internally)
  const polyMask = buildPolygonMask(polygons, z, x, y, size);
  // Count active (inside) pixels once and build index list
  let polyPixelCount = 0;
  for (let i = 0; i < polyMask.length; i++) polyPixelCount += polyMask[i];
  if (polyPixelCount === 0) {
    const ret: Ret = { z, x, y, size, overlap: new Uint16Array(size*size), gsdMin: new Float32Array(size*size).fill(Number.POSITIVE_INFINITY), maxOverlap: 0, minGsd: Number.POSITIVE_INFINITY };
    (self as any).postMessage(ret, [ret.overlap.buffer, ret.gsdMin.buffer]);
    return;
  }

  // --- Precompute per-column/row world coords (cheaper than pixelToWorld per pixel)
  const xwCol = new Float64Array(size);
  const ywRow = new Float64Array(size);
  for (let c = 0; c < size; c++) xwCol[c] = tx.minX + (c + 0.5) * tx.pixelSize;
  for (let r = 0; r < size; r++) ywRow[r] = tx.maxY - (r + 0.5) * tx.pixelSize;

  // --- Precompute normals just once per active pixel
  const normals = new Float32Array(size * size * 3);
  const activeIdxs = new Uint32Array(polyPixelCount);
  {
    let w = 0;
    for (let idx = 0; idx < elev.length; idx++) {
      if (polyMask[idx] === 0) continue;
      const row = (idx / size) | 0;
      const col = idx - row * size;
      const n = normalFromDEM(elev, size, row, col, tx.pixelSize);
      const base = idx * 3;
      normals[base] = n[0];
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

  // --- Precompute per-pose matrices + conservative footprint radius
  const P = preparePoses(poses, zMin, diagTan);

  // --- Stage-1 pose culling: AABB distance to tile vs footprint radius
  const rect = { minX: tx.minX, minY: tx.minY, maxX: tx.maxX, maxY: tx.maxY };
  const distPointToAABB = (px: number, py: number) => {
    const dx = Math.max(rect.minX - px, 0, px - rect.maxX);
    const dy = Math.max(rect.minY - py, 0, py - rect.maxY);
    return Math.hypot(dx, dy);
  };
  let candidatePoses = P.filter(p => distPointToAABB(p.x, p.y) <= p.radius);
  // Fail-safe: if polygon has pixels but no candidates survived, keep all
  if (polyPixelCount > 0 && candidatePoses.length === 0) candidatePoses = P;

  // --- Stage-2: Spatial grid index of candidate poses (per tile)
  const gridSize = Math.max(2, Math.min(32, options?.gridSize ?? 8));
  const cellW = (tx.maxX - tx.minX) / gridSize;
  const cellH = (tx.maxY - tx.minY) / gridSize;
  const grid: number[][] = Array.from({ length: gridSize * gridSize }, () => []);
  // Map pose to every cell overlapped by its footprint bounding box
  for (let i = 0; i < candidatePoses.length; i++) {
    const p = candidatePoses[i];
    const minX = Math.max(tx.minX, p.x - p.radius);
    const maxX = Math.min(tx.maxX, p.x + p.radius);
    const minY = Math.max(tx.minY, p.y - p.radius);
    const maxY = Math.min(tx.maxY, p.y + p.radius);
    if (minX > maxX || minY > maxY) continue;
    const x0 = Math.max(0, Math.floor((minX - tx.minX) / cellW));
    const x1 = Math.min(gridSize - 1, Math.floor((maxX - tx.minX) / cellW));
    const y0 = Math.max(0, Math.floor((tx.maxY - maxY) / cellH)); // note inverted mercator Y
    const y1 = Math.min(gridSize - 1, Math.floor((tx.maxY - minY) / cellH));
    for (let gy = y0; gy <= y1; gy++) {
      const rowBase = gy * gridSize;
      for (let gx = x0; gx <= x1; gx++) {
        grid[rowBase + gx].push(i); // store index into candidatePoses
      }
    }
  }

  // Precompute pixel->cell lookups
  const col2cellX = new Uint16Array(size);
  const row2cellY = new Uint16Array(size);
  for (let c = 0; c < size; c++) col2cellX[c] = Math.min(gridSize - 1, Math.floor((c * gridSize) / size));
  for (let r = 0; r < size; r++) row2cellY[r] = Math.min(gridSize - 1, Math.floor((r * gridSize) / size));

  // Tile outputs
  const overlap = new Uint16Array(size*size);
  const gsdMin = new Float32Array(size*size);
  gsdMin.fill(Number.POSITIVE_INFINITY);

  // Optional early‑exit target (per pixel)
  const maxOverlapNeeded = Number.isFinite(options?.maxOverlapNeeded!)
    ? (options!.maxOverlapNeeded as number)
    : Infinity;

  // Main loop: only iterate pixels inside polygon
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
    const cellIdx = row2cellY[row] * gridSize + col2cellX[col];
    const cellList = grid[cellIdx];
    if (cellList.length === 0) continue;

    for (let u = 0; u < cellList.length; u++) {
      const p = candidatePoses[cellList[u]];
      // Cheap 2D footprint check before doing full projection
      const dx2 = xw - p.x, dy2 = yw - p.y;
      if (dx2*dx2 + dy2*dy2 > p.radiusSq) continue;

      const camHit = camRayToPixel(camera, p.RT, p.x, p.y, p.z, xw, yw, zw);
      if (!camHit) continue;

      // Incidence correction
      const vx = dx2, vy = dy2, vz = (zw - p.z);
      const L = Math.hypot(vx,vy,vz);
      const invL = 1 / L;
      const rx = vx*invL, ry = vy*invL, rz = vz*invL;
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

  // Summaries
  let maxOverlap = 0, minGsd = Number.POSITIVE_INFINITY;
  for (let i=0; i<overlap.length; i++){
    const ov = overlap[i];
    if (ov > maxOverlap) maxOverlap = ov;
    const g = gsdMin[i];
    if (g > 0 && isFinite(g) && g < minGsd) minGsd = g;
  }

  // Calculate GSD statistics for this tile
  const gsdStats = calculateGSDStats(gsdMin, polyMask);

  const ret: Ret = { z, x, y, size, overlap, gsdMin, maxOverlap, minGsd, gsdStats };
  (self as any).postMessage(ret, [overlap.buffer, gsdMin.buffer]);
};
