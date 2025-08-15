export function decodeTerrainRGBToElev(
  data: Uint8ClampedArray, size: number
): Float32Array {
  const out = new Float32Array(size * size);
  for (let i=0, j=0; j<out.length; i+=4, j++) {
    const r = data[i], g = data[i+1], b = data[i+2];
    out[j] = -10000 + (r*256*256 + g*256 + b)*0.1;
  }
  return out;
}
