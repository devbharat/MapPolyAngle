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
import { parseKmlPolygons, calculateKmlBounds } from '@/utils/kml';
import { SONY_RX1R2 } from '@/domain/camera';
import type { MapFlightDirectionAPI, ImportedFlightplanArea } from './api';
import { fetchTilesForPolygon } from './utils/terrain';

// NEW: Wingtra import helpers
import { importWingtraFlightPlan } from '@/interop/wingtra/convert';

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

    // Overrides: force a heading/spacing (e.g., from Wingtra file)
    const [bearingOverrides, setBearingOverrides] = useState<
      Map<string, { bearingDeg: number; lineSpacingM?: number; source: 'wingtra' | 'user' }>
    >(new Map());

    // Original file meta for revert
    const [importedOriginals, setImportedOriginals] = useState<
      Map<string, { bearingDeg: number; lineSpacingM: number }>
    >(new Map());

    const [deckLayers, setDeckLayers] = useState<any[]>([]);

    // Keep live copies so async callbacks always see current values (avoid stale closures)
    const polygonParamsRef = React.useRef(polygonParams);
    const bearingOverridesRef = React.useRef(bearingOverrides);
    const polygonTilesRef = React.useRef(polygonTiles);
    const polygonFlightLinesRef = React.useRef(polygonFlightLines);

    React.useEffect(() => { polygonParamsRef.current = polygonParams; }, [polygonParams]);
    React.useEffect(() => { bearingOverridesRef.current = bearingOverrides; }, [bearingOverrides]);
    React.useEffect(() => { polygonTilesRef.current = polygonTiles; }, [polygonTiles]);
    React.useEffect(() => { polygonFlightLinesRef.current = polygonFlightLines; }, [polygonFlightLines]);

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
        // Keep analysis result & tiles
        let updatedResults: PolygonAnalysisResult[];
        setPolygonResults((prev) => {
          const next = new Map(prev);
          next.set(result.polygonId, result);
          updatedResults = Array.from(next.values());
          return next;
        });

        setPolygonTiles((prev) => {
          const next = new Map(prev);
          next.set(result.polygonId, tiles);
          return next;
        });

        // Call the callback after state updates are complete
        if (updatedResults!) {
          onAnalysisComplete?.(updatedResults);
        }

        // Decide which heading/spacing to use when drawing
        const params = polygonParamsRef.current.get(result.polygonId);
        const override = bearingOverridesRef.current.get(result.polygonId);
        
        if (!params) {
          // For imported polygons (with overrides), don't ask for params - they're already set
          if (override) {
            console.log(`Skipping params dialog for imported polygon ${result.polygonId}`);
            return;
          }
          // Ask parent to prompt user for this polygon (for manually drawn ones only)
          onRequestParams?.(result.polygonId, result.polygon.coordinates);
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

        onFlightLinesUpdated?.(result.polygonId);

        if (deckOverlayRef.current && lines.flightLines.length > 0) {
          const path3d = build3DFlightPath(lines.flightLines, tiles, lines.lineSpacing, params.altitudeAGL);
          update3DPathLayer(deckOverlayRef.current, result.polygonId, path3d, setDeckLayers);
        }
      },
      [onAnalysisComplete, onFlightLinesUpdated, onRequestParams]
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
          let updatedResults: PolygonAnalysisResult[];
          setPolygonResults((prev) => {
            const next = new Map(prev);
            next.delete(polygonId);
            updatedResults = Array.from(next.values());
            return next;
          });
          // Call callback after state update
          if (updatedResults!) {
            onAnalysisComplete?.(updatedResults);
          }
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
    }, [cancelAnalysis, onAnalysisComplete, onClearGSD]);

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
        let added = 0;

        for (const p of polygons) {
          if (p.ring?.length >= 4) {
            addRingAsDrawFeature(p.ring, p.name);
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

        return { added, total: polygons.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to parse KML file";
        onError?.(message);
        return { added: 0, total: 0 };
      }
    }, [addRingAsDrawFeature, onError]);

    const handleKmlFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []).filter(f => /\.kml$/i.test(f.name));
      if (files.length === 0) {
        onError?.("Please select valid .kml files");
        return;
      }
      let totalAdded = 0;
      for (const file of files) {
        try {
          const text = await file.text();
          const result = await importKmlFromText(text);
          totalAdded += result.added;
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
        const imported = importWingtraFlightPlan(parsed, { angleConvention: 'northCW' }); // change if you need eastCW
        const areasOut: ImportedFlightplanArea[] = [];

        if (!mapRef.current || !drawRef.current) {
          onError?.('Map is not ready yet');
          return { added: 0, total: imported.items.length, areas: [] };
        }

        console.log(`📦 Found ${imported.items.length} areas in flightplan`);
        
        suspendAutoAnalysisRef.current = true;
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

          // Store polygon state for batch update
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

          // draw lines now with file heading/spacing
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

        // Batch state updates
        setPolygonParams(prev => {
          const next = new Map(prev);
          for (const [id, state] of Array.from(polygonsToUpdate.entries())) {
            next.set(id, state.params);
          }
          return next;
        });

        setImportedOriginals(prev => {
          const next = new Map(prev);
          for (const [id, state] of Array.from(polygonsToUpdate.entries())) {
            next.set(id, state.original);
          }
          return next;
        });

        setBearingOverrides(prev => {
          const next = new Map(prev);
          for (const [id, state] of Array.from(polygonsToUpdate.entries())) {
            next.set(id, state.override);
          }
          return next;
        });

        setPolygonFlightLines(prev => {
          const next = new Map(prev);
          for (const [id, lines] of Array.from(flightLinesToUpdate.entries())) {
            next.set(id, lines);
          }
          return next;
        });

        // 2) Fit map to imported rings
        fitMapToRings(newRings);

        // 3) Fetch tiles + build 3D paths + tell GSD panel to run (via callback)
        for (let idx = 0; idx < newIds.length; idx++) {
          const polygonId = newIds[idx];
          const ring = newRings[idx];

          // terrain zoom heuristic, tiles, store
          const z = calculateOptimalTerrainZoom({ coordinates: ring as any });
          const tiles = await fetchTilesForPolygon({ coordinates: ring as any }, z, mapboxToken, new AbortController().signal);
          setPolygonTiles(prev => {
            const next = new Map(prev);
            next.set(polygonId, tiles);
            return next;
          });

          // 3D path
          // Use the freshly computed batch, not the (asynchronously) updated state
          const flEntry = flightLinesToUpdate.get(polygonId);
          const lineSpacing = flEntry?.lineSpacing ?? imported.items[idx]?.lineSpacingM ?? 25;

          // We also have the fresh params in polygonsToUpdate
          const altitudeAGL =
            polygonsToUpdate.get(polygonId)?.params.altitudeAGL ??
            imported.items[idx]?.altitudeAGL ??
            100;

          if (deckOverlayRef.current && flEntry?.flightLines?.length) {
            const path3d = build3DFlightPath(flEntry.flightLines, tiles, lineSpacing, altitudeAGL);
            update3DPathLayer(deckOverlayRef.current, polygonId, path3d, setDeckLayers);
          }

          // Kick GSD auto-run path via parent callback
          onFlightLinesUpdated?.(polygonId);

          // 👉 Run terrain analysis now so "Analysis Result" is available immediately.
          // This does not rotate lines because the Wingtra override is still set.
          const draw = drawRef.current as any;
          const feature = draw?.get?.(polygonId);
          if (feature?.geometry?.type === 'Polygon') {
            analyzePolygon(polygonId, feature);
          }
        }

        suspendAutoAnalysisRef.current = false;
        console.log(`✅ Successfully imported ${newIds.length} areas with file bearings preserved. Use "Optimize" to get terrain-optimal directions.`);
        return { added: newIds.length, total: imported.items.length, areas: areasOut };
      } catch (e) {
        onError?.(`Failed to import flightplan: ${e instanceof Error ? e.message : 'Unknown error'}`);
        suspendAutoAnalysisRef.current = false;
        return { added: 0, total: 0, areas: [] };
      }
    }, [mapboxToken, addRingAsDrawFeature, polygonFlightLines, polygonParams, fitMapToRings, analyzePolygon, onFlightLinesUpdated, onError]);

    const handleFlightplanFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []).filter(f =>
        /\.flightplan$/i.test(f.name) || /\.json$/i.test(f.name)
      );
      if (files.length === 0) {
        onError?.("Please select a valid Wingtra .flightplan (JSON) file");
        return;
      }
      for (const file of files) {
        try {
          const text = await file.text();
          await importWingtraFromText(text);
        } catch (err) {
          onError?.(`Failed to read file ${file.name}: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
        for (const f of files) {
          try {
            const text = await f.text();
            const result = await importKmlFromText(text);
            totalAdded += result.added;
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
    const applyPolygonParams = useCallback((polygonId: string, params: PolygonParams) => {
      setPolygonParams((prev) => {
        const next = new Map(prev);
        next.set(polygonId, params);
        return next;
      });

      const res = polygonResults.get(polygonId);
      const tiles = polygonTiles.get(polygonId) || [];
      if (!res || !mapRef.current) return;

      // Respect override (bearing), recompute spacing from params unless overridden.
      // Use ref to avoid stale state when we change overrides and re-apply immediately.
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

      onFlightLinesUpdated?.(polygonId);

      if (deckOverlayRef.current && fl.flightLines.length > 0) {
        const path3d = build3DFlightPath(fl.flightLines, tiles, fl.lineSpacing, params.altitudeAGL);
        update3DPathLayer(deckOverlayRef.current, polygonId, path3d, setDeckLayers);
      }
    }, [polygonResults, polygonTiles, onFlightLinesUpdated]);

    const optimizePolygonDirection = useCallback((polygonId: string) => {
      console.log(`🎯 Optimizing direction for polygon ${polygonId} - switching to terrain-optimal bearing`);

      // 1) Drop override in both state and ref so apply() sees latest immediately.
      setBearingOverrides((prev) => {
        const next = new Map(prev);
        next.delete(polygonId);
        return next;
      });
      bearingOverridesRef.current = new Map(bearingOverridesRef.current);
      bearingOverridesRef.current.delete(polygonId);

      // 2) Ensure we have terrain analysis; if not, run it first.
      const hasResults = polygonResults.has(polygonId);
      if (!hasResults) {
        console.log(`⚡ No terrain analysis yet for polygon ${polygonId}, running analysis first...`);
        const draw = drawRef.current as any;
        const f = draw?.get?.(polygonId);
        if (f?.geometry?.type === 'Polygon') analyzePolygon(polygonId, f);
        return;
      }

      // 3) Re-apply params; apply() will now use res.result.contourDirDeg.
      const params =
        polygonParamsRef.current.get(polygonId) ?? { altitudeAGL: 100, frontOverlap: 80, sideOverlap: 70 };
      console.log(`✅ Applying terrain-optimal direction for polygon ${polygonId}`);
      applyPolygonParams(polygonId, params);
    }, [polygonResults, applyPolygonParams, analyzePolygon]);

    const revertPolygonToImportedDirection = useCallback((polygonId: string) => {
      console.log(`📁 Reverting polygon ${polygonId} to file direction (Wingtra bearing/spacing)`);
      
      const original = importedOriginals.get(polygonId);
      const res = polygonResults.get(polygonId);
      if (!original || !res || !mapRef.current) return;

      // restore override to file bearing/spacing
      setBearingOverrides((prev) => {
        const next = new Map(prev);
        next.set(polygonId, { bearingDeg: original.bearingDeg, lineSpacingM: original.lineSpacingM, source: 'wingtra' });
        return next;
      });
      // Also update ref for immediate visibility to any subsequent calls
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

    const runFullAnalysis = useCallback((polygonId: string) => {
      console.log(`🔄 Running full analysis for polygon ${polygonId} - clearing overrides and requesting fresh params`);
      
      // Clear any overrides and remove existing results to force fresh analysis
      setBearingOverrides((prev) => {
        const next = new Map(prev);
        next.delete(polygonId);
        return next;
      });

      // Clear existing results
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

      // Clear any old visuals for this polygon
      if (mapRef.current) {
        removeFlightLinesForPolygon(mapRef.current, polygonId);
        removeTriggerPointsForPolygon(mapRef.current, polygonId);
      }
      if (deckOverlayRef.current) {
        remove3DPathLayer(deckOverlayRef.current, polygonId, setDeckLayers);
      }

      console.log(`⚡ Starting fresh terrain analysis for polygon ${polygonId}...`);

      // Trigger fresh analysis as if manually drawn
      const draw = drawRef.current as any;
      const f = draw?.get?.(polygonId);
      if (f?.geometry?.type === 'Polygon') {
        analyzePolygon(polygonId, f);
      }
    }, [analyzePolygon]);

    useImperativeHandle(ref, () => ({
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
    }), [
      polygonResults, polygonFlightLines, polygonTiles, polygonParams,
      cancelAllAnalyses, applyPolygonParams,
      bearingOverrides, importedOriginals,
      importKmlFromText, importWingtraFromText,
      optimizePolygonDirection, revertPolygonToImportedDirection, runFullAnalysis
    ]);

    return (
      <div ref={mapContainer} style={{ position: 'relative', width: '100%', height: '100%' }}>
        {/* Hidden pickers */}
        <input
          ref={kmlInputRef}
          type="file"
          accept=".kml,application/vnd.google-earth.kml+xml"
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
              Drop <strong>.kml</strong> file(s) to import areas
            </div>
          </div>
        )}
      </div>
    );
  }
);
