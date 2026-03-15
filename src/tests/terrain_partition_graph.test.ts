import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { FlightParams } from "../domain/types.ts";
import { buildPartitionFrontier, buildTerrainAtomGraph } from "../utils/terrainPartitionGraph.ts";

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

function pixelToLngLat(
  z: number,
  tx: number,
  ty: number,
  px: number,
  py: number,
  width: number,
): [number, number] {
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

function ringCenter(ring: Ring): [number, number] {
  const pts = ring.slice(0, -1);
  return [
    pts.reduce((sum, point) => sum + point[0], 0) / pts.length,
    pts.reduce((sum, point) => sum + point[1], 0) / pts.length,
  ];
}

function makeDemTileForRing(
  ring: Ring,
  elevationAt: (lng: number, lat: number) => number,
  width = 512,
  height = 512,
): DemTile {
  const z = 12;
  const [centerLng, centerLat] = ringCenter(ring);
  const center = lngLatToTile(centerLng, centerLat, z);
  const data = new Float32Array(width * height);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const [lng, lat] = pixelToLngLat(z, center.x, center.y, px + 0.5, py + 0.5, width);
      data[py * width + px] = elevationAt(lng, lat);
    }
  }

  return { x: center.x, y: center.y, z, width, height, data, format: "dem" };
}

function parseFlightplanAreas(path: string) {
  const obj = JSON.parse(readFileSync(path, "utf8"));
  return (obj.flightPlan?.items ?? [])
    .filter((item: any) => item?.complexItemType === "area" && Array.isArray(item?.polygon))
    .map((item: any) => ({
      bearingDeg: item?.grid?.angle ?? 0,
      ring: (item.polygon as Array<[number, number]>).map(([lat, lng]) => [lng, lat] as [number, number]),
    }));
}

function clusterDistinctBearings(bearings: number[], minSeparationDeg: number) {
  const sorted = [...bearings]
    .map((value) => ((value % 180) + 180) % 180)
    .sort((a, b) => a - b);
  const clusters: number[] = [];
  for (const value of sorted) {
    if (!clusters.some((center) => {
      const delta = Math.abs(center - value);
      return Math.min(delta, 180 - delta) < minSeparationDeg;
    })) {
      clusters.push(value);
    }
  }
  return clusters.length;
}

const cameraParams: FlightParams = {
  payloadKind: "camera",
  altitudeAGL: 100,
  frontOverlap: 75,
  sideOverlap: 70,
  cameraKey: "MAP61_17MM",
};

const lidarParams: FlightParams = {
  payloadKind: "lidar",
  altitudeAGL: 91.4,
  frontOverlap: 0,
  sideOverlap: 50,
  lidarKey: "WINGTRA_LIDAR_XT32M2X",
  speedMps: 18.60516575,
  mappingFovDeg: 90,
  lidarReturnMode: "single",
  pointDensityPtsM2: 54.68,
  maxLidarRangeM: 200,
};

const twoFaceRing: Ring = [
  [0.297, -0.01],
  [0.303, -0.01],
  [0.303, 0.01],
  [0.297, 0.01],
  [0.297, -0.01],
];

function makeTwoFaceTile() {
  return makeDemTileForRing(twoFaceRing, (lng, lat) => {
    const [mx, my] = lngLatToMercatorMeters(lng, lat);
    if (lng < 0.3) return 1200 + my * 0.0011;
    return 1200 + mx * 0.0011;
  }, 256, 256);
}

function makeGradualTransitionTile(ring: Ring) {
  const [cx, cy] = lngLatToMercatorMeters(...ringCenter(ring));
  return makeDemTileForRing(ring, (lng, lat) => {
    const [mx, my] = lngLatToMercatorMeters(lng, lat);
    const dx = (mx - cx) / 1500;
    const dy = (my - cy) / 1500;
    const blend = 0.5 + 0.5 * Math.tanh(dx * 1.8);
    const gx = (1 - blend) * 0.001 + blend * 0.0001;
    const gy = (1 - blend) * 0.0002 + blend * 0.0011;
    return 900 + gx * (mx - cx) + gy * (my - cy) + 35 * Math.sin(dx * 2.4) * Math.cos(dy * 1.8);
  });
}

function makePlanarTile(ring: Ring) {
  return makeDemTileForRing(ring, (lng, lat) => {
    const [mx, my] = lngLatToMercatorMeters(lng, lat);
    return 1000 + 0.0009 * mx + 0.00015 * my;
  });
}

