import type { CameraModel, FlightParams, TerrainTile } from "@/domain/types";
import {
  DJI_ZENMUSE_P1_24MM,
  ILX_LR1_INSPECT_85MM,
  MAP61_17MM,
  RGB61_24MM,
  SONY_RX1R2,
  calculateGSD,
  forwardSpacingRotated,
  lineSpacingRotated,
} from "@/domain/camera";
import {
  DEFAULT_LIDAR,
  getLidarMappingFovDeg,
  getLidarModel,
  lidarDeliverableDensity,
  lidarLineSpacing,
  lidarSinglePassDensity,
} from "@/domain/lidar";
import {
  destination as geoDestination,
  queryElevationAtPoint,
} from "@/utils/terrainAspectHybrid";

// @ts-ignore Turf typings are inconsistent in this repo.
import * as turf from "@turf/turf";

type Ring = [number, number][];

const CAMERA_REGISTRY: Record<string, CameraModel> = {
  SONY_RX1R2,
  DJI_ZENMUSE_P1_24MM,
  ILX_LR1_INSPECT_85MM,
  MAP61_17MM,
  RGB61_24MM,
};

export type TerrainGuidanceCell = {
  lng: number;
  lat: number;
  x: number;
  y: number;
  areaWeightM2: number;
  preferredBearingDeg: number;
  slopeMagnitude: number;
  breakStrength: number;
  confidence: number;
};

export type TerrainGuidanceField = {
  cells: TerrainGuidanceCell[];
  areaM2: number;
  gridStepM: number;
  dominantPreferredBearingDeg: number | null;
};

export type RegionFlightTimeEstimate = {
  lineSpacingM: number;
  forwardSpacingM: number | null;
  lineCount: number;
  fragmentedLineCount: number;
  fragmentedLineFraction: number;
  interSegmentGapLengthM: number;
  meanInterSegmentGapM: number;
  maxInterSegmentGapM: number;
  overflightTransitFraction: number;
  turnCount: number;
  totalFlightLineLengthM: number;
  meanLineLengthM: number;
  medianLineLengthM: number;
  shortLineFraction: number;
  meanTerrainReliefM: number;
  p90TerrainReliefM: number;
  maxTerrainReliefM: number;
  cruiseSpeedMps: number;
  sweepTimeSec: number;
  turnTimeSec: number;
  overheadTimeSec: number;
  totalMissionTimeSec: number;
};

export type CameraQualitySummary = {
  sensorKind: "camera";
  targetGsdM: number;
  meanPredictedGsdM: number;
  p90PredictedGsdM: number;
  underTargetAreaFraction: number;
};

export type LidarQualitySummary = {
  sensorKind: "lidar";
  targetDensityPtsM2: number;
  nominalSinglePassDensityPtsM2: number;
  meanPredictedDensityPtsM2: number;
  p10PredictedDensityPtsM2: number;
  underTargetAreaFraction: number;
  holeAreaFraction: number;
};

export type RegionQualityEstimate = {
  meanDirectionMismatchDeg: number;
  p90DirectionMismatchDeg: number;
  meanMismatchLoss: number;
  p90MismatchLoss: number;
  weightedBreakStrength: number;
  normalizedQualityCost: number;
  summary: CameraQualitySummary | LidarQualitySummary;
};

export type RegionRegularizationEstimate = {
  areaM2: number;
  convexity: number;
  compactness: number;
  aspectRatio: number;
  crossTrackWidthM: number;
  alongTrackLengthM: number;
  minimumPreferredWidthM: number;
  widthPenalty: number;
  aspectPenalty: number;
  convexityPenalty: number;
  compactnessPenalty: number;
  fragmentedLinePenalty: number;
  interSegmentGapPenalty: number;
  overflightTransitPenalty: number;
  penalty: number;
  isHardInvalid: boolean;
};

export type RegionOrientationObjective = {
  bearingDeg: number;
  tradeoff: number;
  totalCost: number;
  normalizedQualityCost: number;
  normalizedTimeCost: number;
  ring: Ring;
  quality: RegionQualityEstimate;
  flightTime: RegionFlightTimeEstimate;
  regularization: RegionRegularizationEstimate;
  guidance: TerrainGuidanceField;
};

export type PartitionObjective = {
  tradeoff: number;
  regionCount: number;
  totalCost: number;
  normalizedQualityCost: number;
  normalizedTimeCost: number;
  totalMissionTimeSec: number;
  totalRegularizationPenalty: number;
  weightedMeanMismatchDeg: number;
  regions: RegionOrientationObjective[];
};

