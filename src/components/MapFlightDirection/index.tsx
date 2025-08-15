/***********************************************************************
 * MapFlightDirection.tsx
 *
 * Main component that orchestrates the map, drawing, and analysis.
 *
 * © 2025 <your-name>. MIT License.
 ***********************************************************************/

import React, { useRef, useState, useCallback, useImperativeHandle } from 'react';
import { Map as MapboxMap, LngLatLike } from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import { MapboxOverlay } from '@deck.gl/mapbox';

import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

import { useMapInitialization } from './hooks/useMapInitialization';
import { usePolygonAnalysis } from './hooks/usePolygonAnalysis';
import { addFlightLinesForPolygon, removeFlightLinesForPolygon } from './utils/mapbox-layers';
import { update3DPathLayer, remove3DPathLayer, update3DCameraPointsLayer, remove3DCameraPointsLayer } from './utils/deckgl-layers';
import { build3DFlightPath } from './utils/geometry';
import { PolygonAnalysisResult } from './types';

interface Props {
  mapboxToken: string;
  center?: LngLatLike;
  zoom?: number;
  terrainZoom?: number;
  sampleStep?: number;
  lineSpacing?: number; // Flight line spacing in meters (default: 100)
  onAnalysisComplete?: (results: PolygonAnalysisResult[]) => void;
  onAnalysisStart?: (polygonId: string) => void;
  onError?: (error: string, polygonId?: string) => void;
}

export const MapFlightDirection = React.forwardRef<
  {
    clearAllDrawings: () => void;
    clearPolygon: (polygonId: string) => void;
    startPolygonDrawing: () => void;
    getPolygonResults: () => PolygonAnalysisResult[];
    getMap: () => MapboxMap | undefined;
    getPolygons: () => [number,number][][];
    getFlightLines: () => Map<string, { flightLines: number[][][]; lineSpacing: number }>;
    getPolygonTiles: () => Map<string, any[]>;
    addCameraPoints: (polygonId: string, positions: [number, number, number][]) => void;
    removeCameraPoints: (polygonId: string) => void;
  },
  Props
