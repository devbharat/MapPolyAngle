// src/components/MapFlightDirection/index.tsx
/***********************************************************************
 * MapFlightDirection.tsx
 ***********************************************************************/
import React, { useRef, useState, useCallback, useImperativeHandle, useEffect } from 'react';
import { Map as MapboxMap, LngLatLike } from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import { MapboxOverlay } from '@deck.gl/mapbox';

import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

import { useMapInitialization } from './hooks/useMapInitialization';
import { usePolygonAnalysis } from './hooks/usePolygonAnalysis';
import {
  addFlightLinesForPolygon,
  removeFlightLinesForPolygon,
  clearAllFlightLines,
  addTriggerPointsForPolygon,
  removeTriggerPointsForPolygon,
  clearAllTriggerPoints
} from './utils/mapbox-layers';
import { update3DPathLayer, remove3DPathLayer, update3DCameraPointsLayer, remove3DCameraPointsLayer } from './utils/deckgl-layers';
import { build3DFlightPath, calculateFlightLineSpacing, calculateOptimalTerrainZoom } from './utils/geometry';
import { PolygonAnalysisResult, PolygonParams } from './types';
import { parseKmlPolygons, calculateKmlBounds, extractKmlFromKmz } from '@/utils/kml';
import { SONY_RX1R2 } from '@/domain/camera';
import type { MapFlightDirectionAPI, ImportedFlightplanArea } from './api';
import { fetchTilesForPolygon } from './utils/terrain';

// NEW: Wingtra import helpers
import { importWingtraFlightPlan } from '@/interop/wingtra/convert';
import { exportToWingtraFlightPlan, areasFromState } from '@/interop/wingtra/convert';

const DEFAULT_CAMERA = SONY_RX1R2;

interface Props {
  mapboxToken: string;
  center?: LngLatLike;
  zoom?: number;
  terrainZoom?: number;
  sampleStep?: number;

  onRequestParams?: (polygonId: string, ring: [number, number][]) => void;
  onAnalysisComplete?: (results: PolygonAnalysisResult[]) => void;
  onAnalysisStart?: (polygonId: string) => void;
  onError?: (error: string, polygonId?: string) => void;
  onFlightLinesUpdated?: (changed: string | '__all__') => void;
  onClearGSD?: () => void;
}

