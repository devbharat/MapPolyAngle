/***********************************************************************
 * hooks/usePolygonAnalysis.ts
 *
 * Custom hook to handle the analysis of a single polygon.
 *
 * © 2025 <your-name>. MIT License.
 ***********************************************************************/

import { useRef, useCallback } from 'react';
import {
  segmentPolygonTerrainAuto,
  FacetResult,
  Polygon as AspectPolygon,
  TerrainTile,
} from '@/utils/polygon_facet_segmenter';
import { fetchTilesForPolygon } from '../utils/terrain';
import { calculateOptimalTerrainZoom } from '../utils/geometry';
import { PolygonAnalysisResult } from '../types';

interface UsePolygonAnalysisProps {
  mapboxToken: string;
  sampleStep: number;
  onAnalysisStart?: (polygonId: string) => void;
  onAnalysisComplete?: (result: PolygonAnalysisResult, tiles: TerrainTile[]) => void;
  onError?: (error: string, polygonId?: string) => void;
}

const DEG = Math.PI / 180;
function weightedMeanBearing(facets: FacetResult[]) {
  let sx = 0, sy = 0, totalSamples = 0;
  for (const { samples, contourDirDeg } of facets) {
    if (samples <= 0) continue; // Skip facets with no samples
    const rad = contourDirDeg * DEG;
    sx += samples * Math.sin(rad);
    sy += samples * Math.cos(rad);
    totalSamples += samples;
  }
  
  // Guard against no valid samples
  if (totalSamples === 0) return NaN;
  
  return (Math.atan2(sx, sy) * 180 / Math.PI + 360) % 360;
}
function classifyDominantFit(f: FacetResult[]) {
  const best = f.reduce((m, c) => c.samples > m.samples ? c : m, f[0]);
  // crude proxy – fine‑tune later
  return best.samples > 500 ? 'excellent' : best.samples > 200 ? 'good' : best.samples > 50 ? 'fair' : 'poor';
}

export function usePolygonAnalysis({
  mapboxToken,
  sampleStep,
  onAnalysisStart,
  onAnalysisComplete,
  onError,
}: UsePolygonAnalysisProps) {
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const analyzePolygon = useCallback(
    async (polygonId: string, feature: any) => {
      const existingController = abortControllersRef.current.get(polygonId);
      if (existingController) {
        existingController.abort();
      }

      const controller = new AbortController();
      abortControllersRef.current.set(polygonId, controller);
      const signal = controller.signal;

      const ring = feature.geometry.coordinates[0];
      const polygon: AspectPolygon = { coordinates: ring as [number, number][] };

      try {
        onAnalysisStart?.(polygonId);
        console.log(`Starting analysis for polygon ${polygonId}`);

        const optimalTerrainZoom = calculateOptimalTerrainZoom(polygon);
        console.log(`Using terrain zoom ${optimalTerrainZoom} for polygon ${polygonId}`);
        
        const tiles = await fetchTilesForPolygon(polygon, optimalTerrainZoom, mapboxToken, signal);
        console.log(`Fetched ${tiles.length} tiles for polygon ${polygonId}`);

        if (signal.aborted) return;

        if (!tiles.length) {
          console.warn(`No terrain tiles found for polygon ${polygonId}`);
          onError?.('Terrain tiles not found – polygon outside coverage?', polygonId);
          return;
        }

        console.log(`Running terrain analysis for polygon ${polygonId}...`);
        let facets: FacetResult[];
        try {
          facets = await segmentPolygonTerrainAuto(polygon, tiles, 100);
        } catch (e) {
          console.warn('New segmentation failed, falling back to legacy method:', e);
          
          // Check if the error indicates a complete NaN result from the solver
          const errorMsg = e instanceof Error ? e.message : String(e);
          if (errorMsg.includes('all-NaN result') || errorMsg.includes('no valid gradients')) {
            onError?.('Terrain analysis failed - polygon may be too small or outside valid terrain data', polygonId);
            return;
          }
          
          // Import legacy function only when needed
          const { dominantContourDirectionPlaneFit } = await import('../../../utils/terrainAspectHybrid');
          const legacy = dominantContourDirectionPlaneFit(polygon, tiles, { sampleStep });
          facets = [{
            planeId: 0,
            polygon: polygon.coordinates,
            contourDirDeg: legacy.contourDirDeg,
            aspectDeg: legacy.aspectDeg ?? NaN,
            slopeDeg: legacy.slopeMagnitude ? Math.atan(legacy.slopeMagnitude) * 180 / Math.PI : NaN,
            samples: legacy.samples,
            maxElevation: legacy.maxElevation ?? NaN,
          }];
        }
        
        if (signal.aborted) return;
        if (facets.length === 0) {
          onError?.('Unable to segment terrain – flat or insufficient DEM', polygonId);
          return;
        }
        // pick a weighted dominant direction for legacy code
        const dom = weightedMeanBearing(facets);
        console.log(`Analysis result for polygon ${polygonId}:`, facets);

        if (signal.aborted) return;

        if (!Number.isFinite(dom)) {
          onError?.('Could not determine reliable direction (insufficient data or flat terrain)', polygonId);
          return;
        }

        const polygonResult: PolygonAnalysisResult = {
          polygonId,
          facets,
          contourDirDeg: dom,
          fitQuality: classifyDominantFit(facets),
          polygon,
          terrainZoom: optimalTerrainZoom,
        };

        onAnalysisComplete?.(polygonResult, tiles);
      } catch (error) {
        if (error instanceof Error && (error.message.includes('cancelled') || error.message.includes('aborted'))) {
          return;
        }
        const errorMsg = error instanceof Error ? error.message : 'Analysis failed';
        onError?.(errorMsg, polygonId);
      } finally {
        abortControllersRef.current.delete(polygonId);
      }
    },
    [mapboxToken, sampleStep, onAnalysisStart, onAnalysisComplete, onError]
  );

  const cancelAnalysis = useCallback((polygonId: string) => {
    const controller = abortControllersRef.current.get(polygonId);
    if (controller) {
      controller.abort();
    }
  }, []);

  const cancelAllAnalyses = useCallback(() => {
    abortControllersRef.current.forEach((controller) => controller.abort());
  }, []);

  return { analyzePolygon, cancelAnalysis, cancelAllAnalyses };
}
