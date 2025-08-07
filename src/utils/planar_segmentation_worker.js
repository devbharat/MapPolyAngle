/*
 * planar_segmentation_worker.js — v2.5
 * --------------------------------------------------------------------------
 * • WebGPU-accelerated 2-D fused-Lasso (trend-filter) solver
 * • Union-find facet labelling
 * • Least-squares plane fitting  ➜ {a,b,c}
 * • Extra per–facet metadata:
 *     isoDir     — unit vector (metres) along constant-elevation direction
 *     isoBearing — compass degrees CW from North
 * • Moore-neighbourhood contour tracing ➜ 3-D seam polygons
 * --------------------------------------------------------------------------
 * Remaining TODOs: GPU limit guards, adaptive work-group tuning.
 */

/* eslint-env worker, es2022 */

/** @typedef {{lon0:number, lat0:number, dLon:number, dLat:number}} TileMeta */

// ───────────────── Constants ─────────────────────────────────────────────────
const DEG = Math.PI / 180;

// ───────────────── WebGPU initialisation ─────────────────────────────────────
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

  const WGSL = `struct Params {
  size : vec2<u32>,      // (w , h )
  tau  : f32,
  lam  : f32,
};

// Largest finite f32: 0x7f7fffff ≈ 3.4028235 e+38
const FLT_MAX : f32 = 0x1.fffffep+127;

fn is_not_finite(v: f32) -> bool {
  // NaN fails equality; |v| above FLT_MAX covers ±Inf
  return (v != v) || (abs(v) > FLT_MAX);
}

@group(0) @binding(0) var<storage,read>        z  : array<f32>;
@group(0) @binding(1) var<storage,read_write>  u  : array<f32>;
@group(0) @binding(2) var<storage,read_write>  px : array<f32>;
@group(0) @binding(3) var<storage,read_write>  py : array<f32>;
@group(0) @binding(4) var<uniform> p : Params;
@compute @workgroup_size(16,16)
fn main(@builtin(global_invocation_id) gid:vec3<u32>) {
  let W = p.size.x; let H = p.size.y;
  let x = gid.x; let y = gid.y;
  if (x >= W || y >= H) { return; }
  let i = y * W + x;

  // Skip processing if the input is NaN or Inf
  if (is_not_finite(z[i])) { 
    u[i] = z[i]; 
    return; 
  }

  // neighbours (clamped) - fixed select predicates
  let xm = select(x, x-1u, x > 0u);
  let xp = select(x, x+1u, x+1u < W);
  let ym = select(y, y-1u, y > 0u);
  let yp = select(y, y+1u, y+1u < H);

  // safe neighbours - clamp non-finite values to current pixel
  var up = u[yp * W + x];
  if (is_not_finite(up)) { up = u[i]; }

  var right = u[y * W + xp];
  if (is_not_finite(right)) { right = u[i]; }

  // primal/dual update
  let gx = up - u[i];
  let gy = right - u[i];
  px[i] += p.tau * gx;
  py[i] += p.tau * gy;
  let s  = max(1.0,(abs(px[i])+abs(py[i]))/p.lam);
  px[i] /= s;  py[i] /= s;

  // divergence (handle NaN in all dual variables)
  var pxi = px[i];
  if (is_not_finite(pxi)) { pxi = 0.0; }

  var pyi = py[i];
  if (is_not_finite(pyi)) { pyi = 0.0; }

  var pxm = px[y * W + xm];
  if (is_not_finite(pxm)) { pxm = pxi; }

  var pym = py[ym * W + x];
  if (is_not_finite(pym)) { pym = pyi; }

  let div = pxi - pxm + pyi - pym;
  u[i] = (z[i] + p.tau*div) / (1.0 + p.tau);
}`;

  // Create and validate shader module
  const shaderModule = device.createShaderModule({
    code: WGSL,
    label: 'planar-segmentation-compute'
  });
  
  // Check for compilation errors
  const compilationInfo = await shaderModule.getCompilationInfo();
  const errors = compilationInfo.messages.filter(m => m.type === 'error');
  if (errors.length > 0) {
    const errorMsg = 'WGSL compilation failed:\n' + errors.map(m => m.message).join('\n');
    console.error(errorMsg);
    throw new Error(errorMsg);
  }
  
  pipeline = device.createComputePipeline({
    layout:'auto',
    compute:{module: shaderModule, entryPoint:'main'},
    label: 'planar-segmentation-pipeline'
  });
}

