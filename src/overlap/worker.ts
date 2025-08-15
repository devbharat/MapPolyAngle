import type { WorkerIn, WorkerOut, CameraModel, PoseMeters } from "./types";
import { tileMetersBounds, pixelToWorld, worldToPixel } from "./mercator";
import { decodeTerrainRGBToElev } from "./terrain";
import { rotMat, camRayToPixel, normalFromDEM } from "./math3d";
import { rasterizeRingsToMask } from "./rasterize";

type Msg = WorkerIn;
type Ret = WorkerOut;

function preparePoses(poses: PoseMeters[]) {
  return poses.map(p => {
    const R = rotMat(p.omega_deg, p.phi_deg, p.kappa_deg);
    // R^T for world->camera
    const RT = new Float64Array([R[0],R[3],R[6], R[1],R[4],R[7], R[2],R[5],R[8]]);
    return {...p, RT};
  });
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

self.onmessage = (ev: MessageEvent<Msg>) => {
  const { tile, polygons, poses, camera, options } = ev.data;
  const { z,x,y,size,data } = tile;
  const elev = decodeTerrainRGBToElev(data, size);
  const tx = tileMetersBounds(z,x,y);
  tx.pixelSize = (tx.maxX - tx.minX) / size;

  // Precompute per-pose matrices
  const P = preparePoses(poses);

  // Build polygon mask (now using correct per-tile pixel size internally)
  const polyMask = buildPolygonMask(polygons, z, x, y, size);

  // Tile outputs
  const overlap = new Uint16Array(size*size);
  const gsdMin = new Float32Array(size*size);
  gsdMin.fill(Number.POSITIVE_INFINITY);

  // Quick z range for culling and sensible normal step
  let zMin = +Infinity, zMax = -Infinity;
  for (let i=0;i<elev.length;i++){ const z = elev[i]; if (z<zMin) zMin=z; if (z>zMax) zMax=z; }

  // --- Robust pre-culling: AABB (tile rectangle) vs camera footprint circle ---
  // Use diagonal FOV for a conservative circular footprint on ground.
  const sensorW = camera.w_px * camera.sx_m;
  const sensorH = camera.h_px * camera.sy_m;
  const diagFov = Math.atan(0.5 * Math.hypot(sensorW, sensorH) / camera.f_m); // half-diagonal FoV

  const rect = { minX: tx.minX, minY: tx.minY, maxX: tx.maxX, maxY: tx.maxY };
  const distPointToAABB = (px: number, py: number) => {
    const dx = Math.max(rect.minX - px, 0, px - rect.maxX);
    const dy = Math.max(rect.minY - py, 0, py - rect.maxY);
    return Math.hypot(dx, dy);
  };

  let candidatePoses = P.filter(p => {
    // Altitude above tile's lowest ground (conservative; includes more poses)
    const H = Math.max(1.0, p.z - zMin);
    // Ground radius from FoV; add 25% safety.
    const radius = H * Math.tan(diagFov) * 1.25;
    const d = distPointToAABB(p.x, p.y);
    return d <= radius;
  });

  // Fail-safe: if polygon has pixels in this tile but no candidate cameras were kept,
  // do not cull at all for this tile (avoid false negatives).
  const polyPixels = polyMask.reduce((sum, v) => sum + (v ? 1 : 0), 0);
  if (polyPixels > 0 && candidatePoses.length === 0) {
    candidatePoses = P;
  }

  console.log(`=== TILE PROCESSING START ===`);
  console.log(`Tile bounds: (${tx.minX.toFixed(1)}, ${tx.minY.toFixed(1)}) to (${tx.maxX.toFixed(1)}, ${tx.maxY.toFixed(1)}): ${size}x${size} pixels`);
  console.log(`Terrain data: ${elev.length} values, elevation range: ${zMin.toFixed(1)}m to ${zMax.toFixed(1)}m`);
  console.log(`Polygon rings: ${polygons.length}`);
  console.log(`After rasterization: ${polyMask.reduce((sum,val) => sum + val, 0)} pixels inside polygon`);
  console.log(`Input poses: ${P.length} total`);
  console.log(`After spatial culling (AABB): ${candidatePoses.length} poses remaining for this tile`);

  // Main loop: per pixel within polygon mask; test pose coverage by projection
  for (let idx=0; idx<elev.length; idx++) {
    if (polyMask[idx] === 0) continue;

    const row = (idx / size) | 0;
    const col = idx - row*size;
    const [xw,yw] = pixelToWorld(tx, col, row);
    const zw = elev[idx];

    // normal (for oblique correction)
    const n = normalFromDEM(elev, size, row, col, tx.pixelSize);

    let localOverlap = 0;
    let localMinG = gsdMin[idx];

    for (let k=0; k<candidatePoses.length; k++) {
      const p = candidatePoses[k];
      const camHit = camRayToPixel(camera, p.RT, p.x, p.y, p.z, xw, yw, zw);
      if (!camHit) continue;

      // Incidence correction
      const vx = (xw - p.x), vy = (yw - p.y), vz = (zw - p.z);
      const L = Math.hypot(vx,vy,vz);
      const invL = 1 / L;
      const rx = vx*invL, ry = vy*invL, rz = vz*invL;
      const cosInc = -(n[0]*rx + n[1]*ry + n[2]*rz);
      if (cosInc <= 1e-3) continue;

      const s = camera.sx_m; // if anisotropic: use Math.sqrt(sx*sy)
      const gsd = (L * s / camera.f_m) * (1 / cosInc);

      localOverlap++;
      if (gsd < localMinG) localMinG = gsd;
    }

    if (localOverlap > 0) {
      overlap[idx] = localOverlap;
      gsdMin[idx] = localMinG;
    }
  }

  // Summaries
  let maxOverlap = 0, minGsd = Number.POSITIVE_INFINITY;
  let pixelsWithCoverage = 0, pixelsWithValidGSD = 0;
  for (let i=0;i<overlap.length;i++){
    if (overlap[i] > maxOverlap) maxOverlap = overlap[i];
    if (overlap[i] > 0) pixelsWithCoverage++;
    const g = gsdMin[i];
    if (g > 0 && isFinite(g)) {
      pixelsWithValidGSD++;
      if (g < minGsd) minGsd = g;
    }
  }

  console.log(`Computing coverage for ${polyMask.reduce((sum,val) => sum + val, 0)} pixels with ${candidatePoses.length} poses...`);
  console.log(`Results: ${pixelsWithCoverage} pixels with coverage, ${pixelsWithValidGSD} pixels with valid GSD`);
  console.log(`Max overlap: ${maxOverlap}, Min GSD: ${minGsd.toFixed(4)}m`);

  const ret: Ret = { z, x, y, size, overlap, gsdMin, maxOverlap, minGsd };
  (self as any).postMessage(ret, [overlap.buffer, gsdMin.buffer]);
};
