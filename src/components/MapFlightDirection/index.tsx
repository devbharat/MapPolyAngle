/***********************************************************************
 * MapFlightDirection.tsx
 *
 * Main component that orchestrates the map, drawing, and analysis.
 *
 * © 2025 <your-name>. MIT License.
 ***********************************************************************/

import React, { useRef, useState, useCallback, useImperativeHandle, useEffect } from 'react';
import { Map as MapboxMap, LngLatLike } from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import { MapboxOverlay } from '@deck.gl/mapbox';

import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

import { useMapInitialization } from './hooks/useMapInitialization';
import { usePolygonAnalysis } from './hooks/usePolygonAnalysis';
import { addFlightLinesForPolygon, removeFlightLinesForPolygon, addTriggerPointsForPolygon, removeTriggerPointsForPolygon } from './utils/mapbox-layers';
import { update3DPathLayer, remove3DPathLayer, update3DCameraPointsLayer, remove3DCameraPointsLayer } from './utils/deckgl-layers';
import { build3DFlightPath, calculateFlightLineSpacing } from './utils/geometry';
import { PolygonAnalysisResult, PolygonParams } from './types';
import { parseKmlPolygons, calculateKmlBounds } from '@/utils/kml';

/** Default camera identical to the one in OverlapGSDPanel */
const DEFAULT_CAMERA = {
  f_m: 0.035,
  sx_m: 4.88e-6,
  sy_m: 4.88e-6,
  w_px: 7952,
  h_px: 5304
};

interface Props {
  mapboxToken: string;
  center?: LngLatLike;
  zoom?: number;
  terrainZoom?: number;
  sampleStep?: number;

  /** Called after terrain direction is known, but before lines are drawn. */
  onRequestParams?: (polygonId: string, ring: [number, number][]) => void;

  onAnalysisComplete?: (results: PolygonAnalysisResult[]) => void;
  onAnalysisStart?: (polygonId: string) => void;
  onError?: (error: string, polygonId?: string) => void;
  onFlightLinesUpdated?: (changed: string | '__all__') => void;
  onClearGSD?: () => void;
}