// ───────────────── Buffer helpers ────────────────────────────────────────────
function gpuBufferFrom (typed, usage) {
  const buf = device.createBuffer({size:typed.byteLength,usage,mappedAtCreation:true});
  new typed.constructor(buf.getMappedRange()).set(typed); buf.unmap();
  return buf;
}
function createBuffers (Z) {
  const bytes = Z.byteLength;
  
  // Create and zero-fill the dual variable buffers to prevent NaN propagation
  const Px = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Float32Array(Px.getMappedRange()).fill(0);
  Px.unmap();
  
  const Py = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Float32Array(Py.getMappedRange()).fill(0);
  Py.unmap();
  
  return {
    Zbuf: gpuBufferFrom(Z, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
    U   : device.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST}),
    Px,
    Py,
    bytes
  };
}
function destroyBuffers (obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v.destroy === 'function') v.destroy();
  }
}

// Runtime buffer clear that works on old and new WebGPU implementations
async function zeroBuffer(buf) {
  const encoder = device.createCommandEncoder();
  if ('clearBuffer' in encoder) {
    encoder.clearBuffer(buf);
    queue.submit([encoder.finish()]);
  } else {
    // Fallback for older Chrome/Edge (≤122)
    queue.writeBuffer(buf, 0, new Uint8Array(buf.size));
  }
  await queue.onSubmittedWorkDone();
}

