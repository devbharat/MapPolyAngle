/***********************************************************************
 * types.ts
 *
 * Type definitions for the MapFlightDirection component.
 *
 * © 2025 <your-name>. MIT License.
 ***********************************************************************/

import { Polygon as AspectPolygon, AspectResult } from '../../utils/terrainAspectHybrid';

/** Enhanced result interface for multiple polygons */
export interface PolygonAnalysisResult {
  polygonId: string;
  result: AspectResult;
  polygon: AspectPolygon;
  terrainZoom: number; // Track which zoom level was used
}

/** Per‑polygon flight planning parameters set by the user. */
export interface PolygonParams {
  altitudeAGL: number;   // meters above ground
  frontOverlap: number;  // percent 0–95
  sideOverlap: number;   // percent 0–95
  cameraKey?: string;    // optional camera identifier
  triggerDistanceM?: number; // optional: explicit trigger distance from import
  cameraYawOffsetDeg?: number; // optional: rotate camera about Z (e.g. 90 to swap width/height)
  useCustomBearing?: boolean; // optional: user wants to specify bearing manually
  customBearingDeg?: number;  // bearing degrees CW from North
}
