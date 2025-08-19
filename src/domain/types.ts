/**
 * Shared domain types for the Flight Plan Analyser application.
 * These types are used across components to ensure consistency.
 */

export type LngLat = [number, number];

export interface PolygonRing {
  id: string;          // always defined
  ring: LngLat[];      // closed ring
}

export interface CameraModel {
  f_m: number;         // focal length in meters
  sx_m: number;        // pixel size x in meters
  sy_m: number;        // pixel size y in meters
  w_px: number;        // image width in pixels
  h_px: number;        // image height in pixels
  cx_px?: number;      // principal point x (optional, defaults to w_px/2)
  cy_px?: number;      // principal point y (optional, defaults to h_px/2)
}

export interface FlightParams {
  altitudeAGL: number;  // altitude above ground level in meters
  frontOverlap: number; // front overlap percentage (0–95)
  sideOverlap: number;  // side overlap percentage (0–95)
  cameraKey?: string;   // optional camera identifier (maps to models in domain/camera)
}

export interface TerrainTile {
  z: number;           // zoom level
  x: number;           // tile x coordinate
  y: number;           // tile y coordinate
  width: number;       // tile width in pixels
  height: number;      // tile height in pixels
  data: Uint8ClampedArray; // terrain-rgb data
}

export interface FlightLines {
  lineSpacing: number; // spacing between flight lines in meters
  lines: LngLat[][];   // array of flight lines (each line is an array of LngLat points)
}

export interface PolygonAnalysisResult {
  polygonId: string;
  ring: LngLat[];
  result: {
    contourDirDeg: number;
    aspectDeg: number;
    samples: number;
    maxElevation?: number;
    rSquared?: number;
    rmse?: number;
    slopeMagnitude?: number;
    fitQuality?: 'excellent' | 'good' | 'fair' | 'poor';
  };
  terrainZoom: number;
}
