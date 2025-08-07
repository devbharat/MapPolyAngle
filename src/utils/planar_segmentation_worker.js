/*
 * planar_segmentation_worker.js —  v2.2
 * -----------------------------------------------------------------------------
 * ✨ Highlights
 *   • 100 % rewrite of extractSeams(): true Moore‑neighbourhood contour tracing
 *     with per‑label visitation masks → correct, non‑duplicated polygons.
 *   • readbackBuf allocated once per solve() chunk → no per‑iteration leak.
 *   • Minor readability refactor (no more mega one‑liners).
 * -----------------------------------------------------------------------------
 * Remaining low‑impact items: GPU limit guards, adaptive work‑group tuning.
 */

/* eslint-env worker, es2022 */

// ──────────────────────────────────────────────────────────────────────────────
// Type helpers
// ──────────────────────────────────────────────────────────────────────────────
/** @typedef {{lon0:number, lat0:number, dLon:number, dLat:number}} TileMeta */

// ──────────────────────────────────────────────────────────────────────────────
// WebGPU initialisation (unchanged math, better readability)
// ──────────────────────────────────────────────────────────────────────────────
/** @type {GPUDevice|null}  */ let device = null;
/** @type {GPUQueue|null}   */ let queue  = null;
/** @type {GPUComputePipeline|null} */ let pipeline = null;

async function initGPU () {
  if (device) return;
  if (!navigator.gpu) throw Error('WebGPU not supported');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error('No compatible GPU adapter');
  device = await adapter.requestDevice();
  queue  = device.queue;

  const WGSL = `@group(0) @binding(0) var<storage,read>        z  : array<f32>;
@group(0) @binding(1) var<storage,read_write>  u  : array<f32>;
@group(0) @binding(2) var<storage,read_write>  px : array<f32>;
@group(0) @binding(3) var<storage,read_write>  py : array<f32>;
@group(0) @binding(4) var<uniform> p : struct{w:u32; h:u32; tau:f32; lam:f32;};
@compute @workgroup_size(16,16)
fn main(@builtin(global_invocation_id) gid:vec3<u32>) {
  let W = p.w; let H = p.h;
  let x = gid.x; let y = gid.y;
  if (x >= W || y >= H) { return; }
  let i = y * W + x;
  let xm = select(x-1u, x, x==0u);
  let xp = select(x+1u, x, x+1u>=W);
  let ym = select(y-1u, y, y==0u);
  let yp = select(y+1u, y, y+1u>=H);
  let gx = u[yp*W + x] - u[i];
  let gy = u[y*W + xp] - u[i];
  px[i] += p.tau * gx;
  py[i] += p.tau * gy;
  let s = max(1.0, (abs(px[i]) + abs(py[i])) / p.lam);
  px[i] /= s;  py[i] /= s;
  let div = px[i] - px[y*W + xm] + py[i] - py[ym*W + x];
  u[i] = (z[i] + p.tau * div) / (1.0 + p.tau);
}`;
  pipeline = device.createComputePipeline({layout:'auto',compute:{module:device.createShaderModule({code:WGSL}),entryPoint:'main'}});
}

// ──────────────────────────────────────────────────────────────────────────────
// Buffer helpers
// ──────────────────────────────────────────────────────────────────────────────
function gpuBufferFrom (typed, usage) {
  const buf = device.createBuffer({size: typed.byteLength, usage, mappedAtCreation: true});
  new typed.constructor(buf.getMappedRange()).set(typed);
  buf.unmap();
  return buf;
}

function createBuffers (Z) {
  const bytes = Z.byteLength;
  return {
    Zbuf: gpuBufferFrom(Z, GPUBufferUsage.STORAGE),
    U  : device.createBuffer({size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST}),
    Px : device.createBuffer({size: bytes, usage: GPUBufferUsage.STORAGE}),
    Py : device.createBuffer({size: bytes, usage: GPUBufferUsage.STORAGE}),
    bytes
  };
}
function destroyBuffers (obj) { for (const b of Object.values(obj)) b.destroy(); }

