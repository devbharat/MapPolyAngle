/**
 * Standard camera models and spacing calculations for flight planning.
 */

import type { CameraModel } from './types';

// Sony RX1R II camera specifications (canonical definition)
export const SONY_RX1R2: CameraModel = {
  f_m: 0.035,          // 35 mm fixed lens
  sx_m: 4.88e-6,       // 4.88 µm pixel pitch (42.4MP full frame)
  sy_m: 4.88e-6,
  w_px: 7952,          // 7952 x 5304 pixels
  h_px: 5304,
};

/**
 * Calculate the forward spacing between photos based on overlap percentage.
 */
export function forwardSpacing(
  camera: CameraModel, 
  altitudeAGL: number, 
  frontOverlapPct: number
): number {
  // Ground sample distance (GSD)
  const gsd = (camera.sy_m * altitudeAGL) / camera.f_m;
  
  // Photo footprint in the forward direction
  const photoFootprintForward = camera.h_px * gsd;
  
  // Forward spacing accounting for overlap
  const overlapFraction = frontOverlapPct / 100;
  return photoFootprintForward * (1 - overlapFraction);
}

/**
 * Calculate the spacing between flight lines based on side overlap percentage.
 */
export function lineSpacing(
  camera: CameraModel, 
  altitudeAGL: number, 
  sideOverlapPct: number
): number {
  // Ground sample distance (GSD)
  const gsd = (camera.sx_m * altitudeAGL) / camera.f_m;
  
  // Photo footprint in the side direction
  const photoFootprintSide = camera.w_px * gsd;
  
  // Line spacing accounting for overlap
  const overlapFraction = sideOverlapPct / 100;
  return photoFootprintSide * (1 - overlapFraction);
}

/**
 * Calculate Ground Sample Distance (GSD) at given altitude.
 */
export function calculateGSD(camera: CameraModel, altitudeAGL: number): number {
  // Use the larger pixel size for conservative GSD estimate
  const pixelSize = Math.max(camera.sx_m, camera.sy_m);
  return (pixelSize * altitudeAGL) / camera.f_m;
}
