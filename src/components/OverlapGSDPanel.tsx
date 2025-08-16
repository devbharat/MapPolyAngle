import React, { useCallback, useMemo, useRef, useState } from "react";
import type mapboxgl from "mapbox-gl";
import { OverlapWorker, fetchTerrainRGBA, tilesCoveringPolygon } from "@/overlap/controller";
import { addOrUpdateTileOverlay, clearRunOverlays } from "@/overlap/overlay";
import type { CameraModel, PoseMeters, PolygonLngLatWithId, GSDStats, PolygonTileStats } from "@/overlap/types";
import { lngLatToMeters } from "@/overlap/mercator";
import { sampleCameraPositionsOnFlightPath, build3DFlightPath } from "@/components/MapFlightDirection/utils/geometry";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";

type Props = {
  mapRef: React.RefObject<any>;
  mapboxToken: string;
  /** Provide per‑polygon params (altitude/front/side) so we can compute per‑polygon photoSpacing. */
  getPerPolygonParams?: () => Record<string, { altitudeAGL: number; frontOverlap: number; sideOverlap: number }>;
  onAutoRun?: (autoRunFn: (opts?: { polygonId?: string; reason?: 'lines'|'spacing'|'alt'|'manual' }) => void) => void;
  onClearExposed?: (clearFn: () => void) => void;
};

// Sony RX1R II camera specifications
const sonyRX1R2Camera: CameraModel = {
  f_m: 0.035,          // 35 mm fixed lens
  sx_m: 4.88e-6,       // 4.88 µm pixel pitch (42.4MP full frame)
  sy_m: 4.88e-6,
  w_px: 7952,          // 7952 x 5304 pixels
  h_px: 5304,
};

