/********************************************************************************************************
 * polygon_facet_segmenter.ts                                                    v1.1 (2025‑08‑07)
 * -------------------------------------------------------------------------------------------
 * Clip DEM tiles to a user‑drawn polygon, feed the masked raster into the planar‑segmentation
 * worker (which can optionally return per‑pixel labels), then convert each planar facet that
 * lies inside the polygon into terrain‑orientation metrics.
 *
 * Fixes over v0.1
 *   • Correct Web‑Mercator <‑> pixel maths (π/4 formula) and consistent local equirect frame
 *   • meta.origin = SW corner; per‑pixel dLon/dLat via forward diff
 *   • Inverse projection of facet vertices matches worker's X,Y encoding (uses cosφ)
 *   • Down‑slope aspect = isoBearing + 90° (not +270°)
 *   • Pixel‑accurate samples + maxElevation via worker‑returned labels
 *   • NaN outside polygon, sentinel −9999 avoided
 *   • 30‑s timeout & worker error bubbles
 *   • Polygon clipping with Turf.js for exact intersection geometry
 *******************************************************************************************/

// Safe ESM/CJS import for @turf/intersect
import intersectCjs from '@turf/intersect';
const intersect = (intersectCjs as any).default ?? intersectCjs;

import { polygon as turfPolygon, point as turfPoint } from '@turf/helpers';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';


// --------------------------------  Types  --------------------------------------------------
export type LngLat = [number, number];
export interface Polygon { coordinates: LngLat[]; }
export interface TerrainTile {
  x: number; y: number; z: number;
  width: number; height: number;          // square tiles assumed
  data: Uint8ClampedArray | Float32Array; // Terrain‑RGB or DEM
  format: 'terrain-rgb' | 'dem';
}
export interface TileMeta { lon0:number; lat0:number; dLon:number; dLat:number; }

export interface FacetResult {
  planeId: number;
  polygon: LngLat[];          // facet ring lon/lat
  contourDirDeg: number;      // iso‑altitude direction (from worker)
  aspectDeg: number;          // downhill direction
  slopeDeg: number;
  samples: number;
  maxElevation: number;       // NaN if no samples found
}

// --------------------------------  Constants & helpers  ------------------------------------
const EARTH_RADIUS = 6378137;
const DEG = Math.PI / 180;
const radToDeg = (r:number)=> (r*180/Math.PI + 360)%360;

function pointInPolygon(lon:number, lat:number, ring:LngLat[]):boolean{
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [xi,yi]=ring[i], [xj,yj]=ring[j];
    const intersect=((yi>lat)!==(yj>lat)) &&
      (lon < (xj-xi)*(lat-yi)/(yj-yi+1e-12)+xi);
    if(intersect) inside=!inside;
  }
  return inside;
}

const decodeRGB=(r:number,g:number,b:number)=> -10000 + (r*256*256+g*256+b)*0.1;

function pixelToLngLat(px:number, py:number, z:number, tileSize:number):LngLat{
  const scale=tileSize*2**z;
  const lon=px/scale*360 - 180;
  const lat=radToDeg(2*Math.atan(Math.exp(Math.PI - 2*Math.PI*py/scale)) - Math.PI/2);
  return [lon,lat];
}

