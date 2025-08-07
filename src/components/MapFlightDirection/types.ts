/***********************************************************************
 * types.ts
 *
 * Type definitions for the MapFlightDirection component.
 *
 * © 2025 <your-name>. MIT License.
 ***********************************************************************/

import { FacetResult } from '@/utils/polygon_facet_segmenter';

/** Enhanced result interface for multiple polygons */
export interface PolygonAnalysisResult {
  polygonId: string;
  facets: FacetResult[];          // NEW
  /** dominant bearing (fallback for old consumers) */
  contourDirDeg: number;
  fitQuality?: 'excellent' | 'good' | 'fair' | 'poor';
  polygon: { coordinates: number[][] };
  terrainZoom: number;
}