export const MapFlightDirection = React.forwardRef<MapFlightDirectionAPI, Props>(
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

    // File inputs
    const kmlInputRef = useRef<HTMLInputElement>(null);
    const flightplanInputRef = useRef<HTMLInputElement>(null);
    const [isDraggingKml, setIsDraggingKml] = useState(false);

    // Suspend auto-analysis during programmatic imports
    const suspendAutoAnalysisRef = useRef(false);

    const [polygonResults, setPolygonResults] = useState<Map<string, PolygonAnalysisResult>>(new Map());
    const [polygonTiles, setPolygonTiles] = useState<Map<string, any[]>>(new Map());

    // Flight lines + spacing + altitude actually used to build 3D path.
    const [polygonFlightLines, setPolygonFlightLines] = useState<
      Map<string, { flightLines: number[][][]; lineSpacing: number; altitudeAGL: number }>
    >(new Map());

    // Per‑polygon parameters provided by user (or by importer).
    const [polygonParams, setPolygonParams] = useState<Map<string, PolygonParams>>(new Map());
    // NEW: Queue of polygons awaiting parameter input (so multiple imports show dialogs sequentially)
    const [pendingParamPolygons, setPendingParamPolygons] = useState<string[]>([]);

    // Overrides: force a heading/spacing (e.g., from Wingtra file)
    const [bearingOverrides, setBearingOverrides] = useState<
      Map<string, { bearingDeg: number; lineSpacingM?: number; source: 'wingtra' | 'user' }>
    >(new Map());

    // Original file meta for revert
    const [importedOriginals, setImportedOriginals] = useState<
      Map<string, { bearingDeg: number; lineSpacingM: number }>
    >(new Map());

    const [deckLayers, setDeckLayers] = useState<any[]>([]);
    const [lastImportedFlightplan, setLastImportedFlightplan] = useState<any | null>(null);
    const [lastImportedFlightplanName, setLastImportedFlightplanName] = useState<string | undefined>(undefined);
    // Bulk apply guard to suppress sequential dialog popping
    const bulkApplyRef = useRef(false);
    // NEW: If user clicks "Apply All" while some polygons still analyzing, preset params
    const bulkPresetParamsRef = useRef<PolygonParams | null>(null);

    // Track any scheduled param dialog timeouts so we can cancel after bulk apply
    const paramDialogTimeoutsRef = useRef<number[]>([]);

    // Keep live copies so async callbacks always see current values (avoid stale closures)
    const polygonParamsRef = React.useRef(polygonParams);
    const bearingOverridesRef = React.useRef(bearingOverrides);
    const polygonTilesRef = React.useRef(polygonTiles);
    const polygonFlightLinesRef = React.useRef(polygonFlightLines);
    const polygonResultsRef = React.useRef(polygonResults);
    // NEW: Suppress per‑polygon flight line update events during batched imports
    const suppressFlightLineEventsRef = React.useRef(false);

    React.useEffect(() => { polygonParamsRef.current = polygonParams; }, [polygonParams]);
    React.useEffect(() => { bearingOverridesRef.current = bearingOverrides; }, [bearingOverrides]);
    React.useEffect(() => { polygonTilesRef.current = polygonTiles; }, [polygonTiles]);
    React.useEffect(() => { polygonFlightLinesRef.current = polygonFlightLines; }, [polygonFlightLines]);
    React.useEffect(() => { polygonResultsRef.current = polygonResults; }, [polygonResults]);

    // Debounced callback to prevent React render conflicts when multiple analyses complete
    const debouncedAnalysisComplete = useCallback(() => {
      const timeoutId = setTimeout(() => {
        onAnalysisComplete?.(Array.from(polygonResultsRef.current.values()));
      }, 0);
      return timeoutId;
    }, [onAnalysisComplete]);

    // ---------- helpers ----------
    const fitMapToRings = useCallback((rings: [number, number][][]) => {
      if (!mapRef.current || rings.length === 0) return;
      let minLng = +Infinity, minLat = +Infinity, maxLng = -Infinity, maxLat = -Infinity;
      for (const ring of rings) {
        for (const [lng, lat] of ring) {
          minLng = Math.min(minLng, lng);
          maxLng = Math.max(maxLng, lng);
          minLat = Math.min(minLat, lat);
          maxLat = Math.max(maxLat, lat);
        }
      }
      if (Number.isFinite(minLng) && Number.isFinite(minLat) && Number.isFinite(maxLng) && Number.isFinite(maxLat)) {
        mapRef.current.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
          padding: 50,
          duration: 1000,
          maxZoom: 18
        });
      }
    }, []);

    // ---------- analysis callbacks ----------
    const handleAnalysisResult = useCallback(
      (result: PolygonAnalysisResult, tiles: any[]) => {
        // 1) Commit result and defer parent notification to avoid React 18 render conflicts
        setPolygonResults((prev) => {
          const next = new Map(prev);
          next.set(result.polygonId, result);
          // Keep ref in sync immediately so batch callbacks (import) can read it before effect runs
            polygonResultsRef.current = next;
          debouncedAnalysisComplete();
          return next;
        });

        // 2) Store tiles
        setPolygonTiles((prev) => {
          const next = new Map(prev);
          next.set(result.polygonId, tiles);
          return next;
        });

        // Decide which heading/spacing to use when drawing
        let params = polygonParamsRef.current.get(result.polygonId);
        const override = bearingOverridesRef.current.get(result.polygonId);

        // If bulk preset exists (user clicked Apply All early) adopt params automatically
        if (!params && !override && bulkPresetParamsRef.current) {
          const preset = bulkPresetParamsRef.current;
          setPolygonParams(prev => {
            if (prev.has(result.polygonId)) return prev;
            const next = new Map(prev);
            next.set(result.polygonId, preset);
            return next;
          });
          params = preset;
        }
        
        if (!params) {
          if (override) {
            console.log(`Skipping params dialog for imported polygon ${result.polygonId}`);
            return;
          }
          setPendingParamPolygons(prev => {
            if (bulkApplyRef.current || prev.includes(result.polygonId) || bulkPresetParamsRef.current) return prev;
            const next = [...prev, result.polygonId];
            if (next.length === 1) {
              // defer to avoid render phase state update warning
              setTimeout(() => onRequestParams?.(result.polygonId, result.polygon.coordinates), 0);
              const tid = window.setTimeout(() => onRequestParams?.(result.polygonId, result.polygon.coordinates), 0);
              paramDialogTimeoutsRef.current.push(tid);
            }
            return next;
          });
          return;
        }

        if (!mapRef.current) return;

        // Use override if present (e.g., file direction), otherwise terrain-optimal
        const bearingDeg = override ? override.bearingDeg : result.result.contourDirDeg;

        // Spacing: keep override spacing if present, otherwise recompute from params
        const spacing =
          override?.lineSpacingM ??
          calculateFlightLineSpacing(DEFAULT_CAMERA, params.altitudeAGL, params.sideOverlap);

        // Remove existing flight lines first to avoid Mapbox layer conflicts
        removeFlightLinesForPolygon(mapRef.current, result.polygonId);
        
        const lines = addFlightLinesForPolygon(
          mapRef.current,
          result.polygonId,
          result.polygon.coordinates,
          bearingDeg,
          spacing,
          result.result.fitQuality
        );

        setPolygonFlightLines((prev) => {
          const next = new Map(prev);
          next.set(result.polygonId, { ...lines, altitudeAGL: params.altitudeAGL });
          return next;
        });

        if (!suppressFlightLineEventsRef.current) {
          onFlightLinesUpdated?.(result.polygonId);
        }

        if (deckOverlayRef.current && lines.flightLines.length > 0) {
          const path3d = build3DFlightPath(lines.flightLines, tiles, lines.lineSpacing, params.altitudeAGL);
          update3DPathLayer(deckOverlayRef.current, result.polygonId, path3d, setDeckLayers);
        }
      },
      [debouncedAnalysisComplete, onFlightLinesUpdated, onRequestParams]
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

    // ---------- Mapbox Draw handlers ----------
    const handleDrawCreate = useCallback((e: any) => {
      if (suspendAutoAnalysisRef.current) return;
      e.features.forEach((feature: any) => {
        if (feature.geometry.type === 'Polygon') {
          analyzePolygon(feature.id, feature);
        }
      });
    }, [analyzePolygon]);

    const handleDrawUpdate = useCallback((e: any) => {
      if (suspendAutoAnalysisRef.current) return;
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
            removeTriggerPointsForPolygon(mapRef.current, polygonId);
          }
          if (deckOverlayRef.current) {
            remove3DPathLayer(deckOverlayRef.current, polygonId, setDeckLayers);
          }
          setPolygonResults((prev) => {
            const next = new Map(prev);
            next.delete(polygonId);
            debouncedAnalysisComplete();
            return next;
          });
          setPolygonFlightLines((prev) => {
            const next = new Map(prev);
            next.delete(polygonId);
            return next;
          });
          setPolygonTiles((prev) => {
            const next = new Map(prev);
            next.delete(polygonId);
            return next;
          });
          setPolygonParams((prev) => {
            const next = new Map(prev);
            next.delete(polygonId);
            return next;
          });
          setBearingOverrides((prev) => {
            const next = new Map(prev);
            next.delete(polygonId);
            return next;
          });
          setImportedOriginals((prev) => {
            const next = new Map(prev);
            next.delete(polygonId);
            return next;
          });

          onClearGSD?.();
        }
      });
    }, [cancelAnalysis, debouncedAnalysisComplete, onClearGSD]);

    // ---------- Map init ----------
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

    // ---------- Draw utils ----------
    const addRingAsDrawFeature = useCallback((ring: [number, number][], name?: string, extraProps?: Record<string, any>): string | undefined => {
      const draw = drawRef.current as any;
      if (!draw) return;

      const feature = {
        type: 'Feature',
        properties: { name: name || '', ...(extraProps || {}) },
        geometry: { type: 'Polygon', coordinates: [ring] },
      };

      const id = draw.add(feature);
      const featureId = Array.isArray(id) ? id[0] : id;

      // Only auto-analyze if not suspended (imports will analyze explicitly)
      if (!suspendAutoAnalysisRef.current) {
        const f = (draw.get as any)?.(featureId);
        if (f?.geometry?.type === 'Polygon') analyzePolygon(featureId, f);
      }
      return featureId as string;
    }, [analyzePolygon]);

    // ---------- KML import (unchanged behavior) ----------
    const importKmlFromText = useCallback(async (kmlText: string) => {
      try {
        const polygons = parseKmlPolygons(kmlText);
        let added = 0; const newIds: string[] = [];
        suspendAutoAnalysisRef.current = true;
        for (const p of polygons) {
          if (p.ring?.length >= 4) {
            const id = addRingAsDrawFeature(p.ring, p.name, { source: 'kml' });
            if (id) newIds.push(id);
            added++;
          }
        }

        if (added > 0 && mapRef.current) {
          const bounds = calculateKmlBounds(polygons.filter(p => p.ring?.length >= 4));
          if (bounds) {
            const padding = 0.001;
            const padded: [[number, number], [number, number]] = [
              [bounds.minLng - padding, bounds.minLat - padding],
              [bounds.maxLng + padding, bounds.maxLat + padding]
            ];
            mapRef.current.fitBounds(padded, { padding: 50, duration: 1000, maxZoom: 18 });
          }
        } else if (polygons.length > 0) {
          onError?.("KML contained polygons but none were valid (need at least 4 coordinates)");
        } else {
          onError?.("No valid polygons found in KML file");
        }

        // Run analyses after all added
        suspendAutoAnalysisRef.current = false;
        for (const pid of newIds) {
          const draw = drawRef.current as any;
            const f = draw?.get?.(pid);
            if (f?.geometry?.type === 'Polygon') analyzePolygon(pid, f);
        }
        return { added, total: polygons.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to parse KML file";
        onError?.(message);
        return { added: 0, total: 0 };
      } finally {
        suspendAutoAnalysisRef.current = false;
      }
    }, [addRingAsDrawFeature, onError]);

    const handleKmlFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []).filter(f => /\.(kml|kmz)$/i.test(f.name));
      if (files.length === 0) {
        onError?.("Please select valid .kml or .kmz files");
        return;
      }
      let totalAdded = 0;
      for (const file of files) {
        try {
          let kmlText: string | null = null;
          if (/\.kmz$/i.test(file.name)) {
            const buf = await file.arrayBuffer();
            try {
              kmlText = await extractKmlFromKmz(buf);
            } catch (err) {
              onError?.(`Failed to extract KMZ ${file.name}: ${err instanceof Error ? err.message : 'Unknown error'}`);
              continue;
            }
          } else { // .kml
            kmlText = await file.text();
          }
          if (kmlText) {
            const result = await importKmlFromText(kmlText);
            totalAdded += result.added;
          }
        } catch (error) {
          onError?.(`Failed to read file ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
      if (kmlInputRef.current) kmlInputRef.current.value = '';
    }, [importKmlFromText, onError]);

    // ---------- Wingtra flightplan import ----------
    const importWingtraFromText = useCallback(async (json: string): Promise<{ added: number; total: number; areas: ImportedFlightplanArea[] }> => {
      try {
        console.log(`📥 Importing Wingtra flightplan...`);
        const parsed = JSON.parse(json);
        setLastImportedFlightplan(parsed);
        const imported = importWingtraFlightPlan(parsed, { angleConvention: 'northCW' }); // change if you need eastCW
        const areasOut: ImportedFlightplanArea[] = [];

        if (!mapRef.current || !drawRef.current) {
          onError?.('Map is not ready yet');
          return { added: 0, total: imported.items.length, areas: [] };
        }

        console.log(`📦 Found ${imported.items.length} areas in flightplan`);
        
        // Suspend automatic per‑polygon side effects during batch
        suspendAutoAnalysisRef.current = true;
        suppressFlightLineEventsRef.current = true;
        const newRings: [number, number][][] = [];
        const newIds: string[] = [];
        
        // Batch state updates for better performance
        const polygonsToUpdate = new Map();
        const flightLinesToUpdate = new Map();

        // 1) Add features (no analysis yet), set params + overrides, draw file lines immediately
        for (const item of imported.items) {
          const id = addRingAsDrawFeature(item.ring, `Flightplan Area`, { source: 'wingtra' });
          if (!id) continue;
          newIds.push(id);
          newRings.push(item.ring as [number, number][]);

          const polygonState = {
            params: {
              altitudeAGL: item.altitudeAGL,
              frontOverlap: item.frontOverlap,
              sideOverlap: item.sideOverlap
            },
            original: { bearingDeg: item.angleDeg, lineSpacingM: item.lineSpacingM },
            override: { bearingDeg: item.angleDeg, lineSpacingM: item.lineSpacingM, source: 'wingtra' as const }
          };
          polygonsToUpdate.set(id, polygonState);

          const lines = addFlightLinesForPolygon(
            mapRef.current,
            id,
            item.ring as number[][],
            item.angleDeg,
            item.lineSpacingM,
            undefined
          );
          flightLinesToUpdate.set(id, { ...lines, altitudeAGL: item.altitudeAGL });

          areasOut.push({
            polygonId: id,
            params: {
              altitudeAGL: item.altitudeAGL,
              frontOverlap: item.frontOverlap,
              sideOverlap: item.sideOverlap,
              angleDeg: item.angleDeg,
              lineSpacingM: item.lineSpacingM,
              triggerDistanceM: item.triggerDistanceM,
              source: 'wingtra'
            }
          });
        }

        setPolygonParams(prev => {
          const next = new Map(prev);
          for (const [id, state] of Array.from(polygonsToUpdate.entries())) next.set(id, state.params);
          return next;
        });
        setImportedOriginals(prev => {
          const next = new Map(prev);
          for (const [id, state] of Array.from(polygonsToUpdate.entries())) next.set(id, state.original);
          return next;
        });
        setBearingOverrides(prev => {
          const next = new Map(prev);
          for (const [id, state] of Array.from(polygonsToUpdate.entries())) next.set(id, state.override);
          return next;
        });
        setPolygonFlightLines(prev => {
          const next = new Map(prev);
            for (const [id, lines] of Array.from(flightLinesToUpdate.entries())) next.set(id, lines);
          return next;
        });

        // 2) Fit map to imported rings
        fitMapToRings(newRings);

        // 3) Fetch tiles + build 3D paths (still before analysis so we can build paths early)
        for (let idx = 0; idx < newIds.length; idx++) {
          const polygonId = newIds[idx];
          const ring = newRings[idx];
          const z = calculateOptimalTerrainZoom({ coordinates: ring as any });
          const tiles = await fetchTilesForPolygon({ coordinates: ring as any }, z, mapboxToken, new AbortController().signal);
          setPolygonTiles(prev => {
            const next = new Map(prev);
            next.set(polygonId, tiles);
            return next;
          });
          const flEntry = flightLinesToUpdate.get(polygonId);
          const lineSpacing = flEntry?.lineSpacing ?? imported.items[idx]?.lineSpacingM ?? 25;
          const altitudeAGL = polygonsToUpdate.get(polygonId)?.params.altitudeAGL ?? imported.items[idx]?.altitudeAGL ?? 100;
          if (deckOverlayRef.current && flEntry?.flightLines?.length) {
            const path3d = build3DFlightPath(flEntry.flightLines, tiles, lineSpacing, altitudeAGL);
            update3DPathLayer(deckOverlayRef.current, polygonId, path3d, setDeckLayers);
          }
        }

        // 4) Re-enable auto-analysis and run analyses (collect promises)
        suspendAutoAnalysisRef.current = false;
        const analysisPromises: Promise<any>[] = [];
        for (const polygonId of newIds) {
          const draw = drawRef.current as any;
            const feature = draw?.get?.(polygonId);
            if (feature?.geometry?.type === 'Polygon') {
              const p = analyzePolygon(polygonId, feature);
              analysisPromises.push(p);
            }
        }
        console.log(`🧪 Launched ${analysisPromises.length} terrain analyses for imported areas (waiting to batch notify GSD)...`);
        await Promise.allSettled(analysisPromises);
        console.log(`🧪 All imported terrain analyses settled.`);

        // Ensure effects updating polygonResultsRef have flushed before emitting final results
        await new Promise(r => setTimeout(r, 0));
        onAnalysisComplete?.(Array.from(polygonResultsRef.current.values()));

        // 5) Allow per‑polygon events again & emit a single aggregate update
        suppressFlightLineEventsRef.current = false;
        onFlightLinesUpdated?.('__all__');

        console.log(`✅ Successfully imported ${newIds.length} areas with file bearings preserved. Use "Optimize" to get terrain-optimal directions.`);
        return { added: newIds.length, total: imported.items.length, areas: areasOut };
      } catch (e) {
        suppressFlightLineEventsRef.current = false;
        onError?.(`Failed to import flightplan: ${e instanceof Error ? e.message : 'Unknown error'}`);
        suspendAutoAnalysisRef.current = false;
        return { added: 0, total: 0, areas: [] };
      }
    }, [mapboxToken, addRingAsDrawFeature, polygonFlightLines, polygonParams, fitMapToRings, analyzePolygon, onFlightLinesUpdated, onError]);

    const handleFlightplanFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      for (const file of Array.from(files)) {
        try {
          const text = await file.text();
          setLastImportedFlightplanName(file.name);
          await importWingtraFromText(text);
        } catch (err) {
          onError?.(`Failed to read flightplan file ${file.name}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }
      if (flightplanInputRef.current) flightplanInputRef.current.value = '';
    }, [importWingtraFromText, onError]);

    // ---------- Drag & drop (KML) ----------
    useEffect(() => {
      const el = mapContainer.current;
      if (!el) return;

      const onDragOver = (e: DragEvent) => {
        if (e.dataTransfer) {
          const hasKml = Array.from(e.dataTransfer.items || []).some((it) =>
            it.kind === 'file' && /\.(kml|kmz)$/i.test(it.type || it.getAsFile()?.name || '')
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

        const files = Array.from(e.dataTransfer?.files || []).filter(f => /\.(kml|kmz)$/i.test(f.name));
        if (files.length === 0) {
          onError?.("No valid .kml or .kmz files found in drop");
          return;
        }

        let totalAdded = 0;
        for (const f of files) {
          try {
            let kmlText: string | null = null;
            if (/\.kmz$/i.test(f.name)) {
              const buf = await f.arrayBuffer();
              try {
                kmlText = await extractKmlFromKmz(buf);
              } catch (err) {
                onError?.(`Failed to extract KMZ ${f.name}: ${err instanceof Error ? err.message : 'Unknown error'}`);
                continue;
              }
            } else {
              kmlText = await f.text();
            }
            if (kmlText) {
              const result = await importKmlFromText(kmlText);
              totalAdded += result.added;
            }
          } catch (error) {
            onError?.(`Failed to read file ${f.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
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
    }, [importKmlFromText, onError]);

    // ---------- Imperative API ----------
    const applyPolygonParams = useCallback((polygonId: string, params: PolygonParams, opts?: { skipEvent?: boolean }) => {
      setPolygonParams((prev) => {
        const next = new Map(prev);
        next.set(polygonId, params);
        return next;
      });

      const res = polygonResults.get(polygonId);
      const tiles = polygonTiles.get(polygonId) || [];
      if (!res || !mapRef.current) return;

      const override = bearingOverridesRef.current.get(polygonId);
      const bearingDeg = override ? override.bearingDeg : res.result.contourDirDeg;
      const spacing = override?.lineSpacingM ?? calculateFlightLineSpacing(DEFAULT_CAMERA, params.altitudeAGL, params.sideOverlap);

      removeFlightLinesForPolygon(mapRef.current, polygonId);
      const fl = addFlightLinesForPolygon(
        mapRef.current,
        polygonId,
        res.polygon.coordinates,
        bearingDeg,
        spacing,
        res.result.fitQuality
      );

      setPolygonFlightLines((prev) => {
        const next = new Map(prev);
        next.set(polygonId, { ...fl, altitudeAGL: params.altitudeAGL });
        return next;
      });

      if (!opts?.skipEvent && !suppressFlightLineEventsRef.current) {
        onFlightLinesUpdated?.(polygonId);
      }

      if (deckOverlayRef.current && fl.flightLines.length > 0) {
        const path3d = build3DFlightPath(fl.flightLines, tiles, fl.lineSpacing, params.altitudeAGL);
        update3DPathLayer(deckOverlayRef.current, polygonId, path3d, setDeckLayers);
      }

      setPendingParamPolygons(prev => {
        const rest = prev.filter(id => id !== polygonId);
        if (!bulkApplyRef.current && rest.length > 0) {
          const nextId = rest[0];
          const nextRes = polygonResultsRef.current.get(nextId);
          if (nextRes) {
            setTimeout(() => onRequestParams?.(nextId, nextRes.polygon.coordinates), 0);
            const tid = window.setTimeout(() => onRequestParams?.(nextId, nextRes.polygon.coordinates), 0);
            paramDialogTimeoutsRef.current.push(tid);
          } else {
            const draw = drawRef.current as any;
            const f = draw?.get?.(nextId);
            if (f?.geometry?.type === 'Polygon') setTimeout(() => onRequestParams?.(nextId, f.geometry.coordinates[0]), 0);
            if (f?.geometry?.type === 'Polygon') {
              const tid2 = window.setTimeout(() => onRequestParams?.(nextId, f.geometry.coordinates[0]), 0);
              paramDialogTimeoutsRef.current.push(tid2);
            }
          }
        }
        // Do NOT clear bulkPresetParamsRef here; keep it for late analyses
        return rest;
      });
    }, [polygonResults, polygonTiles, onFlightLinesUpdated]);

    // NEW: Apply same params to all queued polygons (bulk "Apply All")
    const applyParamsToAllPending = useCallback((params: PolygonParams) => {
      const queueSnapshot = [...pendingParamPolygons];
      if (queueSnapshot.length === 0) {
        // even if queue empty, set preset so late polygons adopt
        bulkPresetParamsRef.current = params;
        return;
      }
      bulkApplyRef.current = true;
      // Cancel any pending dialog-open timeouts to avoid reopen after close
      paramDialogTimeoutsRef.current.forEach(id => clearTimeout(id));
      paramDialogTimeoutsRef.current = [];
      bulkPresetParamsRef.current = params;
      setPolygonParams(prev => {
        const next = new Map(prev);
        for (const id of queueSnapshot) next.set(id, params);
        return next;
      });
      const prevSuppress = suppressFlightLineEventsRef.current;
      suppressFlightLineEventsRef.current = true;
      for (const pid of queueSnapshot) {
        if (polygonResultsRef.current.has(pid)) {
          applyPolygonParams(pid, params, { skipEvent: true });
        }
      }
      setPendingParamPolygons([]);
      suppressFlightLineEventsRef.current = prevSuppress;
      bulkApplyRef.current = false;
      onFlightLinesUpdated?.('__all__');
    }, [pendingParamPolygons, onFlightLinesUpdated, applyPolygonParams]);

    // RESTORED: optimizePolygonDirection (terrain-optimal)
    const optimizePolygonDirection = useCallback((polygonId: string) => {
      console.log(`🎯 Optimizing direction for polygon ${polygonId} - switching to terrain-optimal bearing`);
      setBearingOverrides((prev) => {
        const next = new Map(prev);
        next.delete(polygonId);
        return next;
      });
      bearingOverridesRef.current = new Map(bearingOverridesRef.current);
      bearingOverridesRef.current.delete(polygonId);
      const hasResults = polygonResults.has(polygonId);
      if (!hasResults) {
        console.log(`⚡ No terrain analysis yet for polygon ${polygonId}, running analysis first...`);
        const draw = drawRef.current as any;
        const f = draw?.get?.(polygonId);
        if (f?.geometry?.type === 'Polygon') analyzePolygon(polygonId, f);
        return;
      }
      const params = polygonParamsRef.current.get(polygonId) ?? { altitudeAGL: 100, frontOverlap: 80, sideOverlap: 70 };
      console.log(`✅ Applying terrain-optimal direction for polygon ${polygonId}`);
      applyPolygonParams(polygonId, params);
    }, [polygonResults, applyPolygonParams, analyzePolygon]);

    // RESTORED: revertPolygonToImportedDirection
    const revertPolygonToImportedDirection = useCallback((polygonId: string) => {
      console.log(`📁 Reverting polygon ${polygonId} to file direction (Wingtra bearing/spacing)`);
      const original = importedOriginals.get(polygonId);
      const res = polygonResults.get(polygonId);
      if (!original || !res || !mapRef.current) return;
      setBearingOverrides((prev) => {
        const next = new Map(prev);
        next.set(polygonId, { bearingDeg: original.bearingDeg, lineSpacingM: original.lineSpacingM, source: 'wingtra' });
        return next;
      });
      bearingOverridesRef.current = new Map(bearingOverridesRef.current);
      bearingOverridesRef.current.set(polygonId, { bearingDeg: original.bearingDeg, lineSpacingM: original.lineSpacingM, source: 'wingtra' });
      const params = polygonParams.get(polygonId) ?? { altitudeAGL: 100, frontOverlap: 80, sideOverlap: 70 };
      removeFlightLinesForPolygon(mapRef.current, polygonId);
      const fl = addFlightLinesForPolygon(
        mapRef.current,
        polygonId,
        res.polygon.coordinates,
        original.bearingDeg,
        original.lineSpacingM,
        res.result.fitQuality
      );
      setPolygonFlightLines((prev) => {
        const next = new Map(prev);
        next.set(polygonId, { ...fl, altitudeAGL: params.altitudeAGL });
        return next;
      });
      const tiles = polygonTiles.get(polygonId) || [];
      if (deckOverlayRef.current && fl.flightLines.length > 0) {
        const path3d = build3DFlightPath(fl.flightLines, tiles, fl.lineSpacing, params.altitudeAGL);
        update3DPathLayer(deckOverlayRef.current, polygonId, path3d, setDeckLayers);
      }
      console.log(`✅ Restored file direction: ${original.bearingDeg}° bearing, ${original.lineSpacingM}m spacing`);
      onFlightLinesUpdated?.(polygonId);
    }, [importedOriginals, polygonResults, polygonParams, polygonTiles, onFlightLinesUpdated]);

    // RESTORED: runFullAnalysis
    const runFullAnalysis = useCallback((polygonId: string) => {
      console.log(`🔄 Running full analysis for polygon ${polygonId} - clearing overrides and requesting fresh params`);
      setBearingOverrides((prev) => {
        const next = new Map(prev);
        next.delete(polygonId);
        return next;
      });
      setPolygonResults((prev) => {
        const next = new Map(prev);
        next.delete(polygonId);
        return next;
      });
      setPolygonParams((prev) => {
        const next = new Map(prev);
        next.delete(polygonId);
        return next;
      });
      if (mapRef.current) {
        removeFlightLinesForPolygon(mapRef.current, polygonId);
        removeTriggerPointsForPolygon(mapRef.current, polygonId);
      }
      if (deckOverlayRef.current) {
        remove3DPathLayer(deckOverlayRef.current, polygonId, setDeckLayers);
      }
      console.log(`⚡ Starting fresh terrain analysis for polygon ${polygonId}...`);
      const draw = drawRef.current as any;
      const f = draw?.get?.(polygonId);
      if (f?.geometry?.type === 'Polygon') {
        analyzePolygon(polygonId, f);
      }
    }, [analyzePolygon]);

    // ---------- Map render ----------
    // Note: using `any` for now due to complex nested types from Mapbox GL and Deck.gl
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapRenderProps: any = {
      ref: mapRef,
      style: { width: '100%', height: '100%' },
      mapboxApiAccessToken: mapboxToken,
      onError: memoizedOnError,
      // Pass-through props
      center,
      zoom,
      terrainZoom,
      sampleStep,
    };

    React.useImperativeHandle(ref, () => ({
      clearAllDrawings: () => {
        if (drawRef.current) drawRef.current.deleteAll();
        if (deckOverlayRef.current) {
          setDeckLayers([]);
          deckOverlayRef.current.setProps({ layers: [] });
        }
        if (mapRef.current) {
          clearAllFlightLines(mapRef.current);
          clearAllTriggerPoints(mapRef.current);
        }
        setPolygonResults(new Map());
        setPolygonTiles(new Map());
        setPolygonFlightLines(new Map());
        setPolygonParams(new Map());
        setBearingOverrides(new Map());
        setImportedOriginals(new Map());
        setPendingParamPolygons([]);

        cancelAllAnalyses();
        onClearGSD?.();
      },
      clearPolygon: (polygonId: string) => {
        if (drawRef.current) drawRef.current.delete(polygonId);
      },
      startPolygonDrawing: () => {
        if (drawRef.current) (drawRef.current as any).changeMode('draw_polygon');
      },
      getPolygonResults: () => Array.from(polygonResults.values()),
      getMap: () => mapRef.current,
      getPolygons: (): [number,number][][] => {
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
        if (deckOverlayRef.current) update3DCameraPointsLayer(deckOverlayRef.current, polygonId, positions, setDeckLayers);
      },
      removeCameraPoints: (polygonId: string) => {
        if (deckOverlayRef.current) remove3DCameraPointsLayer(deckOverlayRef.current, polygonId, setDeckLayers);
      },
      applyPolygonParams,
      // expose bulk apply helper
      applyParamsToAllPending,
      getPerPolygonParams: () => Object.fromEntries(polygonParams),

      openKmlFilePicker: () => {
        kmlInputRef.current?.click();
      },
      importKmlFromText,

      openFlightplanFilePicker: () => {
        flightplanInputRef.current?.click();
      },
      importWingtraFromText,

      optimizePolygonDirection,
      revertPolygonToImportedDirection,
      runFullAnalysis,
      
      getBearingOverrides: () => Object.fromEntries(bearingOverrides),
      getImportedOriginals: () => Object.fromEntries(importedOriginals),
      exportWingtraFlightPlan: () => {
        // Build area list from current state
        const polys: Array<{ ring:[number,number][]; params: { altitudeAGL:number; frontOverlap:number; sideOverlap:number }; bearingDeg:number; lineSpacingM?:number; triggerDistanceM?:number }> = [];
        polygonParams.forEach((params, pid) => {
          const res = polygonResults.get(pid);
          const collection = drawRef.current?.getAll();
          const feature = collection?.features.find(f=>f.id===pid && f.geometry?.type==='Polygon');
          const ring = res?.polygon.coordinates || (feature?.geometry as any)?.coordinates?.[0];
          if (!ring) return;
          const override = bearingOverrides.get(pid);
          const bearingDeg = override ? override.bearingDeg : (res?.result.contourDirDeg ?? 0);
          const lineSpacingM = override?.lineSpacingM || (polygonFlightLines.get(pid)?.lineSpacing);
          polys.push({ ring: ring as any, params: { altitudeAGL: params.altitudeAGL, frontOverlap: params.frontOverlap, sideOverlap: params.sideOverlap }, bearingDeg, lineSpacingM, triggerDistanceM: undefined });
        });
        const areas = areasFromState(polys);
        let fp;
        if (lastImportedFlightplan) {
          // Deep clone original
            fp = JSON.parse(JSON.stringify(lastImportedFlightplan));
          // Replace flightPlan.items only (preserve metadata/stats; some tools may recalc them)
          fp.flightPlan.items = exportToWingtraFlightPlan(areas, {}).flightPlan.items;
          // Optionally update payload fields if camera changed (skipped for now)
          // Reset derived stats that may be stale
          fp.flightPlan.numberOfImages = 0;
          fp.flightPlan.totalArea = 0;
          fp.flightPlan.activeTotalArea = 0;
          fp.flightPlan.activeNumberOfImages = 0;
          fp.flightPlan.flownPercentage = 0;
          fp.flightPlan.resumeMissionIndex = 0;
          fp.flightPlan.resumeGridPointIndex = -1;
          fp.flightPlan.lastModifiedTime = Date.now();
        } else {
          fp = exportToWingtraFlightPlan(areas, {});
        }
        const json = JSON.stringify(fp, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        return { json, blob };
      },
    }), [
      polygonResults, polygonFlightLines, polygonTiles, polygonParams,
      cancelAllAnalyses, applyPolygonParams,
      bearingOverrides, importedOriginals,
      importKmlFromText, importWingtraFromText,
      optimizePolygonDirection, revertPolygonToImportedDirection, runFullAnalysis,
      lastImportedFlightplan
    ]);

    return (
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        {/* ✅ EMPTY container that Mapbox owns */}
        <div ref={mapContainer} style={{ position: 'absolute', inset: 0 }} />

        {/* ✅ Siblings, not children of the Mapbox container */}
        <input
          ref={kmlInputRef}
          type="file"
          accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz"
          multiple
          onChange={handleKmlFileChange}
          style={{ display: 'none' }}
        />
        <input
          ref={flightplanInputRef}
          type="file"
          accept=".flightplan,.json,application/json"
          multiple
          onChange={handleFlightplanFileChange}
          style={{ display: 'none' }}
        />

        {/* KML drag overlay */}
        {isDraggingKml && (
          <div
            style={{
              position: 'absolute', inset: 0, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              background: 'rgba(59,130,246,0.08)', border: '2px dashed rgba(59,130,246,0.6)',
              zIndex: 10, pointerEvents: 'none',
            }}
          >
            <div
              style={{
                padding: '8px 12px', background: 'white', borderRadius: 6,
                boxShadow: '0 1px 3px rgba(0,0,0,0.15)', fontSize: 12, color: '#1f2937',
              }}
            >
              Drop <strong>.kml</strong>/<strong>.kmz</strong> file(s) to import areas
            </div>
          </div>
        )}
      </div>
    );
  }
);