// Helper function to calculate polygon area in acres
function calculatePolygonAreaAcres(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  
  // Use spherical excess formula for accurate area calculation
  // This is more accurate than the planar shoelace approximation, especially at scale
  const R = 6371008.8; // mean Earth radius in meters
  let sum = 0;
  
  for (let i = 0; i < ring.length; i++) {
    const [λ1, φ1] = ring[i];
    const [λ2, φ2] = ring[(i + 1) % ring.length];
    const lon1 = λ1 * Math.PI / 180;
    const lon2 = λ2 * Math.PI / 180;
    const lat1 = φ1 * Math.PI / 180;
    const lat2 = φ2 * Math.PI / 180;
    sum += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  
  const areaSquareMeters = Math.abs(sum) * R * R / 2;
  
  // Convert to acres (1 acre = 4046.8564224 square meters)
  return areaSquareMeters / 4046.8564224;
}

export function OverlapGSDPanel({ mapRef, mapboxToken, getPerPolygonParams, onAutoRun, onClearExposed }: Props) {
  const [cameraText, setCameraText] = useState(JSON.stringify(sonyRX1R2Camera, null, 2));
  const [altitude, setAltitude] = useState(100); // AGL in meters
  const [frontOverlap, setFrontOverlap] = useState(80); // percentage
  const [sideOverlap, setSideOverlap] = useState(70); // percentage
  const [zoom, setZoom] = useState(15);
  const [opacity, setOpacity] = useState(0.85);
  const [showOverlap, setShowOverlap] = useState(false); // Changed default to false
  const [showGsd, setShowGsd] = useState(true);
  const [running, setRunning] = useState(false);
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [showCameraPoints, setShowCameraPoints] = useState(false); // Changed default to false
  const [gsdStats, setGsdStats] = useState<GSDStats | null>(null);
  const [perPolygonStats, setPerPolygonStats] = useState<Map<string, {
    polygonId: string;
    gsdStats: GSDStats;
    areaAcres: number;
    imageCount: number;
  }>>(new Map());
  
  // Single global runId to avoid stacked overlays - Option B improvement
  const globalRunIdRef = useRef<string | null>(null);
  // Per-polygon, per-tile stats cache for correct cross-polygon crediting - Option B core feature
  const perPolyTileStatsRef = useRef<Map<string, Map<string, PolygonTileStats>>>(new Map());
  // Cache raw tile data (width, height, and cloned pixel data) to avoid ArrayBuffer transfer issues
  const tileCacheRef = useRef<Map<string, { width: number; height: number; data: Uint8ClampedArray }>>(new Map());
  const autoTriesRef = useRef(0);

  // Helper function to generate user-friendly polygon names
  const getPolygonDisplayName = useCallback((polygonId: string): { displayName: string; shortId: string } => {
    const api = mapRef.current;
    if (!api?.getPolygonsWithIds) return { displayName: 'Unknown', shortId: polygonId.slice(0, 8) };
    
    const polygons = api.getPolygonsWithIds();
    const index = polygons.findIndex((p: any) => (p.id || 'unknown') === polygonId);
    
    return {
      displayName: index >= 0 ? `Polygon ${index + 1}` : 'Unknown',
      shortId: polygonId.slice(0, 8)
    };
  }, [mapRef]);

  // Helper function to highlight polygon on map
  const highlightPolygon = useCallback((polygonId: string) => {
    const api = mapRef.current;
    const map = api?.getMap?.();
    if (!map || !api?.getPolygonsWithIds) return;

    const polygons = api.getPolygonsWithIds();
    const targetPolygon = polygons.find((p: any) => (p.id || 'unknown') === polygonId);
    
    if (targetPolygon && targetPolygon.ring?.length >= 4) {
      // Calculate bounds manually and use fitBounds with array format
      const lngs = targetPolygon.ring.map((coord: [number, number]) => coord[0]);
      const lats = targetPolygon.ring.map((coord: [number, number]) => coord[1]);
      
      const minLng = Math.min(...lngs);
      const maxLng = Math.max(...lngs);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      
      // Use the array format for fitBounds: [[minLng, minLat], [maxLng, maxLat]]
      map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
        padding: 50,
        duration: 1000,
        maxZoom: 16
      });

      // Optional: Flash the polygon briefly (could add temporary highlight layer)
      // For now, the map pan/zoom provides visual feedback
    }
  }, [mapRef]);

  const parseCamera = useCallback((): CameraModel | null => {
    try { return JSON.parse(cameraText); } catch { return null; }
  }, [cameraText]);

  // Helper: per‑polygon spacing from camera + altitude/front
  const photoSpacingFor = useCallback((altitudeAGL: number, frontOverlap: number): number => {
    const camera = parseCamera();
    if (!camera) return 60;
    const groundHeight = (camera.h_px * camera.sy_m * altitudeAGL) / camera.f_m;
    return groundHeight * (1 - frontOverlap / 100);
  }, [parseCamera]);

  // Function to aggregate GSD statistics from multiple tiles
  const aggregateGSDStats = useCallback((tileStats: GSDStats[]): GSDStats => {
    if (tileStats.length === 0) {
      return { min: 0, max: 0, mean: 0, count: 0, histogram: [] };
    }

    // Filter out empty stats
    const validStats = tileStats.filter(stat => stat.count > 0);
    if (validStats.length === 0) {
      return { min: 0, max: 0, mean: 0, count: 0, histogram: [] };
    }

    // Calculate overall statistics
    const allMins = validStats.map(s => s.min);
    const allMaxs = validStats.map(s => s.max);
    const totalMin = Math.min(...allMins);
    const totalMax = Math.max(...allMaxs);
    
    // Calculate weighted mean
    let totalSum = 0;
    let totalCount = 0;
    validStats.forEach(stat => {
      totalSum += stat.mean * stat.count;
      totalCount += stat.count;
    });
    const overallMean = totalCount > 0 ? totalSum / totalCount : 0;

    // Improved histogram aggregation to avoid double-counting from overlapping bins
    const numBins = 20;
    const histogram: { bin: number; count: number }[] = Array.from({length: numBins}, (_, i) => ({
      bin: totalMin + (i + 0.5) * (totalMax - totalMin) / numBins,
      count: 0
    }));

    // Map each tile's histogram bins to the global binning scheme
    for (const stat of validStats) {
      if (stat.histogram.length === 0) continue;
      
      const tileRange = stat.max - stat.min || 1;
      const tileBinWidth = tileRange / stat.histogram.length;
      
      for (const {bin, count} of stat.histogram) {
        // Map this bin to the closest global bin
        const globalIdx = Math.max(0, Math.min(
          numBins - 1,
          Math.floor((bin - totalMin) / (totalMax - totalMin) * numBins)
        ));
        histogram[globalIdx].count += count;
      }
    }

    return {
      min: totalMin,
      max: totalMax,
      mean: overallMean,
      count: totalCount,
      histogram
    };
  }, []);

  // Calculate flight parameters from overlap settings
  const calculateFlightParameters = useCallback(() => {
    const camera = parseCamera();
    if (!camera) return { photoSpacing: 60, lineSpacing: 100 };

    // Calculate ground footprint at specified altitude
    const groundWidth = (camera.w_px * camera.sx_m * altitude) / camera.f_m;
    const groundHeight = (camera.h_px * camera.sy_m * altitude) / camera.f_m;

    // Calculate spacing based on overlap percentages
    const photoSpacing = groundHeight * (1 - frontOverlap / 100); // Forward direction
    const lineSpacing = groundWidth * (1 - sideOverlap / 100);    // Side direction

    return { photoSpacing, lineSpacing };
  }, [parseCamera, altitude, frontOverlap, sideOverlap]);

  const { photoSpacing, lineSpacing } = calculateFlightParameters();

  // Generate poses from existing flight lines using 3D paths
  const generatePosesFromFlightLines = useCallback((): PoseMeters[] => {
    const api = mapRef.current;
    if (!api?.getFlightLines || !api?.getPolygonTiles) return [];
    const paramsMap = getPerPolygonParams?.() ?? {};

    const flightLinesMap = api.getFlightLines();
    const tilesMap = api.getPolygonTiles();
    const poses: PoseMeters[] = [];
    let poseId = 0;

    for (const [polygonId, { flightLines, lineSpacing, altitudeAGL }] of flightLinesMap) {
      const tiles = tilesMap.get(polygonId) || [];
      if (flightLines.length === 0 || tiles.length === 0) continue;

      // Use altitude from params map if present, otherwise fall back to what the 3D path used
      const p = paramsMap[polygonId];
      const altForThisPoly = p?.altitudeAGL ?? altitudeAGL ?? 100;
      const photoSpacing = photoSpacingFor(altForThisPoly, p?.frontOverlap ?? 80);

      const path3D = build3DFlightPath(
        flightLines,
        tiles,
        lineSpacing,
        altForThisPoly
      );

      const cameraPositions = sampleCameraPositionsOnFlightPath(path3D, photoSpacing);

      cameraPositions.forEach(([lng, lat, altMSL, yawDeg]) => {
        const [x, y] = lngLatToMeters(lng, lat);
        poses.push({
          id: `photo_${poseId++}`,
          x, y, z: altMSL,
          omega_deg: 0,
          phi_deg: 0,
          kappa_deg: yawDeg
        });
      });
    }
    return poses;
  }, [getPerPolygonParams, mapRef, photoSpacingFor]);

  const parsePosesMeters = useCallback((): PoseMeters[] | null => {
    if (autoGenerate) {
      return generatePosesFromFlightLines();
    }
    // Manual pose entry fallback could go here
    return [];
  }, [autoGenerate, generatePosesFromFlightLines]);

  const getPolygons = useCallback((): PolygonLngLatWithId[] => {
    const api = mapRef.current;
    if (!api?.getPolygonsWithIds) return [];
    return api.getPolygonsWithIds(); // returns { id?: string; ring: [number, number][] }[]
  }, [mapRef]);

  /**
   * Compute GSD/overlap for either:
   *  - a single polygon (opts.polygonId provided), or
   *  - all polygons (default)
   */
  const compute = useCallback(async (opts?: { polygonId?: string }) => {
    const camera = parseCamera();
    const poses = parsePosesMeters();
    const allPolygons = getPolygons();
    const targetPolygons = opts?.polygonId
      ? allPolygons.filter(p => (p.id || 'unknown') === opts.polygonId)
      : allPolygons;

    if (!camera || !poses || poses.length===0 || targetPolygons.length===0) {
      toast({ 
        variant: "destructive", 
        title: "Missing inputs", 
        description: "Please provide valid camera, poses, and draw at least one polygon." 
      });
      return;
    }

    const map: mapboxgl.Map | undefined = mapRef.current?.getMap?.();
    if (!map || !map.isStyleLoaded?.()) {
      toast({ 
        variant: "destructive", 
        title: "Map not ready", 
        description: "Please wait for the map to load completely." 
      });
      return;
    }

    // Option B: Use single global runId to avoid stacked overlays
    const now = Date.now();
    if (!opts?.polygonId) {
      // Full recompute - clear existing overlays
      if (globalRunIdRef.current) clearRunOverlays(map, globalRunIdRef.current);
      globalRunIdRef.current = `${now}`;
    }
    const runId = globalRunIdRef.current ?? `${now}`; // first run fallback
    if (!globalRunIdRef.current) globalRunIdRef.current = runId;

    setRunning(true);
    autoTriesRef.current = 0; // Reset retry counter when starting computation

    const worker = new OverlapWorker();
    try {
      // Collect tiles only for target polygons (dedup)
      const seen = new Set<string>();
      const tiles: {z:number;x:number;y:number}[] = [];
      for (const poly of targetPolygons) {
        for (const t of tilesCoveringPolygon(poly, zoom)) {
          const key = `${t.x}/${t.y}`; if (seen.has(key)) continue;
          seen.add(key); tiles.push({z: zoom, x: t.x, y: t.y});
        }
      }

      // Process tiles and collect per-polygon statistics (only for target polygons)
      const perPolygonResults = new Map<string, PolygonTileStats[]>();

      for (const t of tiles) {
        const cacheKey = `${t.z}/${t.x}/${t.y}`;
        let tileData = tileCacheRef.current.get(cacheKey);
        if (!tileData) {
          const imgData = await fetchTerrainRGBA(t.z, t.x, t.y, mapboxToken);
          // Cache cloned data to avoid ArrayBuffer transfer issues
          tileData = {
            width: imgData.width,
            height: imgData.height,
            data: new Uint8ClampedArray(imgData.data)
          };
          tileCacheRef.current.set(cacheKey, tileData);
          
          // Simple LRU: limit cache size to prevent unbounded memory growth
          const MAX_TILES = 256;
          if (tileCacheRef.current.size > MAX_TILES) {
            const firstKey = tileCacheRef.current.keys().next().value;
            if (firstKey) {
              tileCacheRef.current.delete(firstKey);
            }
          }
        }
        
        // Create a fresh copy for the worker (since ArrayBuffers get transferred/detached)
        const freshData = new Uint8ClampedArray(tileData.data);
        const tile = { z:t.z, x:t.x, y:t.y, size: tileData.width, data: freshData };
        
        // Option B: Always pass ALL polygons so worker can credit hits to every polygon in overlapping tiles
        const res = await worker.runTile({ tile, polygons: allPolygons, poses, camera } as any);

        // Option B: Track per-polygon, per-tile stats for correct cross-crediting
        if (res.perPolygon) {
          for (const polyStats of res.perPolygon) {
            if (!perPolyTileStatsRef.current.has(polyStats.polygonId)) {
              perPolyTileStatsRef.current.set(polyStats.polygonId, new Map());
            }
            perPolyTileStatsRef.current.get(polyStats.polygonId)!.set(cacheKey, polyStats);
          }
        }

        // Group results by polygon ID (for legacy aggregation logic)
        if (res.perPolygon) {
          for (const polyStats of res.perPolygon) {
            if (!perPolygonResults.has(polyStats.polygonId)) {
              perPolygonResults.set(polyStats.polygonId, []);
            }
            perPolygonResults.get(polyStats.polygonId)!.push(polyStats);
          }
        }

        // Use single global runId for overlays
        if (showOverlap) addOrUpdateTileOverlay(map, res, { kind: "overlap", runId, opacity });
        if (showGsd) addOrUpdateTileOverlay(map, res, { kind: "gsd", runId, opacity, gsdMax: 0.1 });
      }      
      // Aggregate statistics per polygon - FIXED: Process ALL polygons that had tiles updated
      const aggregatedPerPolygon = new Map<string, {
        polygonId: string;
        gsdStats: GSDStats;
        areaAcres: number;
        imageCount: number;
      }>();

      // Get all polygons that had any tile stats updated (not just target polygons)
      const allUpdatedPolygonIds = new Set<string>();
      perPolygonResults.forEach((_, polygonId) => allUpdatedPolygonIds.add(polygonId));
      
      // Also include any polygons that were updated in the cache during this run
      perPolyTileStatsRef.current.forEach((_, polygonId) => {
        if (allPolygons.some((p: any) => (p.id || 'unknown') === polygonId)) {
          allUpdatedPolygonIds.add(polygonId);
        }
      });

      // Re-aggregate stats for all affected polygons using the complete tile cache
      allUpdatedPolygonIds.forEach(polygonId => {
        const polygon = allPolygons.find((p: any) => (p.id || 'unknown') === polygonId);
        if (!polygon) return;
        
        const areaAcres = calculatePolygonAreaAcres(polygon.ring);

        // Get all tile stats for this polygon from the cache
        const polygonTileStatsMap = perPolyTileStatsRef.current.get(polygonId);
        if (!polygonTileStatsMap || polygonTileStatsMap.size === 0) return;
        
        const allTileStats = Array.from(polygonTileStatsMap.values());
        const allGsdStats = allTileStats.map(ts => ts.gsdStats).filter(Boolean);
        const aggregatedGsdStats = aggregateGSDStats(allGsdStats);

        // Count unique poses (images) that hit this polygon
        const uniquePoseIds = new Set<number>();
        for (const ts of allTileStats) {
          for (let i = 0; i < ts.hitPoseIds.length; i++) {
            uniquePoseIds.add(ts.hitPoseIds[i]);
          }
        }

        aggregatedPerPolygon.set(polygonId, {
          polygonId,
          gsdStats: aggregatedGsdStats,
          areaAcres,
          imageCount: uniquePoseIds.size
        });
      });

      // Update per‑polygon stats and recompute overall in one consistent step
      setPerPolygonStats(prev => {
        const next = new Map(prev);
        aggregatedPerPolygon.forEach((v, k) => next.set(k, v));
        
        // Recompute overall from the updated map to keep things consistent
        const overall = aggregateGSDStats(
          Array.from(next.values()).map(v => v.gsdStats)
        );
        setGsdStats(overall);
        
        return next;
      });

      // Add camera position markers in 3D
      if (showCameraPoints && poses.length > 0) {
        // Convert poses to 3D coordinates for Deck.gl
        const cameraPositions: [number, number, number][] = poses.map(pose => {
          // Convert EPSG:3857 back to lng/lat for Deck.gl
          const lng = (pose.x / 20037508.34) * 180;
          const lat = (pose.y / 20037508.34) * 180;
          const latRad = Math.atan(Math.exp(lat * (Math.PI / 180))) * 2 - Math.PI / 2;
          const latDeg = latRad * (180 / Math.PI);
          
          return [lng, latDeg, pose.z];
        });

        // Use the new 3D camera point methods
        const api = mapRef.current;
        if (api?.addCameraPoints) {
          const idForCameras = opts?.polygonId ?? '__ALL__';
          api.addCameraPoints(idForCameras, cameraPositions);
        }
      }
    } finally {
      worker.terminate();
      setRunning(false);
    }
  }, [mapRef, mapboxToken, parseCamera, parsePosesMeters, getPolygons, zoom, opacity, showOverlap, showGsd, showCameraPoints]);

  // Auto-run function that can be called externally
  const autoRun = useCallback(async (opts?: { polygonId?: string; reason?: 'lines'|'spacing'|'alt'|'manual' }) => {
    if (!autoGenerate || running) return;
    
    const api = mapRef.current;
    const map = api?.getMap?.();
    const ready = !!map?.isStyleLoaded?.();
    const rings: [number, number][][] = api?.getPolygons?.() ?? [];
    const fl = api?.getFlightLines?.();
    const tiles = api?.getPolygonTiles?.();
    const haveLines = !!fl && (
      opts?.polygonId
        ? !!fl.get(opts.polygonId) && fl.get(opts.polygonId).flightLines.length > 0
        : Array.from(fl.values()).some((v: any) => v.flightLines.length > 0)
    );
    const haveTiles = !!tiles && (
      opts?.polygonId
        ? !!tiles.get(opts.polygonId) && (tiles.get(opts.polygonId)?.length ?? 0) > 0
        : Array.from(tiles.values()).some((t: any) => (t?.length ?? 0) > 0)
    );

    const havePolys = opts?.polygonId ? (api?.getPolygonsWithIds?.() ?? []).some((p:any)=>p.id===opts.polygonId) : (rings.length > 0);

    if (ready && havePolys && haveLines && haveTiles) {
      autoTriesRef.current = 0;
      compute(opts?.polygonId ? { polygonId: opts.polygonId } : undefined); // compute single or all
      return;
    }
    
    // Not ready yet — retry a few times while state settles, but only if not already retrying
    if (autoTriesRef.current < 5) { // Reduced retry count
      autoTriesRef.current += 1;
      setTimeout(() => {
        // Check again if we should still retry (component might have unmounted or conditions changed)
        if (autoGenerate && !running && autoTriesRef.current > 0) {
          autoRun(opts);
        }
      }, 300); // Slightly longer delay
    } else {
      // Reset retry counter after giving up
      autoTriesRef.current = 0;
    }
  }, [autoGenerate, running, compute, mapRef]);

  // Provide autoRun function to parent component - register immediately and on changes
  React.useEffect(() => {
    onAutoRun?.(autoRun);
  }, [autoRun, onAutoRun]);

  const clear = useCallback(() => {
    const map: any = mapRef.current?.getMap?.();
    if (map) {
      // Clear overlays using the current global runId (if exists)
      if (globalRunIdRef.current) {
        clearRunOverlays(map, globalRunIdRef.current);
      }
      
      // Clear all stats cache
      perPolyTileStatsRef.current.clear();
      
      // Generate new global runId for next computation
      const now = Date.now();
      globalRunIdRef.current = `${now}`;
      
      // Clear camera positions using the new 3D camera point methods
      const api = mapRef.current;
      if (api?.removeCameraPoints) {
        api.removeCameraPoints('__ALL__');
      }
      
      // Clear GSD statistics
      setGsdStats(null);
      setPerPolygonStats(new Map());
    }
  }, [mapRef]);

  // Provide clear function to parent component
  React.useEffect(() => {
    onClearExposed?.(clear);
  }, [clear, onClearExposed]);

  return (
    <div className="backdrop-blur-md bg-white/95 rounded-md border p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-900">GSD Analysis</h3>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <label className="text-xs col-span-1">
          <input type="checkbox" checked={showGsd} onChange={e=>setShowGsd(e.target.checked)} className="mr-2" />
          <span className="font-medium">Show GSD (Primary)</span>
        </label>
        {/* Commented out for simplified UI
        <label className="text-xs col-span-1">
          <input type="checkbox" checked={showOverlap} onChange={e=>setShowOverlap(e.target.checked)} className="mr-2" />
          Show overlap count
        </label>
        <label className="text-xs col-span-2">
          <input type="checkbox" checked={showCameraPoints} onChange={e=>setShowCameraPoints(e.target.checked)} className="mr-2" />
          Show camera positions
        </label>
        */}
      </div>

      {/* GSD Statistics and Histogram */}
      {/* Per-Polygon Statistics */}
      {perPolygonStats.size > 0 && (
        <div className="space-y-2">
          {Array.from(perPolygonStats.entries()).map(([polygonId, stats]) => {
            const { displayName, shortId } = getPolygonDisplayName(polygonId);
            
            return (
              <Card 
                key={polygonId} 
                className="mt-2 cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-blue-500" 
                onClick={() => highlightPolygon(polygonId)}
              >
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <span>{displayName}</span>
                    <Badge variant="secondary" className="text-xs font-mono">
                      #{shortId}
                    </Badge>
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Area: {stats.areaAcres.toFixed(2)} acres • Images: {stats.imageCount} • Pixels: {stats.gsdStats.count.toLocaleString()}
                    <br />
                    <span className="text-blue-600">Click to view on map</span>
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Summary Statistics */}
                  <div className="grid grid-cols-3 gap-4 text-xs">
                    <div className="text-center">
                      <div className="font-medium text-green-600">{(stats.gsdStats.min * 100).toFixed(1)} cm</div>
                      <div className="text-gray-500">Min GSD</div>
                    </div>
                    <div className="text-center">
                      <div className="font-medium text-blue-600">{(stats.gsdStats.mean * 100).toFixed(1)} cm</div>
                      <div className="text-gray-500">Mean GSD</div>
                    </div>
                    <div className="text-center">
                      <div className="font-medium text-red-600">{(stats.gsdStats.max * 100).toFixed(1)} cm</div>
                      <div className="text-gray-500">Max GSD</div>
                    </div>
                  </div>

                  {/* Histogram */}
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={stats.gsdStats.histogram.map(bin => ({
                        gsd: (bin.bin * 100).toFixed(1),
                        count: bin.count,
                        gsdValue: bin.bin
                      }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis 
                          dataKey="gsd" 
                          tick={{ fontSize: 10 }}
                          label={{ value: 'GSD (cm)', position: 'insideBottom', offset: -5, style: { fontSize: '10px' } }}
                        />
                        <YAxis 
                          tick={{ fontSize: 10 }}
                          label={{ value: 'Pixel Count', angle: -90, position: 'insideLeft', style: { fontSize: '10px' } }}
                        />
                        <Tooltip 
                          formatter={(value, name) => [value?.toLocaleString(), 'Pixels']}
                          labelFormatter={(label) => `GSD: ${label} cm`}
                          labelStyle={{ fontSize: '11px' }}
                          contentStyle={{ fontSize: '11px' }}
                        />
                        <Bar 
                          dataKey="count" 
                          fill="#8b5cf6" 
                          stroke="#7c3aed"
                          strokeWidth={0.5}
                          radius={[1, 1, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Overall GSD Statistics */}
      {gsdStats && gsdStats.count > 0 && (
        <Card className="mt-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Overall GSD Analysis</CardTitle>
            <CardDescription className="text-xs">
              Cumulative Ground Sample Distance statistics for {gsdStats.count.toLocaleString()} pixels
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Summary Statistics */}
            <div className="grid grid-cols-3 gap-4 text-xs">
              <div className="text-center">
                <div className="font-medium text-green-600">{(gsdStats.min * 100).toFixed(1)} cm</div>
                <div className="text-gray-500">Min GSD</div>
              </div>
              <div className="text-center">
                <div className="font-medium text-blue-600">{(gsdStats.mean * 100).toFixed(1)} cm</div>
                <div className="text-gray-500">Mean GSD</div>
              </div>
              <div className="text-center">
                <div className="font-medium text-red-600">{(gsdStats.max * 100).toFixed(1)} cm</div>
                <div className="text-gray-500">Max GSD</div>
              </div>
            </div>

            {/* Histogram */}
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={gsdStats.histogram.map(bin => ({
                  gsd: (bin.bin * 100).toFixed(1),
                  count: bin.count,
                  gsdValue: bin.bin
                }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis 
                    dataKey="gsd" 
                    tick={{ fontSize: 10 }}
                    label={{ value: 'GSD (cm)', position: 'insideBottom', offset: -5, style: { fontSize: '10px' } }}
                  />
                  <YAxis 
                    tick={{ fontSize: 10 }}
                    label={{ value: 'Pixel Count', angle: -90, position: 'insideLeft', style: { fontSize: '10px' } }}
                  />
                  <Tooltip 
                    formatter={(value, name) => [value?.toLocaleString(), 'Pixels']}
                    labelFormatter={(label) => `GSD: ${label} cm`}
                    labelStyle={{ fontSize: '11px' }}
                    contentStyle={{ fontSize: '11px' }}
                  />
                  <Bar 
                    dataKey="count" 
                    fill="#3b82f6" 
                    stroke="#1e40af"
                    strokeWidth={0.5}
                    radius={[1, 1, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-2">
        {/* Commented out for simplified UI
        <div>
          <div className="text-xs font-medium mb-1">Sony RX1R II Camera</div>
          <textarea className="w-full h-24 border rounded p-2 text-xs font-mono"
                    value={cameraText} onChange={e=>setCameraText(e.target.value)} />
        </div>
        */}
        <div className="space-y-2">
          <div className="text-xs font-medium mb-1">Flight Parameters</div>
          <label className="text-xs text-gray-600 block">
            Altitude AGL (m)
            <input className="w-full border rounded px-2 py-1 text-xs" type="number" 
                   value={altitude} onChange={e=>setAltitude(parseInt(e.target.value||"100"))} />
          </label>
          <label className="text-xs text-gray-600 block">
            Front overlap (%)
            <input className="w-full border rounded px-2 py-1 text-xs" type="number" 
                   min="0" max="95" value={frontOverlap} onChange={e=>setFrontOverlap(parseInt(e.target.value||"80"))} />
          </label>
          <label className="text-xs text-gray-600 block">
            Side overlap (%)
            <input className="w-full border rounded px-2 py-1 text-xs" type="number" 
                   min="0" max="95" value={sideOverlap} onChange={e=>setSideOverlap(parseInt(e.target.value||"70"))} />
          </label>
          {/* Commented out for simplified UI
          <label className="text-xs text-gray-600 block">
            Photo spacing (m) <span className="text-gray-400">(calculated)</span>
            <input className="w-full border rounded px-2 py-1 text-xs bg-gray-100" type="number" 
                   value={photoSpacing.toFixed(1)} readOnly />
          </label>
          <label className="text-xs text-gray-600 block">
            Line spacing (m) <span className="text-gray-400">(calculated)</span>
            <input className="w-full border rounded px-2 py-1 text-xs bg-gray-100" type="number" 
                   value={lineSpacing.toFixed(1)} readOnly />
          </label>
          */}
          <label className="text-xs block">
            <input type="checkbox" checked={autoGenerate} onChange={e=>setAutoGenerate(e.target.checked)} className="mr-2" />
            Auto-generate from polygons
          </label>
          {autoGenerate && (
            <div className="text-xs text-gray-500">
              {parsePosesMeters()?.length || 0} poses generated
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-2 items-center">
        <button
          onClick={() => compute()}
          disabled={running}
          className="h-8 px-2 rounded bg-blue-600 text-white text-xs disabled:opacity-50"
        >
          {running ? "Computing…" : "Manual Compute"}
        </button>
        <button
          onClick={clear}
          className="h-8 px-2 rounded border text-xs"
        >
          Clear overlay
        </button>
      </div>

      <p className="text-[11px] text-gray-500">
        Automatic GSD analysis runs when polygons are created or flight parameters change.
      </p>
    </div>
  );
}

export default OverlapGSDPanel;
