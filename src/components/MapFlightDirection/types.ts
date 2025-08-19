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
}
