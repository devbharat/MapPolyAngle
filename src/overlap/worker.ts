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
  const tx = tileMetersBounds(z,x,y);
  const ringsPx: Array<Array<[number,number]>> = [];
  for (const poly of polygons) {
    const ringPx: Array<[number,number]> = [];
    for (const [lng,lat] of poly.ring) {
      const mx = (lng * Math.PI/180) * 6378137;
      const my = 6378137 * Math.log(Math.tan(Math.PI/4 + (Math.max(-85.05112878, Math.min(85.05112878, lat))*Math.PI/180)/2));
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

  // Build polygon mask
  const polyMask = buildPolygonMask(polygons, z,x,y,size);

  // Tile outputs
  const overlap = new Uint16Array(size*size);
  const gsdMin = new Float32Array(size*size);
  gsdMin.fill(Number.POSITIVE_INFINITY);

  // Quick z range for culling and sensible normal step
  let zMin = +Infinity, zMax = -Infinity;
  for (let i=0;i<elev.length;i++){ const z = elev[i]; if (z<zMin) zMin=z; if (z>zMax) zMax=z; }

  // Pre-cull poses by a coarse ground circle intersection
  const candidatePoses = P.filter(p => {
    // Project along camera -Z to plane z=zMin
    const R = rotMat(p.omega_deg,p.phi_deg,p.kappa_deg);
    const dz = R[8]*(-1); // world z component of camera -Z direction is R*(0,0,-1) => column 2 neg
    const dirx = R[2]; const diry = R[5]; const dirz = R[8]; // column 3 of R (world Z) ; but camera -Z is -R[:,2]
    const vx = -R[2], vy = -R[5], vz = -R[8];
    if (Math.abs(vz) < 1e-6) return true;
    const t = (zMin - p.z)/vz;
    const cx = p.x + t*vx;
    const cy = p.y + t*vy;
    // FOV radius on ground
    const hfov = Math.atan((camera.w_px*camera.sx_m*0.5)/camera.f_m);
    const vfov = Math.atan((camera.h_px*camera.sy_m*0.5)/camera.f_m);
    const fov = Math.max(hfov, vfov);
    const H = Math.max(1.0, (p.z - zMin));
    const radius = H * Math.tan(fov) * 1.5; // margin
    // AABB circle-overlap test with tile bounds in meters
    const {minX,maxX,minY,maxY} = tx;
    const closestX = Math.max(minX, Math.min(cx, maxX));
    const closestY = Math.max(minY, Math.min(cy, maxY));
    const dx = cx - closestX, dy = cy - closestY;
    return (dx*dx + dy*dy) <= radius*radius;
  });

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
  for (let i=0;i<overlap.length;i++){
    if (overlap[i] > maxOverlap) maxOverlap = overlap[i];
    const g = gsdMin[i];
    if (g > 0 && isFinite(g) && g < minGsd) minGsd = g;
  }

  const ret: Ret = { z, x, y, size, overlap, gsdMin, maxOverlap, minGsd };
  (self as any).postMessage(ret, [overlap.buffer, gsdMin.buffer]);
};
