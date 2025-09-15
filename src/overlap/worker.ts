/* Faster drop-in worker: identical functionality + per‑polygon stats + multi-camera support */

import type { WorkerIn, WorkerOut, PoseMeters, GSDStats, PolygonLngLatWithId, PolygonTileStats, CameraModel } from "./types";
import { tileMetersBounds, worldToPixel } from "./mercator";
import { decodeTerrainRGBToElev } from "./terrain";
import { rotMat, camRayToPixel, normalFromDEM } from "./math3d";
import { rasterizeRingsToMask } from "./rasterize";
// Add EGM96 conversion library for proper vertical datum handling
import * as egm96 from 'egm96-universal';

// --- New morphological helpers (halo-based, 8-neighbour) ---
/** One‑pixel binary erosion (8‑neighbourhood). */
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
    const tmp = a; a = b; b = tmp;
  }
  return a === src ? new Uint8Array(a) : a; // defensive copy if unchanged reference
}
/** Crop the central size×size region from a (sizePad×sizePad) mask with uniform pad. */
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

// --- Convert terrain elevations from EGM96 geoid to WGS84 ellipsoid ---
/** 
 * Converts Mapbox Terrain-RGB elevations (EGM96 geoid) to WGS84 ellipsoid heights.
 * This ensures vertical datum consistency with DJI pose Z coordinates.
 */
function convertElevationsToWGS84Ellipsoid(
  elevEGM96: Float32Array, 
  size: number, 
  tx: { minX: number; maxX: number; minY: number; maxY: number }
): Float32Array {
  const elevWGS84 = new Float32Array(size * size);
  const pixelSize = (tx.maxX - tx.minX) / size;
  
  // Convert Web Mercator bounds to lat/lon for each pixel
  const R = 6378137; // WGS84 equatorial radius
  
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const idx = row * size + col;
      
      // Get Web Mercator coordinates for this pixel center
      const x = tx.minX + (col + 0.5) * pixelSize;
      const y = tx.maxY - (row + 0.5) * pixelSize; // Note: y decreases as row increases
      
      // Convert Web Mercator to WGS84 lat/lon
      const lon = (x / R) * (180 / Math.PI);
      const lat = Math.atan(Math.sinh(y / R)) * (180 / Math.PI);
      
      // Get original EGM96 elevation
      const elevEGM96Value = elevEGM96[idx];
      
      // Convert from EGM96 geoid to WGS84 ellipsoid
      // egm96.egm96ToEllipsoid(lat, lon, heightAboveGeoid) returns height above ellipsoid
      const elevWGS84Value = egm96.egm96ToEllipsoid(lat, lon, elevEGM96Value);
      
      elevWGS84[idx] = elevWGS84Value;
    }
  }
  
  return elevWGS84;
}

// --- Types (reuse WorkerIn/Out) ---
type Msg = WorkerIn;
type Ret = WorkerOut;