// --------------------------------  Full‑DEM builder  ---------------------------------------
function buildFullDEM(poly:Polygon, tiles:TerrainTile[]){
  if(!tiles.length) throw Error('no tiles');
  const {z,width:ts}=tiles[0];
  tiles.forEach(t=>{ if(t.z!==z||t.width!==ts||t.height!==ts) throw Error('mixed zoom/size'); });

  const lngs=poly.coordinates.map(p=>p[0]);
  const lats=poly.coordinates.map(p=>p[1]);
  const minLng=Math.min(...lngs), maxLng=Math.max(...lngs);
  const minLat=Math.min(...lats), maxLat=Math.max(...lats);

  const scale=ts*2**z;
  const minPx=Math.floor((minLng+180)/360*scale);
  const maxPx=Math.ceil ((maxLng+180)/360*scale);
  const yOf=(φ:number)=> (1 - Math.log(Math.tan(Math.PI/4 + φ*DEG/2))/Math.PI)/2*scale;
  const minPy=Math.floor(yOf(maxLat));   // northernmost → smaller y
  const maxPy=Math.ceil (yOf(minLat));   // southernmost → larger y

  const width=maxPx-minPx, height=maxPy-minPy;
  const dem=new Float32Array(width*height);

  // Fill with complete tile data, computing mean only for polygon-interior pixels
  let elevationSum = 0;
  let elevationCount = 0;
  
  // Pre-calculate meta for efficiency
  const [lon0,lat0]=pixelToLngLat(minPx,maxPy,z,ts);
  const [lon1]     =pixelToLngLat(minPx+1,maxPy ,z,ts);
  const [,lat1]    =pixelToLngLat(minPx   ,maxPy-1,z,ts);
  const meta:TileMeta={lon0,lat0,dLon:lon1-lon0,dLat:lat1-lat0};
  
  // First pass: collect finite values inside polygon to compute mean fill value
  for(const t of tiles){
    const gpx0=t.x*ts, gpy0=t.y*ts;
    const data=t.data;
    for(let py=0;py<ts;++py){ const gy=gpy0+py; if(gy<minPy||gy>=maxPy) continue;
      for(let px=0;px<ts;++px){ const gx=gpx0+px; if(gx<minPx||gx>=maxPx) continue;
        const ix=gx-minPx, iy=gy-minPy;
        if(ix<0||ix>=width||iy<0||iy>=height) continue;
        
        // Check if pixel is inside polygon
        const lon = meta.lon0 + ix * meta.dLon;
        const lat = meta.lat0 + iy * meta.dLat;
        const inPoly = pointInPolygon(lon, lat, poly.coordinates);
        
        if (!inPoly) continue; // Only compute mean for interior pixels
        
        let elev:number;
        if(t.format==='dem') elev=(data as Float32Array)[py*ts+px];
        else { const b=(py*ts+px)*4; elev=decodeRGB(data[b],data[b+1],data[b+2]); }
        
        if(Number.isFinite(elev)) {
          elevationSum += elev;
          elevationCount++;
        }
      }
    }
  }
  
  const meanElevation = elevationCount > 0 ? elevationSum / elevationCount : 0;
  console.log(`buildFullDEM: using fill value ${meanElevation.toFixed(1)}m for invalid pixels`);

  // Second pass: fill DEM array
  for(const t of tiles){
    const gpx0=t.x*ts, gpy0=t.y*ts;
    const data=t.data;
    for(let py=0;py<ts;++py){ const gy=gpy0+py; if(gy<minPy||gy>=maxPy) continue;
      for(let px=0;px<ts;++px){ const gx=gpx0+px; if(gx<minPx||gx>=maxPx) continue;
        const ix=gx-minPx, iy=gy-minPy;
        if(ix<0||ix>=width||iy<0||iy>=height) continue;
        
        let elev:number;
        if(t.format==='dem') elev=(data as Float32Array)[py*ts+px];
        else { const b=(py*ts+px)*4; elev=decodeRGB(data[b],data[b+1],data[b+2]); }
        
        // Use finite elevation or mean fill value, but only inside the polygon
        const lon = meta.lon0 + ix * meta.dLon;
        const lat = meta.lat0 + iy * meta.dLat;
        const inPoly = pointInPolygon(lon, lat, poly.coordinates);
        
        dem[iy*width+ix] = inPoly
          ? (Number.isFinite(elev) ? elev : meanElevation)
          : NaN;
      }
    }
  }

  return {dem,width,height,meta,polygon:poly};
}

