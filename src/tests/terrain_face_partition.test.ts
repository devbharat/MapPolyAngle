import assert from "node:assert/strict";

import type { FlightParams } from "../domain/types.ts";
import { partitionPolygonByTerrainFaces } from "../utils/terrainFacePartition.ts";

type Ring = [number, number][];

type DemTile = {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  data: Float32Array;
  format: "dem";
};

function pixelToLngLat(z: number, tx: number, ty: number, px: number, py: number, width: number): [number, number] {
  const z2 = 2 ** z;
  const normX = (tx * width + px) / (z2 * width);
  const normY = (ty * width + py) / (z2 * width);
  const lng = normX * 360 - 180;
  const n = Math.PI - 2 * Math.PI * normY;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lng, lat];
}

function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const scale = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * scale);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale,
  );
  return { x, y };
}

function lngLatToMercatorMeters(lng: number, lat: number): [number, number] {
  const R = 6378137;
  const lambda = (lng * Math.PI) / 180;
  const phi = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  return [R * lambda, R * Math.log(Math.tan(Math.PI / 4 + phi / 2))];
}

function makeDemTile(width: number, height: number, elevationAt: (lng: number, lat: number) => number): DemTile {
  const z = 8;
  const center = lngLatToTile(0.3, 0, z);
  const x = center.x;
  const y = center.y;
  const data = new Float32Array(width * height);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const [lng, lat] = pixelToLngLat(z, x, y, px + 0.5, py + 0.5, width);
      data[py * width + px] = elevationAt(lng, lat);
    }
  }

  return { x, y, z, width, height, data, format: "dem" };
}

function polygonAreaLike(ring: Ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum) * 0.5;
}

function centroidLng(ring: Ring) {
  const coords = ring.slice(0, -1);
  return coords.reduce((sum, [lng]) => sum + lng, 0) / Math.max(1, coords.length);
}

const defaultParams: FlightParams = {
  payloadKind: "camera",
  altitudeAGL: 100,
  frontOverlap: 75,
  sideOverlap: 70,
  cameraKey: "SONY_RX1R2",
};

const testRing: Ring = [
  [0.1, -0.15],
  [0.5, -0.15],
  [0.5, 0.15],
  [0.1, 0.15],
  [0.1, -0.15],
];

function runSinglePlaneCase() {
  const tile = makeDemTile(256, 256, (lng, lat) => {
    const [mx, my] = lngLatToMercatorMeters(lng, lat);
    return 1200 + mx * 0.00012 + my * 0.00004;
  });

  const result = partitionPolygonByTerrainFaces(testRing, [tile] as any, defaultParams, {
    candidateAngleStepDeg: 30,
    searchSampleStep: 8,
  });
  assert.equal(result.polygons.length, 1, "single smooth plane should remain a single polygon");
}

function runTwoFaceCase() {
  const tile = makeDemTile(256, 256, (lng, lat) => {
    const [mx, my] = lngLatToMercatorMeters(lng, lat);
    if (lng < 0.3) {
      return 1400 - mx * 0.0012 + my * 0.00002;
    }
    return 1400 + mx * 0.0012 + my * 0.00002;
  });

  const result = partitionPolygonByTerrainFaces(testRing, [tile] as any, defaultParams, {
    candidateAngleStepDeg: 30,
    searchSampleStep: 8,
  });
  assert.ok(result.polygons.length >= 2, "mixed terrain faces should split into multiple polygons");
  assert.ok(result.polygons.length <= 4, "splitter should keep polygon count bounded");
  const parentArea = polygonAreaLike(testRing);
  for (const ring of result.polygons) {
    assert.ok(polygonAreaLike(ring) > parentArea * 0.2, "child polygons should retain meaningful area");
  }
  const centroids = result.polygons.map(centroidLng).sort((a, b) => a - b);
  assert.ok(centroids[0] < 0.3 && centroids[centroids.length - 1] > 0.3, "split should separate the known terrain seam");
}

runSinglePlaneCase();
runTwoFaceCase();

console.log("terrain_face_partition.test.ts passed");