type PreparedPose = PoseMeters & {
  /** Camera->world rotation (row-major 3x3). */
  R: Float64Array;
  /** World->camera rotation (row-major 3x3), i.e., R^T. */
  RT: Float64Array;
  /** Precomputed per-pose coverage radius (meters). */
  radius: number;
  radiusSq: number;
  /** index into cameras array */
  camIndex: number;
  /** Camera axes in world: R*[1,0,0] and R*[0,1,0] (row-major) */
  bx0: number; bx1: number; bx2: number;
  by0: number; by1: number; by2: number;
};

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
  polygons: PolygonLngLatWithId[], z: number, x: number, y: number, size: number, erodeRadiusPx: number
): { tx: any; masks: Uint8Array[]; unionMask: Uint8Array; ids: string[] } {
  // Base (actual) tile bounds
  const base = tileMetersBounds(z, x, y);
  const pix = (base.maxX - base.minX) / size;
  const pad = Math.max(0, erodeRadiusPx);
  const sizePad = size + 2 * pad;
  // Padded bounds keep pixel size constant
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
  for (const m of masks) for (let i = 0; i < m.length; i++) if (m[i]) unionMask[i] = 1;
  return { tx: base, masks, unionMask, ids };
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
  const { tile, polygons, poses, camera, cameras, poseCameraIndices, options } = ev.data;
  const { z, x, y, size, data } = tile;

  // Determine camera mode
  let multi = Array.isArray(cameras) && cameras.length > 0 && poseCameraIndices instanceof Uint16Array && poseCameraIndices.length === poses.length;
  const camModels: CameraModel[] = multi ? (cameras as CameraModel[]) : (camera ? [camera] : []);
  const poseCamIdx: Uint16Array = multi ? (poseCameraIndices as Uint16Array) : new Uint16Array(poses.length); // all zeros if single
  if (camModels.length === 0) {
    const ret: Ret = { z, x, y, size, overlap: new Uint16Array(size*size), gsdMin: new Float32Array(size*size).fill(Number.POSITIVE_INFINITY), maxOverlap:0, minGsd:Number.POSITIVE_INFINITY, perPolygon: [] } as any;
    (self as any).postMessage(ret, [ret.overlap.buffer, ret.gsdMin.buffer]);
    return;
  }

  // CRITICAL FIX: Decode elevation and convert from EGM96 geoid to WGS84 ellipsoid
  // This ensures vertical datum consistency with DJI poses (which are typically WGS84 ellipsoid)
  const elevEGM96 = decodeTerrainRGBToElev(data, size);
  const tileBounds = tileMetersBounds(z, x, y);
  const elevWGS84 = convertElevationsToWGS84Ellipsoid(elevEGM96, size, tileBounds);
  
  // Now use elevWGS84 instead of raw elevEGM96 for all calculations
  const elev = elevWGS84;

  // Clip / erosion radius
  const clipM = Math.max(0, options?.clipInnerBufferM ?? 0);
  const pixM = (tileBounds.maxX - tileBounds.minX) / size;
  const radiusPx = clipM > 0 ? Math.max(1, Math.round(clipM / pixM)) : 0;

  const { tx, masks: polyMasks, unionMask: polyMask, ids: polyIds } = buildPolygonMasks(polygons, z, x, y, size, radiusPx);

  // Early out if no intersection
  let polyPixelCount = 0; for (let i=0;i<polyMask.length;i++) polyPixelCount += polyMask[i];
  if (polyPixelCount === 0) {
    const ret: Ret = { z, x, y, size, overlap: new Uint16Array(size*size), gsdMin: new Float32Array(size*size).fill(Number.POSITIVE_INFINITY), maxOverlap:0, minGsd:Number.POSITIVE_INFINITY, perPolygon: [] } as any;
    (self as any).postMessage(ret, [ret.overlap.buffer, ret.gsdMin.buffer]);
    return;
  }

  // zMin
  let zMin = +Infinity; for (let i=0;i<elev.length;i++){ const ez=elev[i]; if (ez < zMin) zMin = ez; }

  // Precompute projection helpers
  tx.pixelSize = (tx.maxX - tx.minX) / size;
  const xwCol = new Float64Array(size); const ywRow = new Float64Array(size);
  const minX = tx.minX, maxY = tx.maxY, pixSize = tx.pixelSize;
  for (let c=0;c<size;c++) xwCol[c] = minX + (c+0.5)*pixSize;
  for (let r=0;r<size;r++) ywRow[r] = maxY - (r+0.5)*pixSize;
  const Rm = 6378137; const cosLatPerRow = new Float64Array(size);
  for (let r=0;r<size;r++){ const latRad=Math.atan(Math.sinh(ywRow[r]/Rm)); cosLatPerRow[r]=Math.cos(latRad);}  

  // Precompute normals & active indices
  const normals = new Float32Array(size*size*3);
  const activeIdxs = new Uint32Array(polyPixelCount);
  { let w=0; for (let idx=0; idx<elev.length; idx++){ if (!polyMask[idx]) continue; const row=(idx/size)|0; const col=idx-row*size; const n=normalFromDEM(elev,size,row,col,pixSize); const base=idx*3; normals[base]=n[0]; normals[base+1]=n[1]; normals[base+2]=n[2]; activeIdxs[w++]=idx; } }

  // Per-camera precompute (diag tan + s/f)
  const camDiagTan: number[] = new Array(camModels.length);
  const cam_s_over_f: number[] = new Array(camModels.length);
  for (let ci=0; ci<camModels.length; ci++) {
    const c = camModels[ci];
    const sensorW = c.w_px * c.sx_m;
    const sensorH = c.h_px * c.sy_m;
    const diagFovHalf = Math.atan(0.5 * Math.hypot(sensorW, sensorH) / c.f_m);
    camDiagTan[ci] = Math.tan(diagFovHalf);
    cam_s_over_f[ci] = c.sx_m / c.f_m;
  }

  // Prepare poses (per-pose radius based on its camera)
  // NOTE: Pose z coordinates are assumed to already be in WGS84 ellipsoid (typical for DJI drones)
  const prepared: PreparedPose[] = new Array(poses.length);
  for (let i=0;i<poses.length;i++) {
    const p = poses[i];
    const idxVal = poseCamIdx[i];
    const camIdx = idxVal < camModels.length ? idxVal : 0;
    const Rm = rotMat(p.omega_deg, p.phi_deg, p.kappa_deg); // camera->world (row-major)
    const RT = new Float64Array([ Rm[0],Rm[3],Rm[6],
                                  Rm[1],Rm[4],Rm[7],
                                  Rm[2],Rm[5],Rm[8] ]);      // world->camera
    const H = Math.max(1.0, p.z - zMin);
    const diagTan = camDiagTan[camIdx];
    const radius = H * diagTan * 1.25;
    prepared[i] = {
      ...p,
      R: new Float64Array([ Rm[0],Rm[1],Rm[2], Rm[3],Rm[4],Rm[5], Rm[6],Rm[7],Rm[8] ]),
      RT,
      radius,
      radiusSq: radius*radius,
      camIndex: camIdx,
      // Precompute camera axis directions in world
      bx0: Rm[0], bx1: Rm[3], bx2: Rm[6], // R*[1,0,0]
      by0: Rm[1], by1: Rm[4], by2: Rm[7], // R*[0,1,0]
    };
  }

  // Stage-1 coarse cull vs tile box
  const rectMinX = tx.minX, rectMaxX = tx.maxX, rectMinY = tx.minY, rectMaxY = tx.maxY;
  const candidateIdxs: number[] = [];
  for (let i=0;i<prepared.length;i++) {
    const p = prepared[i];
    const dx = (p.x < rectMinX) ? (rectMinX - p.x) : (p.x > rectMaxX) ? (p.x - rectMaxX) : 0;
    const dy = (p.y < rectMinY) ? (rectMinY - p.y) : (p.y > rectMaxY) ? (p.y - rectMaxY) : 0;
    if (dx*dx + dy*dy <= p.radiusSq) candidateIdxs.push(i);
  }
  const useIdxs = (polyPixelCount > 0 && candidateIdxs.length === 0) ? prepared.map((_,i)=>i) : candidateIdxs;

  // Spatial grid of candidate poses
  const gridSize = Math.max(2, Math.min(32, options?.gridSize ?? 8));
  const cellW = (tx.maxX - tx.minX) / gridSize; const cellH = (tx.maxY - tx.minY) / gridSize;
  const grid: number[][] = new Array(gridSize*gridSize); for (let i=0;i<grid.length;i++) grid[i]=[];
  for (let j=0;j<useIdxs.length;j++) {
    const i = useIdxs[j]; const p = prepared[i];
    const minXb = Math.max(tx.minX, p.x - p.radius); const maxXb = Math.min(tx.maxX, p.x + p.radius);
    const minYb = Math.max(tx.minY, p.y - p.radius); const maxYb = Math.min(tx.maxY, p.y + p.radius);
    if (minXb > maxXb || minYb > maxYb) continue;
    const x0 = Math.max(0, Math.floor((minXb - tx.minX) / cellW));
    const x1 = Math.min(gridSize - 1, Math.floor((maxXb - tx.minX) / cellW));
    const y0 = Math.max(0, Math.floor((tx.maxY - maxYb) / cellH));
    const y1 = Math.min(gridSize - 1, Math.floor((tx.maxY - minYb) / cellH));
    for (let gy=y0; gy<=y1; gy++) {
      const rowBase = gy*gridSize;
      for (let gx=x0; gx<=x1; gx++) grid[rowBase+gx].push(j);
    }
  }

  // Pixel->cell lookup
  const col2cellX = new Uint16Array(size); const row2cellY = new Uint16Array(size);
  for (let c=0;c<size;c++) col2cellX[c] = Math.min(gridSize-1, (c*gridSize/size)|0);
  for (let r=0;r<size;r++) row2cellY[r] = Math.min(gridSize-1, (r*gridSize/size)|0);

  // Outputs
  const N = size*size; const overlap = new Uint16Array(N); const gsdMin = new Float32Array(N); gsdMin.fill(Number.POSITIVE_INFINITY);
  const maxOverlapNeeded = Number.isFinite(options?.maxOverlapNeeded!) ? (options!.maxOverlapNeeded as number) : Infinity;
  const poseHitsPerPoly: Array<Set<number>> = polyIds.map(()=> new Set<number>());

  const cosIncMin = 1e-3;
  // DEBUG: Track camera heights for debug output
  const debugCameraHeights = new Map<number, { poseId: string; heightAGL: number; terrainElev: number; cameraElev: number }>();
  
  // Active pixel loop - now using consistent WGS84 ellipsoid heights for both terrain and poses
  for (let t=0; t<activeIdxs.length; t++) {
    const idx = activeIdxs[t];
    const row = (idx/size)|0; const col = idx - row*size; const xw = xwCol[col]; const yw = ywRow[row]; const zw = elev[idx];
    const polysHere: number[] = []; for (let p=0;p<polyMasks.length;p++) if (polyMasks[p][idx]) polysHere.push(p); if (polysHere.length===0) continue;
    const nb = idx*3; const nx = normals[nb], ny = normals[nb+1], nz = normals[nb+2];

    let localOverlap = 0; let localMinG = Number.POSITIVE_INFINITY;
    const cellIdx = (row2cellY[row]*gridSize + col2cellX[col])|0; const cellList = grid[cellIdx]; if (cellList.length===0) continue;

    for (let u=0; u<cellList.length; u++) {
      const k = cellList[u]; const poseIdx = useIdxs[k]; const p = prepared[poseIdx];
      const dx2 = xw - p.x, dy2 = yw - p.y; if (dx2*dx2 + dy2*dy2 > p.radiusSq) continue;
      const camIdx = p.camIndex; const cam = camModels[camIdx];
      const camHit = camRayToPixel(cam, p.RT, p.x, p.y, p.z, xw, yw, zw); if (!camHit) continue;
      
      // DEBUG: Calculate and store camera height above ground for this pose
      if (!debugCameraHeights.has(poseIdx)) {
        const heightAGL = p.z - zw; // Camera elevation - terrain elevation = height AGL
        debugCameraHeights.set(poseIdx, {
          poseId: p.id || `pose_${poseIdx}`,
          heightAGL: heightAGL,
          terrainElev: zw,
          cameraElev: p.z
        });
      }
      
      // --- Jacobian-based surface GSD (pinhole-correct) ---
      const vz = (zw - p.z);
      const L = Math.hypot(dx2, dy2, vz);
      if (!(L > 0)) continue;
      const invL = 1 / L;
      const rx = dx2*invL, ry = dy2*invL, rz = vz*invL;
      const cosInc = -(nx*rx + ny*ry + nz*rz);
      if (cosInc <= cosIncMin) continue; // grazing/backfacing

      // Ray in camera coords: r_cam = R^T * r_world
      const rcx = p.RT[0]*rx + p.RT[1]*ry + p.RT[2]*rz;
      const rcy = p.RT[3]*rx + p.RT[4]*ry + p.RT[5]*rz;
      const rcz = p.RT[6]*rx + p.RT[7]*ry + p.RT[8]*rz;
      if (Math.abs(rcz) < 1e-12) continue; // parallel to image plane

      const f = cam.f_m;
      // Sensor coordinates (meters) relative to principal point
      const u_m = f * (rcx / rcz);
      const v_m = f * (rcy / rcz);

      // a = R * [u,v,f]^T  (camera ray direction in world for that pixel)
      const a0 = p.R[0]*u_m + p.R[1]*v_m + p.R[2]*f;
      const a1 = p.R[3]*u_m + p.R[4]*v_m + p.R[5]*f;
      const a2 = p.R[6]*u_m + p.R[7]*v_m + p.R[8]*f;
      const denom = nx*a0 + ny*a1 + nz*a2;
      if (Math.abs(denom) < 1e-12) continue;

      // Normal distance to the local tangent plane
      const Hn = nx*(xw - p.x) + ny*(yw - p.y) + nz*(zw - p.z);
      const invDen2 = 1.0 / (denom*denom);

      // Ju = Hn/den^2 * (den*bx - (n·bx)*a), where bx = R*[1,0,0]
      const nbx = nx*p.bx0 + ny*p.bx1 + nz*p.bx2;
      const Jux = (denom*p.bx0 - nbx*a0) * Hn * invDen2;
      const Juy = (denom*p.bx1 - nbx*a1) * Hn * invDen2;
      const Juz = (denom*p.bx2 - nbx*a2) * Hn * invDen2;

      // Jv = Hn/den^2 * (den*by - (n·by)*a), where by = R*[0,1,0]
      const nby = nx*p.by0 + ny*p.by1 + nz*p.by2;
      const Jvx = (denom*p.by0 - nby*a0) * Hn * invDen2;
      const Jvy = (denom*p.by1 - nby*a1) * Hn * invDen2;
      const Jvz = (denom*p.by2 - nby*a2) * Hn * invDen2;

      // Convert to meters per pixel using pixel pitches; scalar GSD = geometric mean
      const sx = cam.sx_m, sy = cam.sy_m;
      const gsdx = Math.hypot(Jux, Juy, Juz) * sx;
      const gsdy = Math.hypot(Jvx, Jvy, Jvz) * sy;
      const gsd = Math.sqrt(gsdx * gsdy);
      
      // Debug logging (optional)
      // if (poseIdx < 3) console.log(`GSD for pose ${poseIdx}: ${gsd.toFixed(4)}m (gsdx: ${gsdx.toFixed(4)}, gsdy: ${gsdy.toFixed(4)})`);
       const globalPoseIndex = poseIdx; for (let pi=0; pi<polysHere.length; pi++) poseHitsPerPoly[polysHere[pi]].add(globalPoseIndex);
       localOverlap++; if (gsd < localMinG) localMinG = gsd; if (localOverlap >= maxOverlapNeeded) break;
     }

    if (localOverlap > 0) { overlap[idx] = localOverlap; gsdMin[idx] = localMinG; }
  }

  // DEBUG: Print camera heights (sample first 10 for brevity)
  const heightEntries = Array.from(debugCameraHeights.values()).slice(0, 10);
  if (heightEntries.length > 0) {
    //console.log(`[Worker ${z}/${x}/${y}] Camera Heights (WGS84 ellipsoid):`);
    heightEntries.forEach(({ poseId, heightAGL, terrainElev, cameraElev }) => {
     //console.log(`  ${poseId}: ${heightAGL.toFixed(1)}m AGL (cam: ${cameraElev.toFixed(1)}m, terrain: ${terrainElev.toFixed(1)}m)`);
    });
  }

  // Enforce minimum overlap for GSD validity
  const MIN_OVERLAP_FOR_GSD = 3;
  for (let t=0;t<activeIdxs.length;t++){ const idx=activeIdxs[t]; if (overlap[idx]>0 && overlap[idx] < MIN_OVERLAP_FOR_GSD){ overlap[idx]=0; gsdMin[idx]=Number.POSITIVE_INFINITY; } }

  // Union summaries
  let maxOverlap = 0, minGsd = Number.POSITIVE_INFINITY;
  for (let t=0;t<activeIdxs.length;t++){ const idx=activeIdxs[t]; const ov = overlap[idx]; if (ov>maxOverlap) maxOverlap=ov; const g=gsdMin[idx]; if (g>0 && isFinite(g) && g<minGsd) minGsd=g; }

  // Per-polygon stats
  const perPolygon: PolygonTileStats[] = [];
  for (let p=0;p<polyMasks.length;p++) {
    let cnt=0; const mask=polyMasks[p]; for (let i=0;i<mask.length;i++) if (mask[i] && isFinite(gsdMin[i]) && gsdMin[i] > 0) cnt++;
    if (cnt===0){ perPolygon.push({ polygonId: polyIds[p], activePixelCount:0, gsdStats:{min:0,max:0,mean:0,count:0,histogram:[]}, hitPoseIds:new Uint32Array(0)}); continue; }
    const activeP = new Uint32Array(cnt); for (let i=0,w=0;i<mask.length;i++) if (mask[i] && isFinite(gsdMin[i]) && gsdMin[i] > 0) activeP[w++]=i;
    const stats = calculateGSDStatsFast(gsdMin, activeP, pixSize*pixSize, size, cosLatPerRow);
    const hits = poseHitsPerPoly[p]; const hitPoseIds = new Uint32Array(hits.size); let w=0; hits.forEach(id=>{ hitPoseIds[w++]=id; });
    perPolygon.push({ polygonId: polyIds[p], activePixelCount: stats.count, gsdStats: stats, hitPoseIds });
  }

  const gsdStatsUnion: GSDStats = calculateGSDStatsFast(gsdMin, activeIdxs, pixSize*pixSize, size, cosLatPerRow);
  const ret: Ret = { z, x, y, size, overlap, gsdMin, maxOverlap, minGsd, gsdStats: gsdStatsUnion, perPolygon };
  (self as any).postMessage(ret, [overlap.buffer, gsdMin.buffer]);
};