const failingLidarRing: Ring = [
  [-117.58887282090166, 33.535957958166364],
  [-117.58902354766882, 33.53731241639714],
  [-117.58490901189458, 33.54032236242112],
  [-117.58119880935678, 33.53983082273968],
  [-117.56894605977301, 33.53408179249607],
  [-117.5693888593591, 33.53291920142643],
  [-117.570119436345, 33.531910688252296],
  [-117.57219966280749, 33.53076569869722],
  [-117.58093427694874, 33.53093906577154],
  [-117.58666221296369, 33.5323463948704],
  [-117.58940934537188, 33.53306787641907],
  [-117.58887282090166, 33.535957958166364],
];

function makeFailingPolygonTile() {
  const [cx, cy] = lngLatToMercatorMeters(...ringCenter(failingLidarRing));
  return makeDemTileForRing(failingLidarRing, (lng, lat) => {
    const [mx, my] = lngLatToMercatorMeters(lng, lat);
    const dx = (mx - cx) / 1400;
    const dy = (my - cy) / 1400;
    const west = 0.5 + 0.5 * Math.tanh(-(dx + 0.18) * 3.4);
    const east = 0.5 + 0.5 * Math.tanh((dx - 0.2) * 3.0);
    const south = 0.5 + 0.5 * Math.tanh(-(dy + 0.08) * 3.1);
    const center = Math.max(0, 1 - west - east - south * 0.55);
    const a = 0.0012 * (0.85 * dx + 0.2 * dy);
    const b = 0.0013 * (-0.1 * dx + 1.0 * dy);
    const c = 0.0011 * (-1.0 * dx + 0.35 * dy);
    const d = 0.00115 * (0.45 * dx - 0.9 * dy);
    return 1350 + 800 * (west * a + east * b + south * c + center * d) + 35 * Math.sin(dx * 3.2) * Math.cos(dy * 2.3);
  });
}

function makeExampleReferenceTile(singleRing: Ring, handcraftedAreas: Array<{ bearingDeg: number; ring: Ring }>) {
  const areaRefs = handcraftedAreas.map((area) => {
    const centroid = ringCenter(area.ring);
    const [cx, cy] = lngLatToMercatorMeters(...centroid);
    const contourBearing = ((area.bearingDeg % 180) + 180) % 180;
    const aspectDeg = (contourBearing + 90) % 360;
    const aspectRad = (aspectDeg * Math.PI) / 180;
    return {
      cx,
      cy,
      gx: Math.sin(aspectRad),
      gy: Math.cos(aspectRad),
      ring: area.ring,
    };
  });
  const [centerX, centerY] = lngLatToMercatorMeters(...ringCenter(singleRing));

  return makeDemTileForRing(singleRing, (lng, lat) => {
    const [mx, my] = lngLatToMercatorMeters(lng, lat);
    let weightedPotential = 0;
    let totalWeight = 0;
    for (const area of areaRefs) {
      const dx = mx - area.cx;
      const dy = my - area.cy;
      const distSq = dx * dx + dy * dy;
      const sigmaSq = 500 ** 2;
      const insideBoost = pointInRing(lng, lat, area.ring) ? 8 : 0.7;
      const weight = insideBoost * Math.exp(-distSq / (2 * sigmaSq));
      const potential = area.gx * dx + area.gy * dy;
      weightedPotential += potential * weight;
      totalWeight += weight;
    }
    const smoothDx = (mx - centerX) / 1800;
    const smoothDy = (my - centerY) / 1800;
    return 1400 + (totalWeight > 0 ? weightedPotential / totalWeight : 0) * 0.0019 + 18 * Math.sin(smoothDx * 2.4) * Math.cos(smoothDy * 2.0);
  });
}