export const MapFlightDirection = React.forwardRef<
  {
    clearAllDrawings: () => void;
    clearPolygon: (polygonId: string) => void;
    startPolygonDrawing: () => void;
    getPolygonResults: () => PolygonAnalysisResult[];
    getMap: () => MapboxMap | undefined;
    getPolygons: () => [number,number][][];
    getPolygonsWithIds: () => { id?: string; ring: [number, number][] }[];
    /** Now includes altitudeAGL used for the 3D path. */
    getFlightLines: () => Map<string, { flightLines: number[][][]; lineSpacing: number; altitudeAGL: number }>;
    getPolygonTiles: () => Map<string, any[]>;
    addCameraPoints: (polygonId: string, positions: [number, number, number][]) => void;
    removeCameraPoints: (polygonId: string) => void;
    /** Apply per‑polygon params → draw lines + 3D path and notify downstream. */
    applyPolygonParams: (polygonId: string, params: PolygonParams) => void;
    /** Expose current per‑polygon params map to other panels if needed. */
    getPerPolygonParams: () => Record<string, PolygonParams>;
    /** NEW: open a file picker to import one or more .kml files */
    openKmlFilePicker: () => void;
    /** NEW: programmatic KML import */
    importKmlFromText: (kml: string) => Promise<{ added: number; total: number }>;
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
      onRequestParams,
      onAnalysisComplete,
      onAnalysisStart,
      onError,
      onFlightLinesUpdated,
      onClearGSD,
    },
    ref
  ) => {
    const mapContainer = useRef<HTMLDivElement>(null);
    const mapRef = useRef<MapboxMap>();
    const drawRef = useRef<MapboxDraw>();
    const deckOverlayRef = useRef<MapboxOverlay>();

    // KML import state and refs
    const kmlInputRef = useRef<HTMLInputElement>(null);
    const [isDraggingKml, setIsDraggingKml] = useState(false);

    const [polygonResults, setPolygonResults] = useState<Map<string, PolygonAnalysisResult>>(new Map());
    const [polygonTiles, setPolygonTiles] = useState<Map<string, any[]>>(new Map());
    
    /** Flight lines + spacing + altitude actually used to build 3D path. */
    const [polygonFlightLines, setPolygonFlightLines] = useState<
      Map<string, { flightLines: number[][][]; lineSpacing: number; altitudeAGL: number }>
    >(new Map());

    /** Per‑polygon parameters provided by user via dialog. */
    const [polygonParams, setPolygonParams] = useState<Map<string, PolygonParams>>(new Map());

    const [deckLayers, setDeckLayers] = useState<any[]>([]);

    const handleAnalysisResult = useCallback(
      (result: PolygonAnalysisResult, tiles: any[]) => {
        // Store analysis + tiles regardless of params (we need direction later)
        setPolygonResults((prev) => {
          const next = new Map(prev);
          next.set(result.polygonId, result);
          onAnalysisComplete?.(Array.from(next.values()));
          return next;
        });

        setPolygonTiles((prev) => {
          const next = new Map(prev);
          next.set(result.polygonId, tiles);
          return next;
        });

        // If params exist → we can immediately build lines/path
        const params = polygonParams.get(result.polygonId);
        if (!params) {
          // Ask parent to prompt user for this polygon
          onRequestParams?.(result.polygonId, result.polygon.coordinates);
          return;
        }

        if (mapRef.current) {
          const lineSpacing = calculateFlightLineSpacing(DEFAULT_CAMERA, params.altitudeAGL, params.sideOverlap);

          const lines = addFlightLinesForPolygon(
            mapRef.current,
            result.polygonId,
            result.polygon.coordinates,
            result.result.contourDirDeg,
            lineSpacing,
            result.result.fitQuality
          );

          setPolygonFlightLines((prev) => {
            const next = new Map(prev);
            next.set(result.polygonId, { ...lines, altitudeAGL: params.altitudeAGL });
            return next;
          });

          onFlightLinesUpdated?.(result.polygonId);

          if (deckOverlayRef.current && lines.flightLines.length > 0) {
            const path3d = build3DFlightPath(lines.flightLines, tiles, lines.lineSpacing, params.altitudeAGL);
            update3DPathLayer(deckOverlayRef.current, result.polygonId, path3d, setDeckLayers);
          }
        }
      },
      [onAnalysisComplete, onFlightLinesUpdated, polygonParams, onRequestParams]
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

    // Convert a ring to a Draw feature and trigger analysis.
    const addRingAsDrawFeature = useCallback((ring: [number, number][], name?: string) => {
      const draw = drawRef.current as any;
      if (!draw) return;

      // Mapbox Draw expects Polygon coordinates as an array of rings: [outer, hole1, hole2...]
      const feature = {
        type: 'Feature',
        properties: { name: name || '' },
        geometry: {
          type: 'Polygon',
          coordinates: [ring], // single ring only (outer)
        },
      };

      // draw.add returns the id(s) of the added features
      const id = draw.add(feature);
      const featureId = Array.isArray(id) ? id[0] : id;

      // Analyze immediately (some Draw builds emit draw.create; this is robust either way)
      const f = (draw.get as any)?.(featureId);
      if (f?.geometry?.type === 'Polygon') {
        analyzePolygon(featureId, f);
      }
    }, [analyzePolygon]);

    const importKmlFromText = useCallback(async (kmlText: string) => {
      try {
        const polygons = parseKmlPolygons(kmlText);
        let added = 0;
        
        // Add all polygons to the map
        for (const p of polygons) {
          if (p.ring?.length >= 4) {
            addRingAsDrawFeature(p.ring, p.name);
            added++;
          }
        }
        
        // Pan map to show imported areas
        if (added > 0 && mapRef.current) {
          const bounds = calculateKmlBounds(polygons.filter(p => p.ring?.length >= 4));
          if (bounds) {
            // Add some padding around the bounds
            const padding = 0.001; // roughly 100m at equator
            const paddedBounds: [[number, number], [number, number]] = [
              [bounds.minLng - padding, bounds.minLat - padding],
              [bounds.maxLng + padding, bounds.maxLat + padding]
            ];
            
            // Fit map to bounds with animation
            mapRef.current.fitBounds(paddedBounds, {
              padding: 50, // 50px padding from edges
              duration: 1000, // 1 second animation
              maxZoom: 18 // don't zoom in too much for small areas
            });
          }
          
          // Success feedback
          console.log(`Successfully imported ${added} polygon${added !== 1 ? 's' : ''} from KML`);
        } else if (polygons.length > 0) {
          onError?.("KML contained polygons but none were valid (need at least 4 coordinates)");
        } else {
          onError?.("No valid polygons found in KML file");
        }
        
        return { added, total: polygons.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to parse KML file";
        onError?.(message);
        return { added: 0, total: 0 };
      }
    }, [addRingAsDrawFeature, onError]);

    // Handle <input type="file">
    const handleKmlFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []).filter(f => /\.kml$/i.test(f.name));
      
      if (files.length === 0) {
        onError?.("Please select valid .kml files");
        return;
      }
      
      let totalAdded = 0;
      let totalFiles = files.length;
      
      for (const file of files) {
        try {
          const text = await file.text();
          const result = await importKmlFromText(text);
          totalAdded += result.added;
        } catch (error) {
          onError?.(`Failed to read file ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
      
      if (totalAdded > 0) {
        console.log(`Successfully imported ${totalAdded} polygon${totalAdded !== 1 ? 's' : ''} from ${totalFiles} file${totalFiles !== 1 ? 's' : ''}`);
      }
      
      // reset input so same file can be selected again if needed
      if (kmlInputRef.current) kmlInputRef.current.value = '';
    }, [importKmlFromText, onError]);

    const handleDrawDelete = useCallback((e: any) => {
      e.features.forEach((feature: any) => {
        if (feature.geometry.type === 'Polygon') {
          const polygonId = feature.id;
          cancelAnalysis(polygonId);
          if (mapRef.current) {
            removeFlightLinesForPolygon(mapRef.current, polygonId);
            removeTriggerPointsForPolygon(mapRef.current, polygonId);
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
          setPolygonParams((prev) => {
            const next = new Map(prev);
            next.delete(polygonId);
            return next;
          });
          
          // Clear GSD overlays and camera positions
          onClearGSD?.();
        }
      });
    }, [cancelAnalysis, onAnalysisComplete, onClearGSD]);

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

    // Support drag & drop directly onto the map container
    useEffect(() => {
      const el = mapContainer.current;
      if (!el) return;

      const onDragOver = (e: DragEvent) => {
        // If a .kml is present, show copy cursor + overlay
        if (e.dataTransfer) {
          const hasKml = Array.from(e.dataTransfer.items || []).some((it) =>
            it.kind === 'file' && /\.kml$/i.test(it.type || it.getAsFile()?.name || '')
          );
          if (hasKml) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setIsDraggingKml(true);
          }
        }
      };

      const onDragLeave = () => setIsDraggingKml(false);

      const onDrop = async (e: DragEvent) => {
        e.preventDefault();
        setIsDraggingKml(false);
        
        const files = Array.from(e.dataTransfer?.files || []).filter(f => /\.kml$/i.test(f.name));
        
        if (files.length === 0) {
          onError?.("No valid .kml files found in drop");
          return;
        }
        
        let totalAdded = 0;
        let totalFiles = files.length;
        
        for (const f of files) {
          try {
            const text = await f.text();
            const result = await importKmlFromText(text);
            totalAdded += result.added;
          } catch (error) {
            onError?.(`Failed to read file ${f.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }
        
        if (totalAdded > 0) {
          console.log(`Successfully imported ${totalAdded} polygon${totalAdded !== 1 ? 's' : ''} from ${totalFiles} dropped file${totalFiles !== 1 ? 's' : ''}`);
        }
      };

      el.addEventListener('dragover', onDragOver);
      el.addEventListener('dragleave', onDragLeave);
      el.addEventListener('drop', onDrop);
      return () => {
        el.removeEventListener('dragover', onDragOver);
        el.removeEventListener('dragleave', onDragLeave);
        el.removeEventListener('drop', onDrop);
      };
    }, [importKmlFromText]);

    // ————————————————————————————————————————————————
    // Imperative API (used by Home/Dialogs)
    // ————————————————————————————————————————————————
    const applyPolygonParams = useCallback((polygonId: string, params: PolygonParams) => {
      // Store params
      setPolygonParams((prev) => {
        const next = new Map(prev);
        next.set(polygonId, params);
        return next;
      });

      // If we already have analysis + tiles → build lines & path now
      const res = polygonResults.get(polygonId);
      const tiles = polygonTiles.get(polygonId) || [];
      if (!res || !mapRef.current) return;

      const lineSpacing = calculateFlightLineSpacing(DEFAULT_CAMERA, params.altitudeAGL, params.sideOverlap);

      // Rebuild lines & path for this polygon
      removeFlightLinesForPolygon(mapRef.current, polygonId);
      const fl = addFlightLinesForPolygon(
        mapRef.current,
        polygonId,
        res.polygon.coordinates,
        res.result.contourDirDeg,
        lineSpacing,
        res.result.fitQuality
      );

      setPolygonFlightLines((prev) => {
        const next = new Map(prev);
        next.set(polygonId, { ...fl, altitudeAGL: params.altitudeAGL });
        return next;
      });

      onFlightLinesUpdated?.(polygonId);

      if (deckOverlayRef.current && fl.flightLines.length > 0) {
        const path3d = build3DFlightPath(fl.flightLines, tiles, fl.lineSpacing, params.altitudeAGL);
        update3DPathLayer(deckOverlayRef.current, polygonId, path3d, setDeckLayers);
      }
    }, [polygonResults, polygonTiles, onFlightLinesUpdated]);

    useImperativeHandle(ref, () => ({
      clearAllDrawings: () => {
        if (drawRef.current) {
          drawRef.current.deleteAll();
        }
        if (deckOverlayRef.current) {
          setDeckLayers([]);
          deckOverlayRef.current.setProps({ layers: [] });
        }
        // Remove any existing trigger points
        if (mapRef.current) {
          polygonResults.forEach((_, polygonId) => {
            removeTriggerPointsForPolygon(mapRef.current!, polygonId);
          });
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
      getPolygonsWithIds: (): { id?: string; ring: [number, number][] }[] => {
        // Return polygons with their IDs for per-polygon analysis
        const draw = drawRef.current;
        if (!draw) return [];
        const coll = draw.getAll();
        const polygonsWithIds: { id?: string; ring: [number, number][] }[] = [];
        for (const f of coll.features) {
          if (f.geometry?.type === "Polygon" && Array.isArray(f.geometry.coordinates?.[0])) {
            polygonsWithIds.push({
              id: f.id as string | undefined,
              ring: f.geometry.coordinates[0] as [number, number][]
            });
          }
        }
        return polygonsWithIds;
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
      applyPolygonParams,
      getPerPolygonParams: () => Object.fromEntries(polygonParams),

      openKmlFilePicker: () => {
        kmlInputRef.current?.click();
      },
      importKmlFromText,
    }), [polygonResults, polygonFlightLines, polygonTiles, cancelAllAnalyses, applyPolygonParams, polygonParams, importKmlFromText]);

    return (
      <div
        ref={mapContainer}
        style={{ position: 'relative', width: '100%', height: '100%' }}
      >
        {/* Hidden file picker for KMLs */}
        <input
          ref={kmlInputRef}
          type="file"
          accept=".kml,application/vnd.google-earth.kml+xml"
          multiple
          onChange={handleKmlFileChange}
          style={{ display: 'none' }}
        />

        {/* Drag‑and‑drop overlay */}
        {isDraggingKml && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(59,130,246,0.08)', // blue-500 @ ~8%
              border: '2px dashed rgba(59,130,246,0.6)',
              zIndex: 10,
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                padding: '8px 12px',
                background: 'white',
                borderRadius: 6,
                boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
                fontSize: 12,
                color: '#1f2937',
              }}
            >
              Drop <strong>.kml</strong> file(s) to import areas
            </div>
          </div>
        )}
      </div>
    );
  }
);
