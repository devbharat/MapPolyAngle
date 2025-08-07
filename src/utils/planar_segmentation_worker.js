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

  // neighbours (clamped)
  let xm = select(x-1u,x,x==0u), xp = select(x+1u,x,x+1u>=W);
  let ym = select(y-1u,y,y==0u), yp = select(y+1u,y,y+1u>=H);

  // primal/dual update
  let gx = u[yp*W+x] - u[i];
  let gy = u[y*W+xp] - u[i];
  px[i] += p.tau * gx;
  py[i] += p.tau * gy;
  let s  = max(1.0,(abs(px[i])+abs(py[i]))/p.lam);
  px[i] /= s;  py[i] /= s;
  let div = px[i]-px[y*W+xm] + py[i]-py[ym*W+x];
  u[i] = (z[i] + p.tau*div) / (1.0 + p.tau);
}`;
  pipeline = device.createComputePipeline({
    layout:'auto',
    compute:{module:device.createShaderModule({code:WGSL}),entryPoint:'main'}
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
  return {
    Zbuf: gpuBufferFrom(Z, GPUBufferUsage.STORAGE),
    U   : device.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST}),
    Px  : device.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE}),
    Py  : device.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE}),
    bytes
  };
}
function destroyBuffers (obj){ for(const b of Object.values(obj)) b.destroy(); }

// ───────────────── TV solver ─────────────────────────────────────────────────
async function runSolver(bufs,W,H,λ,tol=1e-4,maxIter=500){
  const paramBuf=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  queue.writeBuffer(paramBuf,0,new Uint32Array([W,H]));
  queue.writeBuffer(paramBuf,8,new Float32Array([0.25,λ]));

  const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
    {binding:0,resource:{buffer:bufs.Zbuf}},
    {binding:1,resource:{buffer:bufs.U}},
    {binding:2,resource:{buffer:bufs.Px}},
    {binding:3,resource:{buffer:bufs.Py}},
    {binding:4,resource:{buffer:paramBuf}}
  ]});

  queue.copyBufferToBuffer(bufs.Zbuf,0,bufs.U,0,bufs.bytes); // U₀ = Z

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
function gradThreshold(U,W,H){
  const g=new Float32Array(W*H);
  for(let y=0;y<H-1;++y)for(let x=0;x<W-1;++x){
    const i=y*W+x; g[i]=Math.hypot(U[i+1]-U[i],U[i+W]-U[i]);
  }
  return percentile(g,95);
}

// ───────────────── Union-find labelling ──────────────────────────────────────
function labelFacets(U,W,H,eps){
  const N=W*H,lbl=new Uint32Array(N),parent=new Uint32Array(N),rank=new Uint32Array(N);
  for(let i=0;i<N;++i)parent[i]=i;
  const idx=(x,y)=>y*W+x,abs=Math.abs;
  const find=a=>parent[a]==a?a:parent[a]=find(parent[a]);
  const unite=(a,b)=>{a=find(a);b=find(b); if(a!==b){ if(rank[a]<rank[b])[a,b]=[b,a]; parent[b]=a; if(rank[a]==rank[b])rank[a]++; }};
  for(let y=0;y<H;++y)for(let x=0;x<W;++x){
    const i=idx(x,y);
    if(x>0&&abs(U[i]-U[idx(x-1,y)])<eps)unite(i,idx(x-1,y));
    if(y>0&&abs(U[i]-U[idx(x,y-1)])<eps)unite(i,idx(x,y-1));
  }
  const map=new Map();let next=1;
  for(let i=0;i<N;++i){const r=find(i); if(!map.has(r))map.set(r,next++); lbl[i]=map.get(r);}
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
  const sums=Array.from({length:K},()=>({sx:0,sy:0,sz:0,sxx:0,sxy:0,syy:0,n:0}));
  for(let y=0;y<H;++y)for(let x=0;x<W;++x){
    const i=y*W+x,l=lbl[i]; if(l===0)continue;
    const lon=lon0+x*dLon,lat=lat0+y*dLat;
    const X=R*(lon-lon0)*DEG*cosφ, Y=R*(lat-lat0)*DEG, Z=U[i];
    const s=sums[l]; s.sx+=X; s.sy+=Y; s.sz+=Z; s.sxx+=X*X; s.sxy+=X*Y; s.syy+=Y*Y; s.n++;
  }
  const planes=[];
  for(let id=1;id<K;++id){
    const s=sums[id]; if(s.n<3)continue;
    const n=s.n,mx=s.sx/n,my=s.sy/n,mz=s.sz/n;
    const Sxx=s.sxx-n*mx*mx,Sxy=s.sxy-n*mx*my,Syy=s.syy-n*my*my,
          Sxz=s.sx*mz-n*mx*mz,Syz=s.sy*mz-n*my*mz;
    const M=[Sxx,Sxy,0,Sxy,Syy,0,0,0,1e-4], rhs=[Sxz,Syz,0], inv=invert3(M);
    if(!inv)continue;
    const a=inv[0]*rhs[0]+inv[1]*rhs[1]+inv[2]*rhs[2],
          b=inv[3]*rhs[0]+inv[4]*rhs[1]+inv[5]*rhs[2],
          c=mz - a*mx - b*my;

    // iso-altitude direction in XY
    let isoX=-b, isoY=a; const gNorm=Math.hypot(isoX,isoY);
    if(gNorm>0){ isoX/=gNorm; isoY/=gNorm; }
    const isoBearing=((Math.atan2(isoX,isoY)*180/Math.PI)+360)%360; // 0°=N

    planes.push({id,a,b,c,isoDir:[isoX,isoY],isoBearing});
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
const estimateNoise=Z=>{const med=percentile(Z,50),
  mad=percentile(Float32Array.from(Z).map(z=>Math.abs(z-med)),50); return 1.4826*mad;};
const defaultLambdas=Z=>{const σ=estimateNoise(Z);const λ0=σ*σ*Math.log(Z.length);return[λ0*0.5,λ0,λ0*2];};

// ───────────────── Worker entry ───────────────────────────────────────────────
self.onmessage = async ({ data }) => {
  const { buffer, width, height, meta,
          lambdas = [],
          returnLabels = false        /* NEW */ } = data;

  const Z   = new Float32Array(buffer);
  const λs  = lambdas.length ? lambdas : defaultLambdas(Z);

  await initGPU();
  const bufs = createBuffers(Z);

  try {
    for (const λ of λs) {
      const U        = await runSolver(bufs, width, height, λ);
      const eps      = gradThreshold(U, width, height);
      const { labels } = labelFacets(U, width, height, eps);     // labels is Uint32Array
      const planes   = fitPlanes(labels, U, width, height, meta);
      const polygons = extractSeams(labels, planes, width, height, meta);

      const payload = { λ, planes, polygons };
      if (returnLabels) payload.labels = labels.buffer;          /* NEW */

      /* transfer labels if present */
      const transfers = [ ];
      if (returnLabels) transfers.push(labels.buffer);
      /* U and other big buffers stay inside worker */

      self.postMessage(payload, transfers);
    }
  } finally {
    destroyBuffers(bufs);
  }
};