// ───────────────── TV solver ─────────────────────────────────────────────────
async function runSolver(bufs,W,H,λ,tol=1e-4,maxIter=500){
  const paramBuf=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  queue.writeBuffer(paramBuf,0,new Uint32Array([W,H]));     // 0-7: size.x, size.y
  queue.writeBuffer(paramBuf,8,new Float32Array([0.25,λ])); // 8-15: tau, lam

  const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
    {binding:0,resource:{buffer:bufs.Zbuf}},
    {binding:1,resource:{buffer:bufs.U}},
    {binding:2,resource:{buffer:bufs.Px}},
    {binding:3,resource:{buffer:bufs.Py}},
    {binding:4,resource:{buffer:paramBuf}}
  ]});

  // U₀ = Z (copy Z into the working buffer U)
  {
    const encInit = device.createCommandEncoder();
    encInit.copyBufferToBuffer(bufs.Zbuf, 0, bufs.U, 0, bufs.bytes);
    queue.submit([encInit.finish()]);
  }

  const wgX=Math.ceil(W/16), wgY=Math.ceil(H/16);
  const readback=device.createBuffer({size:bufs.bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  let prev=null;

  for(let iter=0;iter<maxIter;iter+=32){
    const chunk=Math.min(32,maxIter-iter);
    const enc=device.createCommandEncoder();
    const pass=enc.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0,bind);
    for(let i=0;i<chunk;++i) pass.dispatchWorkgroups(wgX,wgY);
    pass.end(); queue.submit([enc.finish()]);
    await queue.onSubmittedWorkDone();

    // early stop
    const encR=device.createCommandEncoder();
    encR.copyBufferToBuffer(bufs.U,0,readback,0,bufs.bytes);
    queue.submit([encR.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const cur=new Float32Array(readback.getMappedRange()).slice(); readback.unmap();

    if(prev){
      let diff=0,norm=0;
      for(let i=0;i<cur.length;++i){const d=cur[i]-prev[i]; diff+=d*d; norm+=cur[i]*cur[i];}
      if(Math.sqrt(diff/norm)<tol){ prev=cur; break; }
    }
    prev=cur;
  }
  readback.destroy(); paramBuf.destroy();
  return prev;
}

// ───────────────── Utility: percentile (quickselect) ─────────────────────────
function qselect(a,k,l=0,r=a.length-1){
  while(l<r){
    const pivot=a[k]; let i=l,j=r;
    while(i<=j){
      while(a[i]<pivot)i++; while(a[j]>pivot)j--;
      if(i<=j){const t=a[i]; a[i]=a[j]; a[j]=t; i++; j--;}
    }
    if(j<k)l=i; if(k<i)r=j;
  } return a[k];
}
function percentile(arr,p){const k=Math.floor(p/100*arr.length);return qselect(Float32Array.from(arr),k);}

// ───────────────── Gradient-threshold helper ─────────────────────────────────
/**
 * Robust, scale-aware ε: three times the **median** gradient, floored to 5 cm.
 * This keeps ε ≈ 8-20 m at z≈13, instead of the hundreds you observed.
 */
function gradThreshold(U,W,H){
  const grads = [];
  for(let y=0;y<H-1;++y)for(let x=0;x<W-1;++x){
    const i=y*W+x;
    const a=U[i], b=U[i+1], c=U[i+W];
    if(!Number.isFinite(a)||!Number.isFinite(b)||!Number.isFinite(c)) continue;
    grads.push(Math.hypot(b-a,c-a));
  }
  console.log(`gradThreshold: computed ${grads.length} valid gradients from ${W}x${H} grid`);
  if(!grads.length) return 0.05;
  const med = percentile(Float32Array.from(grads),50);
  const eps = Math.max(med*3,0.05);
  console.log(`gradThreshold: median = ${med}, eps = ${eps}`);
  return eps;
}

// ───────────────── Union-find labelling ──────────────────────────────────────
function labelFacets(U,W,H,eps){
  console.log(`labelFacets: starting with eps=${eps} on ${W}x${H} grid`);
  const N=W*H,lbl=new Uint32Array(N),parent=new Uint32Array(N),rank=new Uint32Array(N);
  for(let i=0;i<N;++i)parent[i]=i;
  const idx=(x,y)=>y*W+x,abs=Math.abs;
  const find=a=>parent[a]==a?a:parent[a]=find(parent[a]);
  const unite=(a,b)=>{a=find(a);b=find(b); if(a!==b){ if(rank[a]<rank[b])[a,b]=[b,a]; parent[b]=a; if(rank[a]==rank[b])rank[a]++; }};
  
  let validPixels = 0;
  let connections = 0;
  
  for(let y=0;y<H;++y)for(let x=0;x<W;++x){
    const i=idx(x,y);
    const ui = U[i];
    if(!Number.isFinite(ui)) continue; // Skip NaN pixels
    validPixels++;
    
    if(x>0){
      const left = U[idx(x-1,y)];
      if(Number.isFinite(left) && abs(ui-left)<=eps) {
        unite(i,idx(x-1,y));
        connections++;
      }
    }
    if(y>0){
      const up = U[idx(x,y-1)];
      if(Number.isFinite(up) && abs(ui-up)<=eps) {
        unite(i,idx(x,y-1));
        connections++;
      }
    }
  }
  
  console.log(`labelFacets: processed ${validPixels} valid pixels, made ${connections} connections`);
  
  const map=new Map();let next=1;
  for(let i=0;i<N;++i){
    if(!Number.isFinite(U[i])) { lbl[i] = 0; continue; } // NaN pixels get label 0
    const r=find(i); 
    if(!map.has(r))map.set(r,next++); 
    lbl[i]=map.get(r);
  }
  
  console.log(`labelFacets: created ${next-1} unique labels`);
  return {labels:lbl,K:next-1};
}

// ───────────────── 3×3 inverse (small ridge) ─────────────────────────────────
function invert3(m){
  const [a,b,c,d,e,f,g,h,i]=m;
  const A=e*i-f*h,B=c*h-b*i,C=b*f-c*e,D=f*g-d*i,E=a*i-c*g,F=c*d-a*f,G=d*h-e*g,H=b*g-a*h,I=a*e-b*d;
  const det=a*A+b*D+c*G; if(Math.abs(det)<1e-10)return null;
  return [A,B,C,D,E,F,G,H,I].map(v=>v/det);
}

// ───────────────── Plane fitting (+ iso direction) ───────────────────────────
function fitPlanes(lbl,U,W,H,meta){
  const {lon0,lat0,dLon,dLat}=meta;
  const meanLat=lat0+H*dLat*0.5,cosφ=Math.cos(meanLat*Math.PI/180);
  const R=6371000,DEG=Math.PI/180,K=Math.max(...lbl)+1;
  console.log(`fitPlanes: processing ${K} potential facets`);
  
  const sums=Array.from({length:K},()=>({sx:0,sy:0,sz:0,sxx:0,sxy:0,syy:0,n:0}));
  for(let y=0;y<H;++y)for(let x=0;x<W;++x){
    const i=y*W+x,l=lbl[i]; if(l===0)continue;
    const lon=lon0+x*dLon,lat=lat0+y*dLat;
    const X=R*(lon-lon0)*DEG*cosφ, Y=R*(lat-lat0)*DEG, Z=U[i];
    const s=sums[l]; s.sx+=X; s.sy+=Y; s.sz+=Z; s.sxx+=X*X; s.sxy+=X*Y; s.syy+=Y*Y; s.n++;
  }
  
  // Count facet sizes for summary
  let tooSmall = 0, matrixFailed = 0, succeeded = 0;
  const largeFacets = [];
  
  for(let id=1; id<K; id++) {
    if(sums[id].n > 0 && sums[id].n >= 10) {
      largeFacets.push({id, pixels: sums[id].n});
    }
  }
  
  const planes=[];
  for(let id=1;id<K;++id){
    const s=sums[id]; 
    if(s.n<3) {
      tooSmall++;
      continue;
    }
    const n=s.n,mx=s.sx/n,my=s.sy/n,mz=s.sz/n;
    const Sxx=s.sxx-n*mx*mx,Sxy=s.sxy-n*mx*my,Syy=s.syy-n*my*my,
          Sxz=s.sx*mz-n*mx*mz,Syz=s.sy*mz-n*my*mz;
    const M=[Sxx,Sxy,0,Sxy,Syy,0,0,0,1e-4], rhs=[Sxz,Syz,0], inv=invert3(M);
    if(!inv){
      matrixFailed++;
      continue;
    }
    const a=inv[0]*rhs[0]+inv[1]*rhs[1]+inv[2]*rhs[2],
          b=inv[3]*rhs[0]+inv[4]*rhs[1]+inv[5]*rhs[2],
          c=mz - a*mx - b*my;

    // iso-altitude direction in XY
    let isoX=-b, isoY=a; const gNorm=Math.hypot(isoX,isoY);
    if(gNorm>0){ isoX/=gNorm; isoY/=gNorm; }
    const isoBearing=((Math.atan2(isoX,isoY)*180/Math.PI)+360)%360; // 0°=N

    planes.push({id,a,b,c,isoDir:[isoX,isoY],isoBearing});
    succeeded++;
  }
  
  console.log(`fitPlanes: ${tooSmall} facets too small (<3 pixels), ${matrixFailed} matrix inversions failed, ${succeeded} planes created`);
  if(largeFacets.length > 0) {
    console.log(`fitPlanes: largest facets:`, largeFacets.slice(0, 5));
  }
  
  return planes;
}

// ───────────────── Moore-neighbour seam tracer ───────────────────────────────
function extractSeams(lbl,planes,W,H,meta){
  const {lon0,lat0,dLon,dLat}=meta,meanLat=lat0+H*dLat*0.5,
        cosφ=Math.cos(meanLat*Math.PI/180),R=6371000,DEG=Math.PI/180;
  const isBoundary=(x,y,lab)=>{const i=y*W+x;
    return lbl[i]===lab && ((x>0&&lbl[i-1]!==lab)||(x<W-1&&lbl[i+1]!==lab)||(y>0&&lbl[i-W]!==lab)||(y<H-1&&lbl[i+W]!==lab));};
  const lift=(x,y,pl)=>{const lon=lon0+x*dLon,lat=lat0+y*dLat;
    const X=R*(lon-lon0)*DEG*cosφ, Y=R*(lat-lat0)*DEG, Z=pl.a*X+pl.b*Y+pl.c; return[X,Y,Z];};
  const dirs=[[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
  const visited=new Uint8Array(W*H),polys=[],labels=new Set(lbl); labels.delete(0);
  for(const lab of labels){
    const plane=planes.find(p=>p.id===lab); if(!plane)continue;
    for(let y=0;y<H;++y)for(let x=0;x<W;++x){
      const idx=y*W+x; if(lbl[idx]!==lab||visited[idx]||!isBoundary(x,y,lab))continue;
      const start=`${x},${y}`,seen=new Set([start]),poly=[],stack=[[x,y,0]];
      let [cx,cy,dir]=stack.pop();
      while(true){
        poly.push(lift(cx,cy,plane)); visited[cy*W+cx]=1;
        dir=(dir+6)%8; let moved=false;
        for(let k=0;k<8;++k){
          const d=(dir+k)%8,[dx,dy]=dirs[d],nx=cx+dx,ny=cy+dy;
          if(nx<0||nx>=W||ny<0||ny>=H)continue;
          if(lbl[ny*W+nx]===lab&&isBoundary(nx,ny,lab)){
            const key=`${nx},${ny}`;
            if(key===start&&poly.length>2){moved=false;break;}
            if(seen.has(key)){moved=false;break;}
            seen.add(key); cx=nx; cy=ny; dir=d; moved=true; break;
          }
        }
        if(!moved)break;
      }
      if(poly.length>2)polys.push({planeId:lab,vertices:poly});
    }
  }
  return polys;
}

// ───────────────── Helpers: noise → λ list ───────────────────────────────────
function estimateNoise(Z) {
  // collect only finite values
  const finite = [];
  for (let i = 0; i < Z.length; ++i) {
    const v = Z[i];
    if (Number.isFinite(v)) finite.push(v);
  }
  console.log(`estimateNoise: found ${finite.length} finite values out of ${Z.length} total`);
  if (finite.length < 3) return NaN;           // nothing to work with
  const med = percentile(finite, 50);
  const mad = percentile(finite.map(x => Math.abs(x - med)), 50);
  const result = 1.4826 * mad;
  console.log(`estimateNoise: median=${med}, MAD=${mad}, noise estimate=${result}`);
  return result;
}
// λ₀ = σ² · (metres/pixel)² · log N  (cf. Donoho–Johnstone universal threshold)
function defaultLambdas(Z,px){
  const σ = estimateNoise(Z);
  const λ0 = σ*σ * px*px * Math.log(Z.length);
  console.log(`defaultLambdas: σ=${σ}, px=${px}, λ0=${λ0}`);
  return [λ0*0.25, λ0*0.5, λ0, λ0*2];
}

// ───────────────── Worker entry ───────────────────────────────────────────────
self.onmessage = async ({ data }) => {
  console.log('planar_segmentation_worker.js: received data', data);
  const { buffer, width, height, meta,
          lambdas = [],
          returnLabels = false        /* NEW */ } = data;

  const Z = new Float32Array(buffer);
  console.log(`Worker: DEM array length=${Z.length}, width=${width}, height=${height}`);
  
  // Log DEM statistics
  const finiteCount = Z.filter(Number.isFinite).length;
  const nanCount = Z.length - finiteCount;
  const finiteValues = Z.filter(Number.isFinite);
  const minElev = finiteValues.length ? Math.min(...finiteValues) : NaN;
  const maxElev = finiteValues.length ? Math.max(...finiteValues) : NaN;
  console.log(`Worker: DEM stats - finite: ${finiteCount}, NaN: ${nanCount}, range: [${minElev}, ${maxElev}]`);
  
  /* ── metres / pixel at DEM centre ── */
  const meanLat = meta.lat0 + height*meta.dLat*0.5;
  const cosφ    = Math.cos(meanLat*DEG);
  const pxM     = 6378137 * cosφ * DEG * meta.dLon;    // Web-Mercator east-west scale

  const λs = lambdas.length ? lambdas : defaultLambdas(Z, pxM);
  console.log(`Worker: Lambda values:`, λs);

  await initGPU();
  const bufs = createBuffers(Z);

  try {
    for (let idx = 0; idx < λs.length; idx++) {
      const λ = λs[idx];
      console.log(`Worker: Processing lambda=${λ} (${idx + 1}/${λs.length})`);
      
      // Zero dual buffers only once, then preserve warm-start for subsequent lambdas
      if (idx === 0) {
        // Buffers are already zeroed from creation, no action needed
      } else {
        // For subsequent lambdas, zero dual variables but keep primal state for warm-start
        await zeroBuffer(bufs.Px);
        await zeroBuffer(bufs.Py);
      }
      
      const U        = await runSolver(bufs, width, height, λ);
      console.log(`Worker: Solver returned array length=${U.length}`);
      
      // Log solver output statistics
      const uFiniteCount = U.filter(Number.isFinite).length;
      const uNanCount = U.length - uFiniteCount;
      const uFiniteValues = U.filter(Number.isFinite);
      const uMin = uFiniteValues.length ? Math.min(...uFiniteValues) : NaN;
      const uMax = uFiniteValues.length ? Math.max(...uFiniteValues) : NaN;
      console.log(`Worker: Solver output - finite: ${uFiniteCount}, NaN: ${uNanCount}, range: [${uMin}, ${uMax}]`);
      
      // Sanity check: warn if solver returned mostly NaNs but continue with next lambda
      const finiteRatio = uFiniteCount / U.length;
      if (finiteRatio < 0.05) { // Less than 5% finite values (ice shelves, masked coastlines, etc.)
        console.warn(`λ=${λ}: only ${(finiteRatio * 100).toFixed(2)}% finite - skipping to next lambda`);
        continue; // Try the next lambda instead of throwing
      }
      
      const eps      = gradThreshold(U, width, height);
      console.log(`Worker: Gradient threshold eps=${eps}`);
      
      const { labels, K } = labelFacets(U, width, height, eps);
      console.log(`Worker: labelFacets found ${K} facets`);
      
      // Log label statistics
      const labelCounts = new Map();
      for (let i = 0; i < labels.length; i++) {
        const label = labels[i];
        labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
      }
      console.log(`Worker: Label distribution:`, Object.fromEntries(labelCounts));
      
      const planes   = fitPlanes(labels, U, width, height, meta);
      console.log(`Worker: fitPlanes returned ${planes.length} planes`);
      
      if (planes.length > 0) {
        console.log(`Worker: First few planes:`, planes.slice(0, 3));
      }
      
      const polygons = extractSeams(labels, planes, width, height, meta);
      console.log(`Worker: extractSeams returned ${polygons.length} polygons`);
      
      if (polygons.length > 0) {
        console.log(`Worker: First polygon:`, {
          planeId: polygons[0].planeId,
          vertexCount: polygons[0].vertices.length
        });
      }

      const payload = { λ, planes, polygons };
      if (returnLabels) payload.labels = labels.buffer;          /* NEW */

      /* transfer labels if present */
      const transfers = [ ];
      if (returnLabels) transfers.push(labels.buffer);
      /* U and other big buffers stay inside worker */

      console.log(`Worker: Sending payload with ${planes.length} planes and ${polygons.length} polygons`);
      self.postMessage(payload, transfers);
    }
  } finally {
    destroyBuffers(bufs);
  }
};
