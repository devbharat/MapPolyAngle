import assert from "node:assert/strict";

import type { FlightParams } from "../domain/types.ts";
import {
  combinePartitionObjectives,
  evaluateRegionOrientation,
  findBestRegionOrientation,
} from "../utils/terrainPartitionObjective.ts";

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
  const z = 14;
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

const tradeoffRing: Ring = [
  [0.297, -0.010],
  [0.303, -0.010],
  [0.303, 0.010],
  [0.297, 0.010],
  [0.297, -0.010],
];

const cameraParams: FlightParams = {
  payloadKind: "camera",
  altitudeAGL: 100,
  frontOverlap: 75,
  sideOverlap: 70,
  cameraKey: "MAP61_17MM",
};

const lidarParams: FlightParams = {
  payloadKind: "lidar",
  altitudeAGL: 80,
  frontOverlap: 0,
  sideOverlap: 50,
  lidarKey: "WINGTRA_LIDAR_XT32M2X",
  speedMps: 16,
  lidarReturnMode: "single",
  mappingFovDeg: 90,
};

function runCameraQualityAndTimeCase() {
  const tile = makeDemTile(256, 256, (lng, lat) => {
    const [, my] = lngLatToMercatorMeters(lng, lat);
    return 1200 + my * 0.0009;
  });

  const scenarioOpts = { tradeoff: 0.9, avgTurnSeconds: 40 };
  const contourAligned = evaluateRegionOrientation(tradeoffRing, [tile] as any, cameraParams, 90, scenarioOpts);
  const fasterCrossSlope = evaluateRegionOrientation(tradeoffRing, [tile] as any, cameraParams, 0, scenarioOpts);
  assert.ok(contourAligned && fasterCrossSlope, "camera test orientations should evaluate");
  assert.ok(
    contourAligned!.quality.normalizedQualityCost < fasterCrossSlope!.quality.normalizedQualityCost,
    "contour-aligned camera direction should have lower quality loss",
  );
  assert.ok(
    contourAligned!.flightTime.totalMissionTimeSec > fasterCrossSlope!.flightTime.totalMissionTimeSec,
    "contour-aligned camera direction should be slower for the tall test polygon",
  );

  const qualityFavored = findBestRegionOrientation(tradeoffRing, [tile] as any, cameraParams, [0, 90], { tradeoff: 0.9, avgTurnSeconds: 40 });
  const timeFavored = findBestRegionOrientation(tradeoffRing, [tile] as any, cameraParams, [0, 90], { tradeoff: 0.15, avgTurnSeconds: 40 });
  assert.ok(qualityFavored && timeFavored, "camera tradeoff search should return a best orientation");
  assert.equal(qualityFavored!.bearingDeg, 90, "quality-heavy tradeoff should prefer contour alignment");
  assert.equal(timeFavored!.bearingDeg, 0, "time-heavy tradeoff should prefer the faster bearing");
}

function runLidarQualityCase() {
  const tile = makeDemTile(256, 256, (lng, lat) => {
    const [, my] = lngLatToMercatorMeters(lng, lat);
    return 1600 + my * 0.0007;
  });

  const contourAligned = evaluateRegionOrientation(tradeoffRing, [tile] as any, lidarParams, 90, { tradeoff: 0.8 });
  const crossSlope = evaluateRegionOrientation(tradeoffRing, [tile] as any, lidarParams, 0, { tradeoff: 0.8 });
  assert.ok(contourAligned && crossSlope, "lidar test orientations should evaluate");
  assert.ok(
    contourAligned!.quality.normalizedQualityCost < crossSlope!.quality.normalizedQualityCost,
    "contour-aligned lidar direction should have lower density loss",
  );
  const lidarSummary = crossSlope!.quality.summary;
  assert.equal(lidarSummary.sensorKind, "lidar");
  assert.ok(
    lidarSummary.meanPredictedDensityPtsM2 > lidarSummary.p10PredictedDensityPtsM2,
    "lidar surrogate should expose a tail-risk density metric",
  );
}

function runPartitionCombinationCase() {
  const tile = makeDemTile(256, 256, (lng, lat) => {
    const [, my] = lngLatToMercatorMeters(lng, lat);
    return 1400 + my * 0.0008;
  });

  const regionA = evaluateRegionOrientation(tradeoffRing, [tile] as any, cameraParams, 90, { tradeoff: 0.5 });
  const shiftedRing: Ring = tradeoffRing.map(([lng, lat]) => [lng + 0.008, lat]) as Ring;
  const regionB = evaluateRegionOrientation(shiftedRing, [tile] as any, cameraParams, 90, { tradeoff: 0.5 });
  assert.ok(regionA && regionB, "partition combination inputs should evaluate");
  const combined = combinePartitionObjectives([regionA!, regionB!], { tradeoff: 0.5, interRegionTransitionSec: 40 });
  assert.equal(combined.regionCount, 2);
  assert.ok(
    combined.totalMissionTimeSec > regionA!.flightTime.totalMissionTimeSec + regionB!.flightTime.totalMissionTimeSec,
    "partition combination should include inter-region transition time",
  );
}

runCameraQualityAndTimeCase();
runLidarQualityCase();
runPartitionCombinationCase();

console.log("terrain_partition_objective.test.ts passed");
