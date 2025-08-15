import type { CameraModel, PoseMeters, PolygonLngLat, TileResult } from "./types";
import { lngLatToTile, tileCornersLngLat } from "./mercator";

export async function fetchTerrainRGBA(
  z: number, x: number, y: number, token: string, size = 512, signal?: AbortSignal
): Promise<ImageData> {
  const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}.pngraw?access_token=${token}`;
  const img = await loadImage(url, signal);
  const canvas = document.createElement("canvas");
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const cleanup = () => {
      img.onload = null; img.onerror = null;
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { cleanup(); rej(new DOMException("aborted", "AbortError")); };
    img.onload = () => { cleanup(); res(img); };
    img.onerror = () => { cleanup(); rej(new Error("image load failed")); };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort);
    }
    img.src = url;
  });
}

export function tilesCoveringPolygon(polygon: PolygonLngLat, z: number, pad: number = 0) {
  const lons = polygon.ring.map(p=>p[0]);
  const lats = polygon.ring.map(p=>p[1]);
  const min = { lon: Math.min(...lons), lat: Math.min(...lats) };
  const max = { lon: Math.max(...lons), lat: Math.max(...lats) };
  const tMin = lngLatToTile(min.lon, max.lat, z);
  const tMax = lngLatToTile(max.lon, min.lat, z);
  const tiles: {x:number;y:number}[] = [];
  for (let x=tMin.x - pad; x<=tMax.x + pad; x++) {
    for (let y=tMin.y - pad; y<=tMax.y + pad; y++) tiles.push({x,y});
  }
  return tiles;
}

export function tileCornersForImageSource(z:number,x:number,y:number) {
  return tileCornersLngLat(z,x,y);
}

export class OverlapWorker {
  private worker: Worker;
  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  }
  runTile(args: any) {
    return new Promise<TileResult>((resolve) => {
      const onMsg = (e: MessageEvent<TileResult>) => {
        this.worker.removeEventListener("message", onMsg as any);
        resolve(e.data);
      };
      this.worker.addEventListener("message", onMsg as any, { once: true });
      this.worker.postMessage(args, [args.tile.data.buffer]); // transfer tile RGBA buffer
    });
  }
  terminate() { this.worker.terminate(); }
}
