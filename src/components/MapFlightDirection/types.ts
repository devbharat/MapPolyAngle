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
