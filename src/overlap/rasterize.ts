// Scanline rasterization of multiple polygons (union fill).
// polygons are arrays of [lng,lat] world coords; convert to tile pixel coords beforehand.
export function rasterizeRingsToMask(
  ringsPx: Array<Array<[number,number]>>, size: number
): Uint8Array {
  const mask = new Uint8Array(size*size);
  const edgesPerRing: Array<Array<[number,number]>> = ringsPx.map(ring => ring.map(p=>p));

  // For each scanline row, compute intersections
  for (let row=0; row<size; row++) {
    const y = row + 0.5;
    const xHits: number[] = [];
    for (const ring of edgesPerRing) {
      const n = ring.length;
      for (let i=0, j=n-1; i<n; j=i++) {
        const [x1,y1] = ring[i];
        const [x2,y2] = ring[j];
        // check if edge crosses y
        const cond = (y1 <= y && y2 > y) || (y2 <= y && y1 > y);
        if (!cond) continue;
        const t = (y - y1) / (y2 - y1);
        const x = x1 + t*(x2 - x1);
        xHits.push(x);
      }
    }
    if (xHits.length === 0) continue;
    xHits.sort((a,b)=>a-b);
    for (let k=0; k+1<xHits.length; k+=2) {
      const xL = Math.ceil(Math.min(xHits[k], xHits[k+1]));
      const xR = Math.floor(Math.max(xHits[k], xHits[k+1]));
      for (let col = xL; col <= xR; col++) {
        if (col>=0 && col<size) mask[row*size + col] = 1;
      }
    }
  }
  return mask;
}