>(
  (
    {
      mapboxToken,
      center = [8.54, 47.37],
      zoom = 13,
      terrainZoom = 12,
      sampleStep = 2,
      lineSpacing = 100,
      onAnalysisComplete,
      onAnalysisStart,
      onError,
    },
    ref
  ) => {
    const mapContainer = useRef<HTMLDivElement>(null);
    const mapRef = useRef<MapboxMap>();
    const drawRef = useRef<MapboxDraw>();
    const deckOverlayRef = useRef<MapboxOverlay>();

    const [polygonResults, setPolygonResults] = useState<Map<string, PolygonAnalysisResult>>(new Map());
    const [polygonTiles, setPolygonTiles] = useState<Map<string, any[]>>(new Map());
    const [polygonFlightLines, setPolygonFlightLines] = useState<Map<string, { flightLines: number[][][]; lineSpacing: number }>>(new Map());
    const [deckLayers, setDeckLayers] = useState<any[]>([]);

    const handleAnalysisResult = useCallback(
      (result: PolygonAnalysisResult, tiles: any[]) => {
        console.log('Analysis completed, adding flight lines and 3D paths...', result);
        
        setPolygonResults((prev) => {
          const newResults = new Map(prev);
          newResults.set(result.polygonId, result);
          onAnalysisComplete?.(Array.from(newResults.values()));
          return newResults;
        });

        // Store tiles for this polygon
        setPolygonTiles((prev) => {
          const newTiles = new Map(prev);
          newTiles.set(result.polygonId, tiles);
          return newTiles;
        });

        if (mapRef.current) {
          console.log('Adding flight lines...');
          const flightLinesResult = addFlightLinesForPolygon(
            mapRef.current,
            result.polygonId,
            result.polygon.coordinates,
            result.result.contourDirDeg,
            lineSpacing,
            result.result.fitQuality
          );
          console.log(`Added ${flightLinesResult.flightLines.length} flight lines with ${flightLinesResult.lineSpacing}m spacing`);

          // Store flight lines for access by other components
          setPolygonFlightLines((prev) => {
            const newFlightLines = new Map(prev);
            newFlightLines.set(result.polygonId, flightLinesResult);
            return newFlightLines;
          });

          if (result.result.maxElevation !== undefined && flightLinesResult.flightLines.length > 0 && deckOverlayRef.current) {
            console.log('Building 3D flight path...');
            const path3d = build3DFlightPath(flightLinesResult.flightLines, tiles, flightLinesResult.lineSpacing, 100);
            console.log('3D path built, updating layer...');
            update3DPathLayer(deckOverlayRef.current, result.polygonId, path3d, setDeckLayers);
            console.log('3D layer updated');
          }
        }
      },
      [onAnalysisComplete]
    );

    const memoizedOnAnalysisStart = useCallback((polygonId: string) => {
      onAnalysisStart?.(polygonId);
    }, [onAnalysisStart]);

    const memoizedOnError = useCallback((message: string, polygonId?: string) => {
      onError?.(message, polygonId);
    }, [onError]);

    const { analyzePolygon, cancelAnalysis, cancelAllAnalyses } = usePolygonAnalysis({
      mapboxToken,
      sampleStep,
      onAnalysisStart: memoizedOnAnalysisStart,
      onAnalysisComplete: handleAnalysisResult,
      onError: memoizedOnError,
    });

    const handleDrawCreate = useCallback((e: any) => {
      console.log('Draw create event:', e);
      e.features.forEach((feature: any) => {
        if (feature.geometry.type === 'Polygon') {
          console.log('Starting analysis for polygon:', feature.id);
          analyzePolygon(feature.id, feature);
        }
      });
    }, [analyzePolygon]);

    const handleDrawUpdate = useCallback((e: any) => {
      e.features.forEach((feature: any) => {
        if (feature.geometry.type === 'Polygon') {
          analyzePolygon(feature.id, feature);
        }
      });
    }, [analyzePolygon]);

    const handleDrawDelete = useCallback((e: any) => {
      e.features.forEach((feature: any) => {
        if (feature.geometry.type === 'Polygon') {
          const polygonId = feature.id;
          cancelAnalysis(polygonId);
          if (mapRef.current) {
            removeFlightLinesForPolygon(mapRef.current, polygonId);
          }
          if (deckOverlayRef.current) {
            remove3DPathLayer(deckOverlayRef.current, polygonId, setDeckLayers);
          }
          setPolygonResults((prev) => {
            const newResults = new Map(prev);
            newResults.delete(polygonId);
            onAnalysisComplete?.(Array.from(newResults.values()));
            return newResults;
          });
          setPolygonFlightLines((prev) => {
            const newFlightLines = new Map(prev);
            newFlightLines.delete(polygonId);
            return newFlightLines;
          });
          setPolygonTiles((prev) => {
            const newTiles = new Map(prev);
            newTiles.delete(polygonId);
            return newTiles;
          });
        }
      });
    }, [cancelAnalysis, onAnalysisComplete]);

    const onMapLoad = useCallback(
      (map: MapboxMap, draw: MapboxDraw, overlay: MapboxOverlay) => {
        mapRef.current = map;
        drawRef.current = draw;
        deckOverlayRef.current = overlay;
        map.on('draw.create', handleDrawCreate);
        map.on('draw.update', handleDrawUpdate);
        map.on('draw.delete', handleDrawDelete);
      },
      [handleDrawCreate, handleDrawUpdate, handleDrawDelete]
    );

    useMapInitialization({
      mapboxToken,
      center,
      zoom,
      mapContainer,
      onLoad: onMapLoad,
      onError: memoizedOnError,
    });

    useImperativeHandle(ref, () => ({
      clearAllDrawings: () => {
        if (drawRef.current) {
          drawRef.current.deleteAll();
        }
        if (deckOverlayRef.current) {
          setDeckLayers([]);
          deckOverlayRef.current.setProps({ layers: [] });
        }
        cancelAllAnalyses();
      },
      clearPolygon: (polygonId: string) => {
        if (drawRef.current) {
          drawRef.current.delete(polygonId);
        }
      },
      startPolygonDrawing: () => {
        if (drawRef.current) {
          (drawRef.current as any).changeMode('draw_polygon');
        }
      },
      getPolygonResults: () => Array.from(polygonResults.values()),
      getMap: () => mapRef.current,
      getPolygons: (): [number,number][][] => {
        // Return rings for all drawn polygons (single-ring only)
        const draw = drawRef.current;
        if (!draw) return [];
        const coll = draw.getAll();
        const rings: [number,number][][] = [];
        for (const f of coll.features) {
          if (f.geometry?.type === "Polygon" && Array.isArray(f.geometry.coordinates?.[0])) {
            rings.push(f.geometry.coordinates[0] as [number,number][]);
          }
        }
        return rings;
      },
      getFlightLines: () => polygonFlightLines,
      getPolygonTiles: () => polygonTiles,
      addCameraPoints: (polygonId: string, positions: [number, number, number][]) => {
        if (deckOverlayRef.current) {
          update3DCameraPointsLayer(deckOverlayRef.current, polygonId, positions, setDeckLayers);
        }
      },
      removeCameraPoints: (polygonId: string) => {
        if (deckOverlayRef.current) {
          remove3DCameraPointsLayer(deckOverlayRef.current, polygonId, setDeckLayers);
        }
      },
    }), [polygonResults, polygonFlightLines, polygonTiles, cancelAllAnalyses]);

    return <div ref={mapContainer} style={{ position: 'relative', width: '100%', height: '100%' }} />;
  }
);
