import type { LidarModel, LidarReturnMode } from './types';

export const DEFAULT_LIDAR_MAX_RANGE_M = 200;

export const WINGTRA_LIDAR_XT32M2X: LidarModel = {
  key: 'WINGTRA_LIDAR_XT32M2X',
  defaultSpeedMps: 16,
  effectiveHorizontalFovDeg: 90,
  effectivePointRates: {
    single: 160_000,
    dual: 320_000,
    triple: 480_000,
  },
  names: ['LIDAR', 'LIDAR_v5', 'Wingtra Lidar', 'Hesai XT32M2X', 'WINGTRA_LIDAR_XT32M2X'],
};

export const DEFAULT_LIDAR = WINGTRA_LIDAR_XT32M2X;

export const LIDAR_REGISTRY: Record<string, LidarModel> = {
  WINGTRA_LIDAR_XT32M2X,
};

export function getLidarModel(key?: string): LidarModel {
  if (key && LIDAR_REGISTRY[key]) return LIDAR_REGISTRY[key];
  return DEFAULT_LIDAR;
}

export function lidarSwathWidth(altitudeAGL: number, mappingFovDeg: number = DEFAULT_LIDAR.effectiveHorizontalFovDeg): number {
  const halfAngleRad = (mappingFovDeg * Math.PI) / 360;
  return 2 * altitudeAGL * Math.tan(halfAngleRad);
}

export function lidarLineSpacing(
  altitudeAGL: number,
  sideOverlapPct: number,
  mappingFovDeg: number = DEFAULT_LIDAR.effectiveHorizontalFovDeg
): number {
  const swathWidth = lidarSwathWidth(altitudeAGL, mappingFovDeg);
  return swathWidth * (1 - sideOverlapPct / 100);
}

export function lidarSinglePassDensity(
  model: LidarModel,
  altitudeAGL: number,
  speedMps: number = model.defaultSpeedMps,
  returnMode: LidarReturnMode = 'single',
  mappingFovDeg: number = model.effectiveHorizontalFovDeg
): number {
  const swathWidth = lidarSwathWidth(altitudeAGL, mappingFovDeg);
  if (!(swathWidth > 0) || !(speedMps > 0)) return 0;
  return model.effectivePointRates[returnMode] / (speedMps * swathWidth);
}

export function lidarDeliverableDensity(
  model: LidarModel,
  altitudeAGL: number,
  sideOverlapPct: number,
  speedMps: number = model.defaultSpeedMps,
  returnMode: LidarReturnMode = 'single',
  mappingFovDeg: number = model.effectiveHorizontalFovDeg
): number {
  const singlePass = lidarSinglePassDensity(model, altitudeAGL, speedMps, returnMode, mappingFovDeg);
  const factor = 1 - sideOverlapPct / 100;
  if (!(factor > 0)) return 0;
  return singlePass / factor;
}