function pointInRing(lng: number, lat: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function runTwoFaceCase() {
  const tile = makeTwoFaceTile();
  const graph = buildTerrainAtomGraph(twoFaceRing, [tile] as any, {
    gridStepM: 90,
    searchSampleStepM: 55,
    atomDirectionMergeDeg: 12,
    atomBreakThreshold: 6,
    minAtomCells: 2,
    maxInitialAtoms: 8,
  });
  assert.ok(graph.atoms.length >= 2, "two-face terrain should yield multiple atoms");

  const { solutions } = buildPartitionFrontier(twoFaceRing, [tile] as any, cameraParams, {
    gridStepM: 90,
    searchSampleStepM: 55,
    atomDirectionMergeDeg: 12,
    atomBreakThreshold: 6,
    minAtomCells: 2,
    maxInitialAtoms: 10,
  });
  assert.ok(solutions.length >= 1, "two-face terrain should yield at least one practical partition");
  const first = solutions[0];
  assert.ok(first.isFirstPracticalSplit, "coarsest visible solution should be marked as the first practical split");
  assert.equal(first.partition.regionCount, 2, "clear two-face terrain should yield a balanced two-region split");
  assert.ok(first.largestRegionFraction < 0.82, "clear two-face terrain should still avoid an almost-parent-sized dominant region");
}

function runFailingPolygonRegression() {
  const tile = makeFailingPolygonTile();
  const { solutions } = buildPartitionFrontier(failingLidarRing, [tile] as any, lidarParams, {
    gridStepM: 85,
    searchSampleStepM: 50,
    maxInitialAtoms: 28,
    atomDirectionMergeDeg: 12,
    atomBreakThreshold: 7,
  });
  assert.ok(solutions.length >= 1, "captured failing lidar polygon should now produce at least one practical partition");
  const first = solutions.find((solution) => solution.isFirstPracticalSplit) ?? solutions[0];
  assert.ok(first.partition.regionCount >= 2 && first.partition.regionCount <= 4, "first practical split should stay coarse");
  assert.ok(first.largestRegionFraction < 0.82, "first practical split should still avoid collapsing to one giant parent-like region");
  assert.ok(first.meanConvexity > 0.8, "first practical split should preserve reasonably compact, convex-ish regions");
  assert.ok(
    first.regions.every((region) => !(region.convexity < 0.74 && region.compactness > 4.25)),
    "first practical split should avoid dumbbell-like regions that force line overflight across neighboring areas",
  );
}

function runGradualTransitionCase() {
  const ring: Ring = [
    [0.49, -0.018],
    [0.51, -0.018],
    [0.513, 0.018],
    [0.488, 0.018],
    [0.49, -0.018],
  ];
  const tile = makeGradualTransitionTile(ring);
  const { solutions } = buildPartitionFrontier(ring, [tile] as any, cameraParams, {
    gridStepM: 80,
    searchSampleStepM: 50,
    maxInitialAtoms: 24,
  });
  assert.ok(solutions.length >= 1, "gradual-transition terrain should still produce a non-empty hierarchy");
  assert.ok(solutions[0].largestRegionFraction < 0.75, "coarsest practical level should avoid one giant region plus crumbs");
}

function runPlanarSingleFaceCase() {
  const ring: Ring = [
    [0.69, -0.01],
    [0.71, -0.01],
    [0.71, 0.01],
    [0.69, 0.01],
    [0.69, -0.01],
  ];
  const tile = makePlanarTile(ring);
  const { solutions } = buildPartitionFrontier(ring, [tile] as any, cameraParams, {
    gridStepM: 90,
    searchSampleStepM: 55,
    maxInitialAtoms: 12,
  });
  assert.ok(solutions.length === 0 || solutions.every((solution) => solution.partition.regionCount <= 1), "single-face terrain should not force practical multi-region splits");
}

function runExampleReferenceCase() {
  const [singleArea] = parseFlightplanAreas("example/singleArea.flightplan");
  const handcraftedAreas = parseFlightplanAreas("example/handCraftedMultiArea.flightplan");
  assert.ok(singleArea, "single-area reference flightplan should load");
  assert.equal(handcraftedAreas.length, 8, "handcrafted reference should expose eight compact areas");

  const tile = makeExampleReferenceTile(singleArea.ring, handcraftedAreas);
  const { solutions } = buildPartitionFrontier(singleArea.ring, [tile] as any, lidarParams, {
    gridStepM: 75,
    searchSampleStepM: 45,
    maxInitialAtoms: 36,
    atomDirectionMergeDeg: 12,
    atomBreakThreshold: 7,
  });
  assert.ok(solutions.length >= 1, "reference terrain should yield at least one practical compact partition option");
  assert.ok(
    solutions.some((solution) => solution.partition.regionCount === 2),
    "manual planning should preserve a direct two-region option when one exists",
  );
  const fine = solutions[solutions.length - 1];
  assert.ok(fine.partition.regionCount >= 2 && fine.partition.regionCount <= 8, "reference-guided solution should remain a compact multi-area tessellation");
  const distinctFamilies = clusterDistinctBearings(fine.regions.map((region) => region.bearingDeg), 20);
  assert.ok(distinctFamilies >= 2, "reference-guided solution should recover multiple bearing families");
  assert.ok(fine.meanConvexity >= 0.72, "reference-style regions should stay reasonably convex on average");
  assert.ok(fine.regions.every((region) => region.convexity >= 0.65), "returned regions must not become highly non-convex");
  assert.ok(
    fine.regions.every((region) => !(region.convexity < 0.74 && region.compactness > 4.25)),
    "reference-style regions should avoid severe necked shapes with disconnected flight-line fragments",
  );
}

runTwoFaceCase();
runFailingPolygonRegression();
runGradualTransitionCase();
runPlanarSingleFaceCase();
runExampleReferenceCase();

console.log("terrain_partition_graph.test.ts passed");