export type TerrainPartitionTradeoffOptions = {
  tradeoff?: number;
  gridStepM?: number;
  searchSampleStepM?: number;
  minAreaM2?: number;
  maxAspectRatio?: number;
  minConvexity?: number;
  cameraCruiseSpeedMps?: number;
  avgTurnSeconds?: number;
  perRegionOverheadSec?: number;
  interRegionTransitionSec?: number;
  shortLineThresholdFactor?: number;
  minWidthLineSpacingFactor?: number;
};

const DEFAULT_OPTIONS: Required<TerrainPartitionTradeoffOptions> = {
  tradeoff: 0.5,
  gridStepM: 0,
  searchSampleStepM: 0,
  minAreaM2: 4000,
  maxAspectRatio: 10,
  minConvexity: 0.38,
  cameraCruiseSpeedMps: 12,
  avgTurnSeconds: 8,
  perRegionOverheadSec: 25,
  interRegionTransitionSec: 35,
  shortLineThresholdFactor: 5,
  minWidthLineSpacingFactor: 2.5,
};

function degToRad(value: number) {
  return (value * Math.PI) / 180;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function mean(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? 0.5 * (sorted[mid - 1] + sorted[mid]) : sorted[mid];
}

function weightedMean(values: Array<{ value: number; weight: number }>) {
  let sum = 0;
  let total = 0;
  for (const { value, weight } of values) {
    if (!(weight > 0) || !Number.isFinite(value)) continue;
    sum += value * weight;
    total += weight;
  }
  return total > 0 ? sum / total : 0;
}

function weightedQuantile(values: Array<{ value: number; weight: number }>, q: number) {
  const filtered = values
    .filter(({ value, weight }) => Number.isFinite(value) && weight > 0)
    .sort((a, b) => a.value - b.value);
  if (filtered.length === 0) return 0;
  const totalWeight = filtered.reduce((sum, item) => sum + item.weight, 0);
  if (!(totalWeight > 0)) return filtered[filtered.length - 1].value;
  const target = clamp(q, 0, 1) * totalWeight;
  let acc = 0;
  for (const item of filtered) {
    acc += item.weight;
    if (acc >= target) return item.value;
  }
  return filtered[filtered.length - 1].value;
}

function normalizedAxialBearing(value: number) {
  return ((value % 180) + 180) % 180;
}

function axialAngleDeltaDeg(a: number, b: number) {
  const aa = normalizedAxialBearing(a);
  const bb = normalizedAxialBearing(b);
  const delta = Math.abs(aa - bb);
  return Math.min(delta, 180 - delta);
}

function weightedAxialMeanDeg(values: Array<{ angleDeg: number; weight: number }>): number | null {
  let sumSin = 0;
  let sumCos = 0;
  let totalWeight = 0;
  for (const { angleDeg, weight } of values) {
    if (!(weight > 0) || !Number.isFinite(angleDeg)) continue;
    const doubled = degToRad(normalizedAxialBearing(angleDeg) * 2);
    sumSin += Math.sin(doubled) * weight;
    sumCos += Math.cos(doubled) * weight;
    totalWeight += weight;
  }
  if (!(totalWeight > 0)) return null;
  const meanRad = 0.5 * Math.atan2(sumSin, sumCos);
  return normalizedAxialBearing((meanRad * 180) / Math.PI);
}

function normalizeRing(ring: Ring): Ring | null {
  const cleaned = ring.filter(
    (coord): coord is [number, number] =>
      Array.isArray(coord) &&
      coord.length >= 2 &&
      Number.isFinite(coord[0]) &&
      Number.isFinite(coord[1]),
  );
  if (cleaned.length < 3) return null;
  const [firstLng, firstLat] = cleaned[0];
  const [lastLng, lastLat] = cleaned[cleaned.length - 1];
  if (firstLng === lastLng && firstLat === lastLat) return cleaned;
  return [...cleaned, [firstLng, firstLat]];
}

function ringFeature(ring: Ring) {
  return turf.polygon([ring]);
}

function ringAreaM2(ring: Ring) {
  return turf.area(ringFeature(ring));
}

function lngLatToMercatorMeters(lng: number, lat: number): [number, number] {
  const R = 6378137;
  const lambda = degToRad(lng);
  const phi = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  return [R * lambda, R * Math.log(Math.tan(Math.PI / 4 + phi / 2))];
}

function mercatorMetersToLngLat(x: number, y: number): [number, number] {
  const R = 6378137;
  const lng = (x / R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
  return [lng, lat];
}

function haversineDistance(a: [number, number], b: [number, number]) {
  const R = 6371000;
  const phi1 = degToRad(a[1]);
  const phi2 = degToRad(b[1]);
  const dPhi = degToRad(b[1] - a[1]);
  const dLambda = degToRad(b[0] - a[0]);
  const sinPhi = Math.sin(dPhi / 2);
  const sinLambda = Math.sin(dLambda / 2);
  const h = sinPhi * sinPhi + Math.cos(phi1) * Math.cos(phi2) * sinLambda * sinLambda;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function ringPerimeterM(ring: Ring) {
  let total = 0;
  for (let i = 1; i < ring.length; i++) {
    total += haversineDistance(ring[i - 1], ring[i]);
  }
  return total;
}

function pointInPolygon(lng: number, lat: number, ring: Ring) {
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

function projectedExtents(ring: Ring, bearingDeg: number) {
  const coords = ring.slice(0, -1).map(([lng, lat]) => lngLatToMercatorMeters(lng, lat));
  const center = coords.reduce(
    (acc, [x, y]) => [acc[0] + x / coords.length, acc[1] + y / coords.length] as [number, number],
    [0, 0] as [number, number],
  );
  const bearingRad = degToRad(bearingDeg);
  const ux = Math.sin(bearingRad);
  const uy = Math.cos(bearingRad);
  const px = Math.sin(bearingRad + Math.PI / 2);
  const py = Math.cos(bearingRad + Math.PI / 2);
  let alongMin = Number.POSITIVE_INFINITY;
  let alongMax = Number.NEGATIVE_INFINITY;
  let crossMin = Number.POSITIVE_INFINITY;
  let crossMax = Number.NEGATIVE_INFINITY;
  for (const [x, y] of coords) {
    const dx = x - center[0];
    const dy = y - center[1];
    const along = dx * ux + dy * uy;
    const cross = dx * px + dy * py;
    alongMin = Math.min(alongMin, along);
    alongMax = Math.max(alongMax, along);
    crossMin = Math.min(crossMin, cross);
    crossMax = Math.max(crossMax, cross);
  }
  return {
    alongTrackLengthM: Math.max(1, alongMax - alongMin),
    crossTrackWidthM: Math.max(1, crossMax - crossMin),
  };
}

function convexityRatio(ring: Ring, areaM2: number) {
  try {
    const points = turf.featureCollection(ring.slice(0, -1).map(([lng, lat]) => turf.point([lng, lat])));
    const hull = turf.convex(points);
    if (!hull) return 1;
    const hullArea = turf.area(hull);
    if (!(hullArea > 0)) return 1;
    return Math.max(0, Math.min(1, areaM2 / hullArea));
  } catch {
    return 1;
  }
}

function lineSpacingForParams(params: FlightParams) {
  if ((params.payloadKind ?? "camera") === "lidar") {
    const model = getLidarModel(params.lidarKey);
    return lidarLineSpacing(
      params.altitudeAGL,
      params.sideOverlap,
      params.mappingFovDeg ?? getLidarMappingFovDeg(model),
    );
  }
  const camera = params.cameraKey ? CAMERA_REGISTRY[params.cameraKey] || SONY_RX1R2 : SONY_RX1R2;
  const yawOffset = params.cameraYawOffsetDeg ?? 0;
  const rotate90 = Math.round((((yawOffset % 180) + 180) % 180)) === 90;
  return lineSpacingRotated(camera, params.altitudeAGL, params.sideOverlap, rotate90);
}

function forwardSpacingForParams(params: FlightParams) {
  if ((params.payloadKind ?? "camera") === "lidar") return null;
  const camera = params.cameraKey ? CAMERA_REGISTRY[params.cameraKey] || SONY_RX1R2 : SONY_RX1R2;
  const yawOffset = params.cameraYawOffsetDeg ?? 0;
  const rotate90 = Math.round((((yawOffset % 180) + 180) % 180)) === 90;
  return forwardSpacingRotated(camera, params.altitudeAGL, params.frontOverlap, rotate90);
}

function defaultCruiseSpeedMps(params: FlightParams, options: Required<TerrainPartitionTradeoffOptions>) {
  if ((params.payloadKind ?? "camera") === "lidar") {
    return params.speedMps ?? getLidarModel(params.lidarKey).defaultSpeedMps;
  }
  return options.cameraCruiseSpeedMps;
}

export function buildTerrainGuidanceField(
  ring: Ring,
  tiles: TerrainTile[],
  options: TerrainPartitionTradeoffOptions = {},
): TerrainGuidanceField {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const normalized = normalizeRing(ring);
  if (!normalized || tiles.length === 0) {
    return { cells: [], areaM2: 0, gridStepM: 0, dominantPreferredBearingDeg: null };
  }
  const areaM2 = ringAreaM2(normalized);
  const coords = normalized.slice(0, -1).map(([lng, lat]) => lngLatToMercatorMeters(lng, lat));
  const xs = coords.map(([x]) => x);
  const ys = coords.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const gridStepM = opts.gridStepM > 0
    ? opts.gridStepM
    : clamp(Math.sqrt(Math.max(areaM2, 1)) / 18, 50, 160);
  const diffStepM = opts.searchSampleStepM > 0
    ? opts.searchSampleStepM
    : clamp(gridStepM * 0.8, 30, 110);

  const cells: TerrainGuidanceCell[] = [];
  for (let y = minY + gridStepM * 0.5; y <= maxY; y += gridStepM) {
    for (let x = minX + gridStepM * 0.5; x <= maxX; x += gridStepM) {
      const [lng, lat] = mercatorMetersToLngLat(x, y);
      if (!pointInPolygon(lng, lat, normalized)) continue;
      const [eastLng, eastLat] = geoDestination([lng, lat], 90, diffStepM);
      const [westLng, westLat] = geoDestination([lng, lat], 270, diffStepM);
      const [northLng, northLat] = geoDestination([lng, lat], 0, diffStepM);
      const [southLng, southLat] = geoDestination([lng, lat], 180, diffStepM);
      const ze = queryElevationAtPoint(eastLng, eastLat, tiles as any);
      const zw = queryElevationAtPoint(westLng, westLat, tiles as any);
      const zn = queryElevationAtPoint(northLng, northLat, tiles as any);
      const zs = queryElevationAtPoint(southLng, southLat, tiles as any);
      if (![ze, zw, zn, zs].every(Number.isFinite)) continue;
      const gradX = (ze - zw) / (2 * diffStepM);
      const gradY = (zn - zs) / (2 * diffStepM);
      const slopeMagnitude = Math.sqrt(gradX * gradX + gradY * gradY);
      if (!(slopeMagnitude > 1e-5)) continue;
      const aspectRad = (Math.atan2(gradX, gradY) + 2 * Math.PI) % (2 * Math.PI);
      const preferredBearingDeg = ((aspectRad * 180) / Math.PI + 90) % 360;
      cells.push({
        lng,
        lat,
        x,
        y,
        areaWeightM2: gridStepM * gridStepM,
        preferredBearingDeg,
        slopeMagnitude,
        breakStrength: 0,
        confidence: 0,
      });
    }
  }

  const neighborRadiusM = gridStepM * 2.6;
  for (const cell of cells) {
    let weightedDelta = 0;
    let totalWeight = 0;
    for (const neighbor of cells) {
      if (neighbor === cell) continue;
      const dx = neighbor.x - cell.x;
      const dy = neighbor.y - cell.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!(dist > 0) || dist > neighborRadiusM) continue;
      const weight = 1 - dist / neighborRadiusM;
      weightedDelta += axialAngleDeltaDeg(cell.preferredBearingDeg, neighbor.preferredBearingDeg) * weight;
      totalWeight += weight;
    }
    const localDisagreement = totalWeight > 0 ? weightedDelta / totalWeight : 0;
    cell.breakStrength = localDisagreement * clamp(cell.slopeMagnitude / 0.2, 0.3, 1.7);
  }

  for (const cell of cells) {
    const slopeTerm = clamp(cell.slopeMagnitude / 0.12, 0, 1);
    const stabilityTerm = clamp(1 - cell.breakStrength / 40, 0.15, 1);
    cell.confidence = slopeTerm * stabilityTerm;
  }

  const dominantPreferredBearingDeg = weightedAxialMeanDeg(
    cells.map((cell) => ({ angleDeg: cell.preferredBearingDeg, weight: Math.max(1e-6, cell.confidence * cell.areaWeightM2) })),
  );

  return { cells, areaM2, gridStepM, dominantPreferredBearingDeg };
}

function sampleTerrainReliefAlongSegment(
  startPoint: [number, number],
  endPoint: [number, number],
  tiles: TerrainTile[],
  sampleCount = 10,
) {
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i <= sampleCount; i++) {
    const t = i / sampleCount;
    const lng = startPoint[0] + t * (endPoint[0] - startPoint[0]);
    const lat = startPoint[1] + t * (endPoint[1] - startPoint[1]);
    const z = queryElevationAtPoint(lng, lat, tiles as any);
    if (!Number.isFinite(z)) continue;
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return Number.isFinite(minZ) && Number.isFinite(maxZ) ? maxZ - minZ : NaN;
}

function estimateRegionFlightTime(
  ring: Ring,
  bearingDeg: number,
  params: FlightParams,
  tiles: TerrainTile[],
  options: Required<TerrainPartitionTradeoffOptions>,
): RegionFlightTimeEstimate {
  const lineSpacingM = Math.max(1, lineSpacingForParams(params));
  const forwardSpacingM = forwardSpacingForParams(params);
  const lons = ring.map((point) => point[0]);
  const lats = ring.map((point) => point[1]);
  const minLng = Math.min(...lons);
  const maxLng = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const center: [number, number] = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
  const diagonal = haversineDistance([minLng, minLat], [maxLng, maxLat]);
  const perpBearing = (bearingDeg + 90) % 360;
  const numLines = Math.max(1, Math.ceil(diagonal / Math.max(1, lineSpacingM)));
  const lengths: number[] = [];
  const terrainReliefs: number[] = [];
  const interSegmentGaps: number[] = [];
  let fragmentedLineCount = 0;

  for (let i = -numLines; i <= numLines; i++) {
    const distance = i * lineSpacingM;
    const [centerLng, centerLat] = geoDestination(center, perpBearing, distance);
    const extendDistance = diagonal * 0.75;
    const p1 = geoDestination([centerLng, centerLat], bearingDeg, extendDistance);
    const p2 = geoDestination([centerLng, centerLat], (bearingDeg + 180) % 360, extendDistance);

    let currentSegment: [number, number][] = [];
    const completedSegments: Array<[[number, number], [number, number]]> = [];
    let segments = 0;
    const samples = 80;
    for (let sample = 0; sample <= samples; sample++) {
      const t = sample / samples;
      const lng = p2[0] + t * (p1[0] - p2[0]);
      const lat = p2[1] + t * (p1[1] - p2[1]);
      if (pointInPolygon(lng, lat, ring)) {
        currentSegment.push([lng, lat]);
      } else if (currentSegment.length > 0) {
        segments += 1;
        const startPoint = currentSegment[0];
        const endPoint = currentSegment[currentSegment.length - 1];
        completedSegments.push([startPoint, endPoint]);
        lengths.push(haversineDistance(startPoint, endPoint));
        const relief = sampleTerrainReliefAlongSegment(startPoint, endPoint, tiles);
        if (Number.isFinite(relief)) terrainReliefs.push(relief);
        currentSegment = [];
      }
    }
    if (currentSegment.length > 0) {
      segments += 1;
      const startPoint = currentSegment[0];
      const endPoint = currentSegment[currentSegment.length - 1];
      completedSegments.push([startPoint, endPoint]);
      lengths.push(haversineDistance(startPoint, endPoint));
      const relief = sampleTerrainReliefAlongSegment(startPoint, endPoint, tiles);
      if (Number.isFinite(relief)) terrainReliefs.push(relief);
    }
    if (segments > 1) {
      fragmentedLineCount += segments - 1;
      for (let segmentIndex = 1; segmentIndex < completedSegments.length; segmentIndex++) {
        const previous = completedSegments[segmentIndex - 1];
        const current = completedSegments[segmentIndex];
        interSegmentGaps.push(haversineDistance(previous[1], current[0]));
      }
    }
  }

  const shortLineThresholdM = Math.max(80, options.shortLineThresholdFactor * lineSpacingM);
  const lineCount = lengths.length;
  const totalInterSegmentGapLengthM = interSegmentGaps.reduce((sum, value) => sum + value, 0);
  const turnCount = Math.max(0, lineCount - 1) + fragmentedLineCount;
  const totalFlightLineLengthM = lengths.reduce((sum, value) => sum + value, 0);
  const cruiseSpeedMps = defaultCruiseSpeedMps(params, options);
  const effectiveSweepLengthM = totalFlightLineLengthM + totalInterSegmentGapLengthM;
  const sweepTimeSec = cruiseSpeedMps > 0 ? effectiveSweepLengthM / cruiseSpeedMps : 0;
  const turnTimeSec = turnCount * options.avgTurnSeconds + fragmentedLineCount * 4;
  const overheadTimeSec = options.perRegionOverheadSec;

  return {
    lineSpacingM,
    forwardSpacingM,
    lineCount,
    fragmentedLineCount,
    fragmentedLineFraction: lineCount > 0 ? fragmentedLineCount / lineCount : 0,
    interSegmentGapLengthM: totalInterSegmentGapLengthM,
    meanInterSegmentGapM: mean(interSegmentGaps),
    maxInterSegmentGapM: interSegmentGaps.length > 0 ? Math.max(...interSegmentGaps) : 0,
    overflightTransitFraction: (totalFlightLineLengthM + totalInterSegmentGapLengthM) > 0
      ? totalInterSegmentGapLengthM / (totalFlightLineLengthM + totalInterSegmentGapLengthM)
      : 0,
    turnCount,
    totalFlightLineLengthM,
    meanLineLengthM: mean(lengths),
    medianLineLengthM: median(lengths),
    shortLineFraction: lineCount > 0 ? lengths.filter((length) => length < shortLineThresholdM).length / lineCount : 1,
    meanTerrainReliefM: mean(terrainReliefs),
    p90TerrainReliefM: weightedQuantile(terrainReliefs.map((value) => ({ value, weight: 1 })), 0.9),
    maxTerrainReliefM: terrainReliefs.length > 0 ? Math.max(...terrainReliefs) : 0,
    cruiseSpeedMps,
    sweepTimeSec,
    turnTimeSec,
    overheadTimeSec,
    totalMissionTimeSec: sweepTimeSec + turnTimeSec + overheadTimeSec,
  };
}

function evaluateRegularization(
  ring: Ring,
  areaM2: number,
  bearingDeg: number,
  flightTime: RegionFlightTimeEstimate,
  lineSpacingM: number,
  options: Required<TerrainPartitionTradeoffOptions>,
): RegionRegularizationEstimate {
  const { alongTrackLengthM, crossTrackWidthM } = projectedExtents(ring, bearingDeg);
  const aspectRatio = Math.max(alongTrackLengthM, crossTrackWidthM) / Math.max(1, Math.min(alongTrackLengthM, crossTrackWidthM));
  const convexity = convexityRatio(ring, areaM2);
  const perimeterM = ringPerimeterM(ring);
  const compactness = perimeterM > 0 ? (perimeterM * perimeterM) / (4 * Math.PI * Math.max(1, areaM2)) : 1;
  const minimumPreferredWidthM = Math.max(45, options.minWidthLineSpacingFactor * lineSpacingM);
  const widthPenalty = Math.max(0, minimumPreferredWidthM - crossTrackWidthM) / minimumPreferredWidthM;
  const aspectPenalty = Math.max(0, aspectRatio - options.maxAspectRatio) * 0.25;
  const convexityPenalty = Math.max(0, options.minConvexity - convexity) * 4;
  const compactnessPenalty = Math.max(0, compactness - 3) * 0.18;
  const fragmentedLinePenalty = Math.min(2.5, flightTime.fragmentedLineFraction * 3.2 + flightTime.fragmentedLineCount / 8) * 0.65;
  const interSegmentGapPenalty = Math.min(
    3,
    flightTime.interSegmentGapLengthM / Math.max(1, Math.max(perimeterM * 0.55, lineSpacingM * 8)),
  ) * 0.9;
  const overflightTransitPenalty = Math.min(2.5, flightTime.overflightTransitFraction * 5.5) * 0.75;
  const smallAreaPenalty = Math.max(0, options.minAreaM2 - areaM2) / Math.max(1, options.minAreaM2);
  const penalty =
    widthPenalty * 2.5 +
    aspectPenalty +
    convexityPenalty +
    compactnessPenalty +
    fragmentedLinePenalty +
    interSegmentGapPenalty +
    overflightTransitPenalty +
    smallAreaPenalty * 2;
  const isHardInvalid =
    areaM2 < options.minAreaM2 * 0.5 ||
    convexity < options.minConvexity * 0.5 ||
    (convexity < 0.58 && flightTime.overflightTransitFraction > 0.18);
  return {
    areaM2,
    convexity,
    compactness,
    aspectRatio,
    crossTrackWidthM,
    alongTrackLengthM,
    minimumPreferredWidthM,
    widthPenalty,
    aspectPenalty,
    convexityPenalty,
    compactnessPenalty,
    fragmentedLinePenalty,
    interSegmentGapPenalty,
    overflightTransitPenalty,
    penalty,
    isHardInvalid,
  };
}

function evaluateQuality(
  guidance: TerrainGuidanceField,
  bearingDeg: number,
  params: FlightParams,
  flightTime: RegionFlightTimeEstimate,
) : RegionQualityEstimate {
  const weightedMismatches = guidance.cells.map((cell) => {
    const deltaDeg = axialAngleDeltaDeg(cell.preferredBearingDeg, bearingDeg);
    const mismatchLoss = Math.sin(degToRad(deltaDeg)) ** 2 * (0.35 + 0.65 * cell.confidence);
    return {
      cell,
      deltaDeg,
      mismatchLoss,
      metricWeight: Math.max(1e-6, cell.areaWeightM2 * (0.25 + 0.75 * cell.confidence)),
      areaWeight: cell.areaWeightM2,
    };
  });

  const meanDirectionMismatchDeg = weightedMean(weightedMismatches.map((item) => ({ value: item.deltaDeg, weight: item.metricWeight })));
  const p90DirectionMismatchDeg = weightedQuantile(weightedMismatches.map((item) => ({ value: item.deltaDeg, weight: item.metricWeight })), 0.9);
  const meanMismatchLoss = weightedMean(weightedMismatches.map((item) => ({ value: item.mismatchLoss, weight: item.metricWeight })));
  const p90MismatchLoss = weightedQuantile(weightedMismatches.map((item) => ({ value: item.mismatchLoss, weight: item.metricWeight })), 0.9);
  const weightedBreakStrength = weightedMean(weightedMismatches.map((item) => ({ value: item.cell.breakStrength, weight: item.areaWeight })));

  const meanReliefRatio = flightTime.meanTerrainReliefM / Math.max(1, params.altitudeAGL);
  const p90ReliefRatio = flightTime.p90TerrainReliefM / Math.max(1, params.altitudeAGL);
  const maxReliefRatio = flightTime.maxTerrainReliefM / Math.max(1, params.altitudeAGL);

  const underTargetAreaFraction = weightedMismatches
    .filter((item) => item.mismatchLoss > 0.35)
    .reduce((sum, item) => sum + item.areaWeight, 0) /
    Math.max(1, weightedMismatches.reduce((sum, item) => sum + item.areaWeight, 0));

  if ((params.payloadKind ?? "camera") === "lidar") {
    const model = getLidarModel(params.lidarKey);
    const mappingFovDeg = params.mappingFovDeg ?? getLidarMappingFovDeg(model);
    const returnMode = params.lidarReturnMode ?? "single";
    const speedMps = params.speedMps ?? model.defaultSpeedMps;
    const targetDensityPtsM2 = params.pointDensityPtsM2
      ?? lidarDeliverableDensity(model, params.altitudeAGL, params.sideOverlap, speedMps, returnMode, mappingFovDeg);
    const nominalSinglePassDensityPtsM2 = lidarSinglePassDensity(model, params.altitudeAGL, speedMps, returnMode, mappingFovDeg);
    const meanDensityFactor = clamp(1 - 1.15 * meanMismatchLoss - 0.45 * meanReliefRatio, 0, 1.25);
    const p10DensityFactor = clamp(1 - 1.65 * p90MismatchLoss - 0.65 * maxReliefRatio, 0, 1.15);
    const meanPredictedDensityPtsM2 = targetDensityPtsM2 * meanDensityFactor;
    const p10PredictedDensityPtsM2 = targetDensityPtsM2 * p10DensityFactor;
    const holeAreaFraction = weightedMismatches
      .filter((item) => 1 - 1.9 * item.mismatchLoss - 0.75 * maxReliefRatio < 0.1)
      .reduce((sum, item) => sum + item.areaWeight, 0) /
      Math.max(1, weightedMismatches.reduce((sum, item) => sum + item.areaWeight, 0));
    const normalizedQualityCost =
      Math.max(0, 1 - meanPredictedDensityPtsM2 / Math.max(1e-6, targetDensityPtsM2)) +
      1.6 * Math.max(0, 1 - p10PredictedDensityPtsM2 / Math.max(1e-6, targetDensityPtsM2)) +
      1.3 * holeAreaFraction +
      0.9 * underTargetAreaFraction;

    return {
      meanDirectionMismatchDeg,
      p90DirectionMismatchDeg,
      meanMismatchLoss,
      p90MismatchLoss,
      weightedBreakStrength,
      normalizedQualityCost,
      summary: {
        sensorKind: "lidar",
        targetDensityPtsM2,
        nominalSinglePassDensityPtsM2,
        meanPredictedDensityPtsM2,
        p10PredictedDensityPtsM2,
        underTargetAreaFraction,
        holeAreaFraction,
      },
    };
  }

  const camera = params.cameraKey ? CAMERA_REGISTRY[params.cameraKey] || SONY_RX1R2 : SONY_RX1R2;
  const targetGsdM = calculateGSD(camera, params.altitudeAGL);
  const meanPredictedGsdM = targetGsdM * (1 + 1.5 * meanMismatchLoss + 0.55 * meanReliefRatio);
  const p90PredictedGsdM = targetGsdM * (1 + 2.1 * p90MismatchLoss + 0.85 * p90ReliefRatio);
  const normalizedQualityCost =
    Math.max(0, meanPredictedGsdM / Math.max(1e-6, targetGsdM) - 1) +
    1.4 * Math.max(0, p90PredictedGsdM / Math.max(1e-6, targetGsdM) - 1) +
    1.1 * underTargetAreaFraction +
    0.4 * flightTime.shortLineFraction;

  return {
    meanDirectionMismatchDeg,
    p90DirectionMismatchDeg,
    meanMismatchLoss,
    p90MismatchLoss,
    weightedBreakStrength,
    normalizedQualityCost,
    summary: {
      sensorKind: "camera",
      targetGsdM,
      meanPredictedGsdM,
      p90PredictedGsdM,
      underTargetAreaFraction,
    },
  };
}

export function evaluateRegionOrientation(
  ring: Ring,
  tiles: TerrainTile[],
  params: FlightParams,
  bearingDeg: number,
  options: TerrainPartitionTradeoffOptions = {},
): RegionOrientationObjective | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const normalized = normalizeRing(ring);
  if (!normalized) return null;
  const guidance = buildTerrainGuidanceField(normalized, tiles, opts);
  const areaM2 = guidance.areaM2;
  if (!(areaM2 > 0) || guidance.cells.length < 4) return null;
  const flightTime = estimateRegionFlightTime(normalized, bearingDeg, params, tiles, opts);
  const regularization = evaluateRegularization(normalized, areaM2, bearingDeg, flightTime, flightTime.lineSpacingM, opts);
  const quality = evaluateQuality(guidance, bearingDeg, params, flightTime);
  const normalizedTimeCost = flightTime.totalMissionTimeSec / 180;
  const totalCost =
    opts.tradeoff * quality.normalizedQualityCost +
    (1 - opts.tradeoff) * normalizedTimeCost +
    regularization.penalty +
    (regularization.isHardInvalid ? 50 : 0);

  return {
    bearingDeg: normalizedAxialBearing(bearingDeg),
    tradeoff: opts.tradeoff,
    totalCost,
    normalizedQualityCost: quality.normalizedQualityCost,
    normalizedTimeCost,
    ring: normalized,
    quality,
    flightTime,
    regularization,
    guidance,
  };
}

export function rankRegionOrientations(
  ring: Ring,
  tiles: TerrainTile[],
  params: FlightParams,
  candidateBearingsDeg: number[],
  options: TerrainPartitionTradeoffOptions = {},
) {
  const uniqueBearings = [...new Set(candidateBearingsDeg.map((value) => normalizedAxialBearing(value)))];
  return uniqueBearings
    .map((bearingDeg) => evaluateRegionOrientation(ring, tiles, params, bearingDeg, options))
    .filter((value): value is RegionOrientationObjective => value !== null)
    .sort((a, b) => a.totalCost - b.totalCost);
}

export function findBestRegionOrientation(
  ring: Ring,
  tiles: TerrainTile[],
  params: FlightParams,
  candidateBearingsDeg: number[],
  options: TerrainPartitionTradeoffOptions = {},
) {
  return rankRegionOrientations(ring, tiles, params, candidateBearingsDeg, options)[0] ?? null;
}

export function combinePartitionObjectives(
  regionObjectives: RegionOrientationObjective[],
  options: TerrainPartitionTradeoffOptions = {},
): PartitionObjective {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const totalAreaM2 = Math.max(1, regionObjectives.reduce((sum, region) => sum + region.regularization.areaM2, 0));
  const normalizedQualityCost = regionObjectives.reduce(
    (sum, region) => sum + region.normalizedQualityCost * (region.regularization.areaM2 / totalAreaM2),
    0,
  );
  const totalMissionTimeSec =
    regionObjectives.reduce((sum, region) => sum + region.flightTime.totalMissionTimeSec, 0) +
    Math.max(0, regionObjectives.length - 1) * opts.interRegionTransitionSec;
  const normalizedTimeCost = totalMissionTimeSec / 180;
  const totalRegularizationPenalty = regionObjectives.reduce((sum, region) => sum + region.regularization.penalty, 0);
  const weightedMeanMismatchDeg = regionObjectives.reduce(
    (sum, region) => sum + region.quality.meanDirectionMismatchDeg * (region.regularization.areaM2 / totalAreaM2),
    0,
  );

  return {
    tradeoff: opts.tradeoff,
    regionCount: regionObjectives.length,
    totalCost: opts.tradeoff * normalizedQualityCost + (1 - opts.tradeoff) * normalizedTimeCost + totalRegularizationPenalty,
    normalizedQualityCost,
    normalizedTimeCost,
    totalMissionTimeSec,
    totalRegularizationPenalty,
    weightedMeanMismatchDeg,
    regions: regionObjectives,
  };
}
