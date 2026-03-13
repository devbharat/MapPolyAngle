import type { LidarModel, LidarReturnMode } from './types';

export const DEFAULT_LIDAR_MAX_RANGE_M = 200;
export const XT32M2X_VERTICAL_ANGLES_DEG = [
  19.5, 18.2, 16.9, 15.6, 14.3, 13.0, 11.7, 10.4,
  9.1, 7.8, 6.5, 5.2, 3.9, 2.6, 1.3, 0.0,
  -1.3, -2.6, -3.9, -5.2, -6.5, -7.8, -9.1, -10.4,
  -11.7, -13.0, -14.3, -15.6, -16.9, -18.2, -19.5, -20.8,
] as const;
export const XT32M2X_SUPPORTED_FRAME_RATES_HZ = [5, 10, 20] as const;
export const XT32M2X_NATIVE_POINT_RATES: Record<LidarReturnMode, number> = {
  single: 640_000,
  dual: 1_280_000,
  triple: 1_920_000,
};

function computeEffectivePointRates(
  nativePointRates: Record<LidarReturnMode, number>,
  mappingHorizontalFovDeg: number,
  nativeHorizontalFovDeg: number
): Record<LidarReturnMode, number> {
  const fovFraction = mappingHorizontalFovDeg / nativeHorizontalFovDeg;
  return {
    single: Math.round(nativePointRates.single * fovFraction),
    dual: Math.round(nativePointRates.dual * fovFraction),
    triple: Math.round(nativePointRates.triple * fovFraction),
  };
}

export function getLidarMappingFovDeg(model: LidarModel, mappingFovDeg?: number): number {
  return mappingFovDeg ?? model.mappingHorizontalFovDeg ?? model.effectiveHorizontalFovDeg;
}

export function getLidarEffectivePointRate(model: LidarModel, returnMode: LidarReturnMode = 'single'): number {
  return model.effectivePointRates[returnMode];
}

export function getLidarNativePointRate(model: LidarModel, returnMode: LidarReturnMode = 'single'): number {
  return model.nativePointRates[returnMode];
}

export const WINGTRA_LIDAR_XT32M2X: LidarModel = {
  key: 'WINGTRA_LIDAR_XT32M2X',
  defaultSpeedMps: 16,
  nativeHorizontalFovDeg: 360,
  mappingHorizontalFovDeg: 90,
  effectiveHorizontalFovDeg: 90,
  verticalFovMinDeg: -20.8,
  verticalFovMaxDeg: 19.5,
  verticalResolutionDeg: 1.3,
  verticalAnglesDeg: [...XT32M2X_VERTICAL_ANGLES_DEG],
  defaultFrameRateHz: 10,
  supportedFrameRatesHz: [...XT32M2X_SUPPORTED_FRAME_RATES_HZ],
  nativePointRates: { ...XT32M2X_NATIVE_POINT_RATES },
  effectivePointRates: computeEffectivePointRates(XT32M2X_NATIVE_POINT_RATES, 90, 360),
  defaultAzimuthSectorCenterDeg: 0,
  boresightYawDeg: 0,
  boresightPitchDeg: 0,
  boresightRollDeg: 0,
  defaultMaxRangeM: DEFAULT_LIDAR_MAX_RANGE_M,
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

export function lidarSwathWidth(altitudeAGL: number, mappingFovDeg: number = DEFAULT_LIDAR.mappingHorizontalFovDeg): number {
  const halfAngleRad = (mappingFovDeg * Math.PI) / 360;
  return 2 * altitudeAGL * Math.tan(halfAngleRad);
}

export function lidarLineSpacing(
  altitudeAGL: number,
  sideOverlapPct: number,
  mappingFovDeg: number = DEFAULT_LIDAR.mappingHorizontalFovDeg
): number {
  const swathWidth = lidarSwathWidth(altitudeAGL, mappingFovDeg);
  return swathWidth * (1 - sideOverlapPct / 100);
}

export function lidarSinglePassDensity(
  model: LidarModel,
  altitudeAGL: number,
  speedMps: number = model.defaultSpeedMps,
  returnMode: LidarReturnMode = 'single',
  mappingFovDeg: number = getLidarMappingFovDeg(model)
): number {
  const resolvedMappingFovDeg = getLidarMappingFovDeg(model, mappingFovDeg);
  const swathWidth = lidarSwathWidth(altitudeAGL, resolvedMappingFovDeg);
  if (!(swathWidth > 0) || !(speedMps > 0)) return 0;
  return getLidarEffectivePointRate(model, returnMode) / (speedMps * swathWidth);
}

export function lidarDeliverableDensity(
  model: LidarModel,
  altitudeAGL: number,
  sideOverlapPct: number,
  speedMps: number = model.defaultSpeedMps,
  returnMode: LidarReturnMode = 'single',
  mappingFovDeg: number = getLidarMappingFovDeg(model)
): number {
  const singlePass = lidarSinglePassDensity(model, altitudeAGL, speedMps, returnMode, mappingFovDeg);
  const factor = 1 - sideOverlapPct / 100;
  if (!(factor > 0)) return 0;
  return singlePass / factor;
}