// --------------------------------  Main async API  -----------------------------------------
export async function segmentPolygonTerrain(
  polygon:Polygon,
  tiles:TerrainTile[],
  workerPath:string,
  λ:'auto'|number|number[]='auto'
):Promise<FacetResult[]>{

  const {dem,width,height,meta,polygon:poly}=buildFullDEM(polygon,tiles);

  return new Promise((resolve,reject)=>{
    const worker=new Worker(workerPath,{type:'module'});
    const timeout=setTimeout(()=>{worker.terminate();reject(Error('worker timeout'));},30000);

    worker.onerror=e=>{clearTimeout(timeout);reject(Error(e.message));};

    worker.onmessage=({data})=>{
      clearTimeout(timeout);
      console.log(`Worker returned ${data.polygons.length} facet polygons`, data);

      const { planes, polygons, labels } = data;
      const lblArr = labels ? new Uint32Array(labels) : null;

      const polyMap=new Map(polygons.map((p:any)=>[p.planeId,p]));
      const facets:FacetResult[]=[];

      const meanLat = meta.lat0 + height*meta.dLat*0.5;
      const cosφ    = Math.cos(meanLat*DEG);

      // Create GeoJSON version of the user polygon for clipping
      const userGeo = turfPolygon([poly.coordinates]);

      planes.forEach((pl:any)=>{
        const polyObj=polyMap.get(pl.id); if(!polyObj) return;
        
        // Convert seam vertices back to lon/lat
        const ringLL:LngLat[]=(polyObj as any).vertices.map(([x,y]:number[])=>{
          const lon=meta.lon0 + x / (EARTH_RADIUS*DEG*cosφ);
          const lat=meta.lat0 + y / (EARTH_RADIUS*DEG);
          return [lon,lat];
        });

        // Ensure closed ring
        if (ringLL.length < 4 || 
            ringLL[0][0] !== ringLL[ringLL.length - 1][0] ||
            ringLL[0][1] !== ringLL[ringLL.length - 1][1]) {
          ringLL.push(ringLL[0]);
        }

        // Create GeoJSON polygon for the seam
        const seamGeo = turfPolygon([ringLL]);

        // Clip against user polygon (Turf v6-v8 canonical API)
        const clipped = intersect(seamGeo as any, userGeo as any);
        if (!clipped) return; // facet fully outside

        // Collect all polygon rings (handle both Polygon and MultiPolygon)
        const clipRings: LngLat[][] = [];
        if (clipped.geometry.type === 'Polygon') {
          clipRings.push(clipped.geometry.coordinates[0] as LngLat[]);
        } else if (clipped.geometry.type === 'MultiPolygon') {
          for (const polygonCoords of clipped.geometry.coordinates) {
            clipRings.push(polygonCoords[0] as LngLat[]);
          }
        } else {
          return; // LineString / Point touch – ignore
        }

        // Process each clipped polygon piece
        for (const ring of clipRings) {
          const turfPoly = turfPolygon([ring]);

          // Count samples only within the clipped polygon bounds using robust point-in-polygon
          let samples=0,maxElev=-Infinity;
          if(lblArr){
            for(let iy=0;iy<height;iy++){
              for(let ix=0;ix<width;ix++){
                const i=iy*width+ix;
                if(lblArr[i]===pl.id && Number.isFinite(dem[i])){
                  // Check if this pixel is within the clipped polygon using robust Turf method
                  const lon=meta.lon0+ix*meta.dLon;
                  const lat=meta.lat0+iy*meta.dLat;
                  if(booleanPointInPolygon(turfPoint([lon, lat]), turfPoly)){
                    samples++; 
                    maxElev=Math.max(maxElev,dem[i]);
                  }
                }
              }
            }
          }

          const slopeDeg=Math.atan(Math.hypot(pl.a,pl.b))*180/Math.PI;
          const aspectDeg=(pl.isoBearing+90)%360; // downhill

          facets.push({planeId:pl.id,polygon:ring,
            contourDirDeg:pl.isoBearing,aspectDeg,slopeDeg,
            samples,maxElevation: samples?maxElev:NaN});
        }
      });

      worker.terminate();
      resolve(facets);
    };

    // Debug: Log DEM statistics before sending to worker
    const finiteDem = Array.from(dem).filter(Number.isFinite);
    const minDem = finiteDem.length ? Math.min(...finiteDem) : NaN;
    const maxDem = finiteDem.length ? Math.max(...finiteDem) : NaN;
    console.log(`DEM stats before worker: finite=${finiteDem.length}/${dem.length}, range=[${minDem}, ${maxDem}]`);

    worker.postMessage({
      buffer: dem.buffer,
      width,height,meta,
      lambdas: Array.isArray(λ)?λ:λ==='auto'?[]:[λ],
      returnLabels: true
    }, [dem.buffer]);
  });
}

// --------------------------------  Convenience wrapper  ------------------------------------
import { planarSegmenterWorkerUrl } from './planarSegmenterUrl';

export function segmentPolygonTerrainAuto(
  polygon: Polygon, 
  tiles: TerrainTile[], 
  λ: 'auto' | number | number[] = 'auto'
) {
  return segmentPolygonTerrain(polygon, tiles, planarSegmenterWorkerUrl, λ);
}