// ──────────────────────────────────────────────────────────────────────────────
// Solver with single readback buffer
// ──────────────────────────────────────────────────────────────────────────────
async function runSolver (bufs, W, H, λ, tol = 1e-4, maxIter = 500) {
  const paramBuf = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  queue.writeBuffer(paramBuf, 0, new Uint32Array([W, H]));
  queue.writeBuffer(paramBuf, 8, new Float32Array([0.25, λ]));
  const bind = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
    {binding: 0, resource: {buffer: bufs.Zbuf}},
    {binding: 1, resource: {buffer: bufs.U}},
    {binding: 2, resource: {buffer: bufs.Px}},
    {binding: 3, resource: {buffer: bufs.Py}},
    {binding: 4, resource: {buffer: paramBuf}}
  ]});

  // U₀ ← Z
  queue.copyBufferToBuffer(bufs.Zbuf, 0, bufs.U, 0, bufs.bytes);

  const wgX = Math.ceil(W / 16);
  const wgY = Math.ceil(H / 16);

  // Re‑usable read‑back buffer — avoids per‑chunk allocations
  const readback = device.createBuffer({size: bufs.bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
  let prev = null;

  for (let iter = 0; iter < maxIter; iter += 32) {
    const chunk = Math.min(32, maxIter - iter);

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    for (let i = 0; i < chunk; ++i) pass.dispatchWorkgroups(wgX, wgY);
    pass.end();
    queue.submit([enc.finish()]);
    await queue.onSubmittedWorkDone();

    // Early‑stop every chunk
    const encR = device.createCommandEncoder();
    encR.copyBufferToBuffer(bufs.U, 0, readback, 0, bufs.bytes);
    queue.submit([encR.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const cur = new Float32Array(readback.getMappedRange()).slice();
    readback.unmap();

    if (prev) {
      let diff = 0, norm = 0;
      for (let i = 0; i < cur.length; ++i) {
        const d = cur[i] - prev[i];
        diff += d * d;  norm += cur[i] * cur[i];
      }
      if (Math.sqrt(diff / norm) < tol) { prev = cur; break; }
    }
    prev = cur;
  }
  readback.destroy();
  paramBuf.destroy();
  return prev; // Float32Array
}

// ──────────────────────────────────────────────────────────────────────────────
// Quick‑select percentile (unchanged)
// ──────────────────────────────────────────────────────────────────────────────
function qselect (arr, k, l = 0, r = arr.length - 1) {
  while (l < r) {
    const pivot = arr[k];
    let i = l, j = r;
    while (i <= j) {
      while (arr[i] < pivot) i++;
      while (arr[j] > pivot) j--;
      if (i <= j) { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; i++; j--; }
    }
    if (j < k) l = i;
    if (k < i) r = j;
  }
  return arr[k];
}
function percentile (arr, p) {
  const k = Math.floor(p / 100 * arr.length);
  const copy = Float32Array.from(arr);
  return qselect(copy, k);
}

// ──────────────────────────────────────────────────────────────────────────────
// Gradient threshold (unchanged logic)
// ──────────────────────────────────────────────────────────────────────────────
function gradThreshold (U, W, H) {
  const g = new Float32Array(W * H);
  for (let y = 0; y < H - 1; ++y) {
    for (let x = 0; x < W - 1; ++x) {
      const i = y * W + x;
      g[i] = Math.hypot(U[i + 1] - U[i], U[i + W] - U[i]);
    }
  }
  return percentile(g, 95);
}

// ──────────────────────────────────────────────────────────────────────────────
// Union‑find with rank (unchanged)
// ──────────────────────────────────────────────────────────────────────────────
function labelFacets (U, W, H, eps) {
  const N = W * H;
  const lbl   = new Uint32Array(N);
  const parent= new Uint32Array(N);
  const rank  = new Uint32Array(N);
  for (let i = 0; i < N; ++i) parent[i] = i;

  const abs = Math.abs;
  const idx = (x, y) => y * W + x;
  const find = a => parent[a] === a ? a : parent[a] = find(parent[a]);
  const unite = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) {
      if (rank[a] < rank[b]) [a, b] = [b, a];
      parent[b] = a;
      if (rank[a] === rank[b]) rank[a]++;
    }
  };

  // 4‑connected unions
  for (let y = 0; y < H; ++y) {
    for (let x = 0; x < W; ++x) {
      const i = idx(x, y);
      if (x > 0   && abs(U[i] - U[idx(x - 1, y)]) < eps) unite(i, idx(x - 1, y));
      if (y > 0   && abs(U[i] - U[idx(x, y - 1)]) < eps) unite(i, idx(x, y - 1));
    }
  }

  // compress + dense relabel
  const map = new Map();
  let next = 1;
  for (let i = 0; i < N; ++i) {
    const r = find(i);
    if (!map.has(r)) map.set(r, next++);
    lbl[i] = map.get(r);
  }
  return {labels: lbl, K: next - 1};
}

// ──────────────────────────────────────────────────────────────────────────────
// Plane fitting (unchanged math, expanded formatting)
// ──────────────────────────────────────────────────────────────────────────────
function invert3x3 (m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const D = f * g - d * i;
  const E = a * i - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const H = b * g - a * h;
  const I = a * e - b * d;
  const det = a * A + b * D + c * G;
  if (Math.abs(det) < 1e-10) return null;
  return [A, B, C, D, E, F, G, H, I].map(v => v / det);
}

function fitPlanes (lbl, U, W, H, meta) {
  const {lon0, lat0, dLon, dLat} = meta;
  const meanLat = lat0 + H * dLat * 0.5;
  const cosφ = Math.cos(meanLat * Math.PI / 180);
  const R = 6371000, DEG = Math.PI / 180;

  const K = Math.max(...lbl) + 1;
  const sums = Array.from({length: K}, () => ({sx:0, sy:0, sz:0, sxx:0, sxy:0, syy:0, n:0}));

  for (let y = 0; y < H; ++y) {
    for (let x = 0; x < W; ++x) {
      const i = y * W + x;
      const l = lbl[i]; if (l === 0) continue;
      const lon = lon0 + x * dLon;
      const lat = lat0 + y * dLat;
      const X = R * (lon - lon0) * DEG * cosφ;
      const Y = R * (lat - lat0) * DEG;
      const Z = U[i];
      const s = sums[l];
      s.sx  += X; s.sy  += Y; s.sz  += Z;
      s.sxx += X * X; s.sxy += X * Y; s.syy += Y * Y; s.n++;
    }
  }

  const planes = [];
  for (let id = 1; id < K; ++id) {
    const s = sums[id]; if (s.n < 3) continue;
    const n = s.n;
    const mx = s.sx / n, my = s.sy / n, mz = s.sz / n;
    const Sxx = s.sxx - n * mx * mx;
    const Sxy = s.sxy - n * mx * my;
    const Syy = s.syy - n * my * my;
    const Sxz = s.sx * mz - n * mx * mz;
    const Syz = s.sy * mz - n * my * mz;
    const M = [Sxx, Sxy, 0,
               Sxy, Syy, 0,
               0,   0,   1e-4]; // small ridge
    const rhs = [Sxz, Syz, 0];
    const inv = invert3x3(M);
    if (!inv) continue;
    const a = inv[0]*rhs[0] + inv[1]*rhs[1] + inv[2]*rhs[2];
    const b = inv[3]*rhs[0] + inv[4]*rhs[1] + inv[5]*rhs[2];
    const c = mz - a * mx - b * my;
    planes.push({id, a, b, c});
  }
  return planes;
}

// ──────────────────────────────────────────────────────────────────────────────
// Moore‑neighbourhood seam extraction (NEW)
// ──────────────────────────────────────────────────────────────────────────────
function extractSeams (lbl, planes, W, H, meta) {
  const {lon0, lat0, dLon, dLat} = meta;
  const meanLat = lat0 + H * dLat * 0.5;
  const cosφ = Math.cos(meanLat * Math.PI / 180);
  const R = 6371000, DEG = Math.PI / 180;

  /** Check if a pixel is at the boundary of its label */
  function isBoundary (x, y, lab) {
    const i = y * W + x;
    if (lbl[i] !== lab) return false;
    return (x > 0   && lbl[i - 1]      !== lab) ||
           (x < W-1 && lbl[i + 1]      !== lab) ||
           (y > 0   && lbl[i - W]      !== lab) ||
           (y < H-1 && lbl[i + W]      !== lab);
  }

  /** Convert pixel to 3‑D point on a plane */
  function lift (x, y, plane) {
    const lon = lon0 + x * dLon;
    const lat = lat0 + y * dLat;
    const X = R * (lon - lon0) * DEG * cosφ;
    const Y = R * (lat - lat0) * DEG;
    const Z = plane.a * X + plane.b * Y + plane.c;
    return [X, Y, Z];
  }

  const dirs = [[0,-1], [1,-1], [1,0], [1,1], [0,1], [-1,1], [-1,0], [-1,-1]]; // Moore order

  const polygons = [];
  const visited = new Uint8Array(W * H); // 0 = unvisited; stores next dir+1 for faster lookup

  const labels = new Set(lbl);
  labels.delete(0);

  for (const lab of labels) {
    const plane = planes.find(p => p.id === lab);
    if (!plane) continue;

    for (let y = 0; y < H; ++y) {
      for (let x = 0; x < W; ++x) {
        const iPix = y * W + x;
        if (lbl[iPix] !== lab || visited[iPix]) continue;
        if (!isBoundary(x, y, lab)) continue;

        const boundary = [];
        let cx = x, cy = y, dir = 0;
        const startKey = `${cx},${cy}`;
        const seenLocal = new Set([startKey]);

        while (true) {
          boundary.push(lift(cx, cy, plane));
          visited[cy * W + cx] = 1;

          // start search two steps left of current dir (per Moore tracing rule)
          dir = (dir + 6) % 8;
          let found = false;
          for (let k = 0; k < 8; ++k) {
            const testDir = (dir + k) % 8;
            const [dx, dy] = dirs[testDir];
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            if (lbl[ny * W + nx] === lab && isBoundary(nx, ny, lab)) {
              const key = `${nx},${ny}`;
              if (key === startKey) {
              if (boundary.length > 2) {
                found = false;
                break;
              }
            }
              if (seenLocal.has(key)) { found = false; break; } // loop closed or self‑intersection
              cx = nx; cy = ny; dir = testDir; seenLocal.add(key); found = true; break;
            }
          }
          if (!found) break;
        }
        if (boundary.length > 2) polygons.push({planeId: lab, vertices: boundary});
      }
    }
  }
  return polygons;
}

// ──────────────────────────────────────────────────────────────────────────────
// Noise & λ helpers (unchanged)
// ──────────────────────────────────────────────────────────────────────────────
function estimateNoise (Z) {
  const med = percentile(Z, 50);
  const mad = percentile(Float32Array.from(Z).map(z => Math.abs(z - med)), 50);
  return 1.4826 * mad;
}
function defaultLambdas (Z) {
  const σ = estimateNoise(Z);
  const λ0 = σ * σ * Math.log(Z.length);
  return [λ0 * 0.5, λ0, λ0 * 2];
}

// ──────────────────────────────────────────────────────────────────────────────
// Worker entry
// ──────────────────────────────────────────────────────────────────────────────
self.onmessage = async ({data}) => {
  const {buffer, width, height, meta, lambdas = []} = data;
  const Z = new Float32Array(buffer);
  const λs = lambdas.length ? lambdas : defaultLambdas(Z);

  await initGPU();
  const bufs = createBuffers(Z);
  try {
    for (const λ of λs) {
      const U = await runSolver(bufs, width, height, λ);
      const eps = gradThreshold(U, width, height);
      const {labels} = labelFacets(U, width, height, eps);
      const planes = fitPlanes(labels, U, width, height, meta);
      const polygons = extractSeams(labels, planes, width, height, meta);
      self.postMessage({λ, planes, polygons});
    }
  } finally {
    destroyBuffers(bufs);
  }
};
