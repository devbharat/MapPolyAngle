import React, { useCallback, useMemo, useRef, useState } from "react";
import type mapboxgl from "mapbox-gl";
import { OverlapWorker, fetchTerrainRGBA, tilesCoveringPolygon } from "@/overlap/controller";
import { addOrUpdateTileOverlay, clearRunOverlays } from "@/overlap/overlay";
import type { CameraModel, PoseMeters, PolygonLngLatWithId, GSDStats, PolygonTileStats } from "@/overlap/types";
import { lngLatToMeters } from "@/overlap/mercator";
import { metersToLngLat } from "@/services/Projection";
import { SONY_RX1R2, DJI_ZENMUSE_P1_24MM, ILX_LR1_INSPECT_85MM, MAP61_17MM, RGB61_24MM } from "@/domain/camera";
import { sampleCameraPositionsOnFlightPath, build3DFlightPath } from "@/components/MapFlightDirection/utils/geometry";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import type { MapFlightDirectionAPI } from "@/components/MapFlightDirection/api";
import { extractPoses, wgs84ToWebMercator, CameraPoseWGS84, extractCameraModel } from "@/utils/djiGeotags";
// Turf types may be unresolved if TS can't find bundled types; cast as any.
// @ts-ignore
import * as turf from '@turf/turf';

type Props = {
  mapRef: React.RefObject<MapFlightDirectionAPI>;
  mapboxToken: string;
  /** Provide per‑polygon params (altitude/front/side) so we can compute per‑polygon photoSpacing. */
  getPerPolygonParams?: () => Record<string, { altitudeAGL: number; frontOverlap: number; sideOverlap: number; cameraKey?: string }> ;
  onAutoRun?: (autoRunFn: (opts?: { polygonId?: string; reason?: 'lines'|'spacing'|'alt'|'manual' }) => void) => void;
  onClearExposed?: (clearFn: () => void) => void;
  // NEW: expose a method so parent (header) can trigger DJI pose JSON import
  onExposePoseImporter?: (openImporter: () => void) => void;
  // NEW: report pose import count to parent so parent can enable panel when only poses exist
  onPosesImported?: (count: number) => void;
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

// NEW: helper for synthetic ring conversion (Spherical Mercator meters -> lng/lat)
const R_SYNTH = 6378137;
function metersBoundsToLngLatRing(minX:number,minY:number,maxX:number,maxY:number):[number,number][] {
  const toLngLat = (x:number,y:number):[number,number] => {
    const lng = (x / R_SYNTH) * 180 / Math.PI;
    const lat = (Math.atan(Math.sinh(y / R_SYNTH)) * 180 / Math.PI);
    return [lng,lat];
  };
  const a = toLngLat(minX,minY);
  const b = toLngLat(maxX,minY);
  const c = toLngLat(maxX,maxY);
  const d = toLngLat(minX,maxY);
  return [a,b,c,d,a];
}

export function OverlapGSDPanel({ mapRef, mapboxToken, getPerPolygonParams, onAutoRun, onClearExposed, onExposePoseImporter, onPosesImported }: Props) {
  const CAMERA_REGISTRY: Record<string, CameraModel> = useMemo(()=>({
    SONY_RX1R2,
    DJI_ZENMUSE_P1_24MM,
    ILX_LR1_INSPECT_85MM,
    MAP61_17MM,
    RGB61_24MM,
  }),[]);

  // Global camera override JSON (optional). If blank, we'll use per‑polygon camera selections.
  const [cameraText, setCameraText] = useState(JSON.stringify(SONY_RX1R2, null, 2));
  const [useOverrideCamera, setUseOverrideCamera] = useState(false);
  const [altitude, setAltitude] = useState(100); // AGL in meters
  const [frontOverlap, setFrontOverlap] = useState(80); // percentage
  const [sideOverlap, setSideOverlap] = useState(70); // percentage
  const [zoom, setZoom] = useState(14);
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
    cameraLabel: string;
  }>>(new Map());
  
  // NEW: poses-only mode state
  const poseFileRef = useRef<HTMLInputElement>(null);
  const [importedPoses, setImportedPoses] = useState<PoseMeters[]>([]);
  const poseAreaRingRef = useRef<[number,number][]>([]);
  // Remember previous polygon rings so we can re-render tiles a moved polygon USED to cover
  const prevPolygonRingsRef = useRef<Map<string, [number, number][]>>(new Map());
  
  // Single global runId to avoid stacked overlays - Option B improvement
  const globalRunIdRef = useRef<string | null>(null);
  // Per-polygon, per-tile stats cache for correct cross-polygon crediting - Option B core feature
  const perPolyTileStatsRef = useRef<Map<string, Map<string, PolygonTileStats>>>(new Map());
  // Cache raw tile data (width, height, and cloned pixel data) to avoid ArrayBuffer transfer issues
  const tileCacheRef = useRef<Map<string, { width: number; height: number; data: Uint8ClampedArray }>>(new Map());
  const autoTriesRef = useRef(0);
  const [clipInnerBufferM, setClipInnerBufferM] = useState(0);
  const [maxTiltDeg, setMaxTiltDeg] = useState(10); // NEW: max allowable camera tilt (deg from vertical)

  // Helper function to generate user-friendly polygon names
  const getPolygonDisplayName = useCallback((polygonId: string): { displayName: string; shortId: string } => {
    if (polygonId === '__POSES__') return { displayName: 'Imported Poses Area', shortId: 'poses' };
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
    if (!map) return;

    if (polygonId === '__POSES__' && poseAreaRingRef.current?.length >= 4) {
      const ring = poseAreaRingRef.current;
      const lngs = ring.map(c=>c[0]);
      const lats = ring.map(c=>c[1]);
      map.fitBounds([[Math.min(...lngs), Math.min(...lats)],[Math.max(...lngs), Math.max(...lats)]], { padding:50, duration:1000, maxZoom:16 });
      return;
    }
    if (!api?.getPolygonsWithIds) return;
    const polygons = api.getPolygonsWithIds();
    const targetPolygon = polygons.find((p: any) => (p.id || 'unknown') === polygonId);
    if (targetPolygon && targetPolygon.ring?.length >= 4) {
      const lngs = targetPolygon.ring.map((coord: [number, number]) => coord[0]);
      const lats = targetPolygon.ring.map((coord: [number, number]) => coord[1]);
      map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding:50, duration:1000, maxZoom:16 });
    }
  }, [mapRef]);

  const parseCameraOverride = useCallback((): CameraModel | null => {
    if (!useOverrideCamera) return null;
    try { const obj = JSON.parse(cameraText); return obj as CameraModel; } catch { return null; }
  }, [cameraText, useOverrideCamera]);

  const effectiveCameraForPolygon = useCallback((polygonId: string, paramsMap: any): CameraModel => {
    const override = parseCameraOverride();
    if (override) return override;
    const p = paramsMap[polygonId];
    if (p?.cameraKey && CAMERA_REGISTRY[p.cameraKey]) return CAMERA_REGISTRY[p.cameraKey];
    return SONY_RX1R2; // fallback
  }, [parseCameraOverride, CAMERA_REGISTRY]);

  // Helper: per‑polygon spacing using that polygon's selected camera
  const photoSpacingFor = useCallback((polygonId: string, altitudeAGL: number, frontOverlap: number, paramsMap: any): number => {
    const cam = effectiveCameraForPolygon(polygonId, paramsMap);
    const groundHeight = (cam.h_px * cam.sy_m * altitudeAGL) / cam.f_m;
    return groundHeight * (1 - frontOverlap / 100);
  }, [effectiveCameraForPolygon]);

  // Function to aggregate GSD statistics from multiple tiles
  const aggregateGSDStats = useCallback((tileStats: GSDStats[]): GSDStats => {
    // Filter valid tile stats
    const valid = tileStats.filter(s => s && s.count > 0 && isFinite(s.min) && isFinite(s.max) && s.max > 0);
    if (valid.length === 0) return { min:0, max:0, mean:0, count:0, totalAreaM2:0, histogram: [] } as any;

    // Global min/max
    let globalMin = +Infinity, globalMax = 0;
    for (const s of valid) { if (s.min < globalMin) globalMin = s.min; if (s.max > globalMax) globalMax = s.max; }
    if (!(globalMax > globalMin)) {
      // Degenerate span -> single bin aggregation
      let totalCount = 0; let totalArea = 0; let sum = 0;
      for (const s of valid) { totalCount += s.count; totalArea += (s.totalAreaM2 || 0); sum += s.mean * s.count; }
      return { min: globalMin, max: globalMax, mean: totalCount>0 ? sum/totalCount : 0, count: totalCount, totalAreaM2: totalArea, histogram: [{ bin: globalMin, count: totalCount, areaM2: totalArea }] } as any;
    }

    const MAX_BINS = 20; // keep UI stable
    const MIN_BIN_SIZE = 0.01; // 1 cm
    let span = globalMax - globalMin;
    let numBins = MAX_BINS;
    if (span / numBins < MIN_BIN_SIZE) {
      numBins = Math.max(1, Math.floor(span / MIN_BIN_SIZE));
      if (numBins < 1) numBins = 1;
    }
    const binSize = span / numBins;
    const bins = new Array<{ bin:number; count:number; areaM2:number }>(numBins);
    for (let i=0;i<numBins;i++) bins[i] = { bin: globalMin + (i+0.5)*binSize, count:0, areaM2:0 };

    let totalCount = 0; let totalArea = 0; let sum = 0;

    // Re-bin each tile's histogram into global layout
    for (const s of valid) {
      totalCount += s.count;
      totalArea += (s.totalAreaM2 || 0);
      sum += s.mean * s.count; // weighted sum for mean
      if (!s.histogram || s.histogram.length === 0) continue;
      for (const hb of s.histogram) {
        if (hb.count === 0) continue;
        const v = hb.bin;
        let bi = Math.floor((v - globalMin) / binSize);
        if (bi < 0) bi = 0; if (bi >= numBins) bi = numBins - 1;
        bins[bi].count += hb.count;
        bins[bi].areaM2 += (hb.areaM2 || 0);
      }
    }

    // If some bins ended with zero area because tile histograms lacked areaM2 (shouldn't now), approximate using pixel size via proportional count * (mean bin area fraction)
    // (Leave as 0 if unknown – UI will show 0)

    return { min: globalMin, max: globalMax, mean: totalCount>0 ? sum/totalCount : 0, count: totalCount, totalAreaM2: totalArea, histogram: bins } as any;
  }, []);

  // Convert histogram to area series (areaM2 already provided per bin)
  const convertHistogramToArea = useCallback((stats: GSDStats): { bin: number; areaM2: number }[] => {
    if (!stats || !stats.histogram.length) return [];
    return stats.histogram.map(h => ({ bin: h.bin, areaM2: h.areaM2 || 0 }));
  }, []);
  
  const ACRE_M2 = 4046.8564224;

  // Calculate flight parameters from overlap settings
  const calculateFlightParameters = useCallback(() => {
    const override = parseCameraOverride();
    const cam = override || SONY_RX1R2;
    const groundWidth = (cam.w_px * cam.sx_m * altitude) / cam.f_m;
    const groundHeight = (cam.h_px * cam.sy_m * altitude) / cam.f_m;
    const photoSpacing = groundHeight * (1 - frontOverlap / 100);
    const lineSpacing = groundWidth * (1 - sideOverlap / 100);
    return { photoSpacing, lineSpacing, camLabel: useOverrideCamera ? 'Override' : 'Default' };
  }, [parseCameraOverride, altitude, frontOverlap, sideOverlap, useOverrideCamera]);

  const { photoSpacing, lineSpacing } = calculateFlightParameters();

  // Generate poses from existing flight lines using 3D paths
  const generatePosesFromFlightLines = useCallback((): PoseMeters[] => {
    const api = mapRef.current;
    if (!api?.getFlightLines || !api?.getPolygonTiles) return [];

    // MERGE: internal Map params (from importer / dialog) + external overrides from Home
    const internalParams = api.getPerPolygonParams?.() ?? {};
    const externalParams = getPerPolygonParams?.() ?? {};
    const paramsMap = { ...internalParams, ...externalParams };

    const flightLinesMap = api.getFlightLines();
    const tilesMap = api.getPolygonTiles();
    const poses: PoseMeters[] = [];
    let poseId = 0;

    for (const [polygonId, { flightLines, lineSpacing, altitudeAGL }] of Array.from(flightLinesMap.entries())) {
      const tiles = tilesMap.get(polygonId) || [];
      if (flightLines.length === 0 || tiles.length === 0) continue;

      const p = (paramsMap as any)[polygonId];
      const altForThisPoly = p?.altitudeAGL ?? altitudeAGL ?? 100;
      const front = p?.frontOverlap ?? 80;
      const spacingForward = photoSpacingFor(polygonId, altForThisPoly, front, paramsMap);

      const path3D = build3DFlightPath(
        flightLines,
        tiles,
        lineSpacing,
        altForThisPoly
      );

      const cameraPositions = sampleCameraPositionsOnFlightPath(path3D, spacingForward);

      cameraPositions.forEach(([lng, lat, altMSL, yawDeg]) => {
        const [x, y] = lngLatToMeters(lng, lat);
        poses.push({
          id: `photo_${poseId++}`,
          x, y, z: altMSL,
          omega_deg: 0,
          phi_deg: 0,
          kappa_deg: yawDeg,
          polygonId // tag pose with polygon for per‑camera assignment
        });
      });
    }
    return poses;
  }, [getPerPolygonParams, mapRef, photoSpacingFor]);

  const parsePosesMeters = useCallback((): PoseMeters[] | null => {
    const base = autoGenerate ? generatePosesFromFlightLines() : (importedPoses.length ? importedPoses : []);
    if (!base) return [];
    // NEW: filter poses by tilt (sqrt(omega^2 + phi^2) ~ small-angle off-nadir approximation)
    const filtered = maxTiltDeg >= 0 ? base.filter(p => {
      const tilt = Math.sqrt((p.omega_deg||0)*(p.omega_deg||0) + (p.phi_deg||0)*(p.phi_deg||0));
      return tilt <= maxTiltDeg;
    }) : base;
    return filtered;
  }, [autoGenerate, generatePosesFromFlightLines, importedPoses, maxTiltDeg]);

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
    const api = mapRef.current;
    const internalParams = api?.getPerPolygonParams?.() ?? {};
    const externalParams = getPerPolygonParams?.() ?? {};
    const paramsMap = { ...internalParams, ...externalParams };
    const overrideCam = parseCameraOverride();
    // Build per-polygon camera mapping
    const perPolyCam: Record<string, CameraModel> = {};
    Object.entries(paramsMap).forEach(([pid, p]: any) => {
      if (p?.cameraKey && CAMERA_REGISTRY[p.cameraKey]) perPolyCam[pid] = CAMERA_REGISTRY[p.cameraKey];
    });
    const identifyCameraKey = (cam: CameraModel | null): string | null => {
      if (!cam) return null;
      for (const [key, m] of Object.entries(CAMERA_REGISTRY)) {
        if (m.w_px === cam.w_px && m.h_px === cam.h_px && Math.abs(m.f_m - cam.f_m)/m.f_m < 0.02) return key;
      }
      return null;
    };
    const overrideCamKey = overrideCam ? identifyCameraKey(overrideCam) : null;
    const poses = parsePosesMeters();
    // Derive cameras + indices for worker
    let camerasArr: CameraModel[] | undefined; let poseIdxArr: Uint16Array | undefined;
    if (poses && poses.length) {
      const camObjToIndex = new Map<CameraModel, number>();
      const cams: CameraModel[] = [];
      const indices = new Uint16Array(poses.length);
      for (let i=0;i<poses.length;i++) {
        const pose = poses[i];
        let cam: CameraModel | undefined = undefined;
        if (overrideCam && typeof overrideCam === 'object' && 'f_m' in overrideCam) {
          cam = overrideCam as CameraModel;
        } else if (pose.polygonId && perPolyCam[pose.polygonId]) {
          cam = perPolyCam[pose.polygonId];
        }
        if (!cam) cam = SONY_RX1R2;
        if (!camObjToIndex.has(cam)) { camObjToIndex.set(cam, cams.length); cams.push(cam); }
        indices[i] = camObjToIndex.get(cam)!;
      }
      if (overrideCam && typeof overrideCam === 'object' && 'f_m' in overrideCam) {
        camerasArr = [cams[0]]; // override forces single camera
        poseIdxArr = new Uint16Array(poses.length); // zeros
      } else if (cams.length > 1) {
        camerasArr = cams; poseIdxArr = indices; // multi-camera
      } else {
        camerasArr = [cams[0]]; poseIdxArr = new Uint16Array(poses.length);
      }
    }
    // All polygons currently on the map
    let allPolygons = getPolygons();
    let tilesSourcePolygons: PolygonLngLatWithId[] = opts?.polygonId ? allPolygons.filter(p => (p.id || 'unknown') === opts.polygonId) : allPolygons;
    if (tilesSourcePolygons.length === 0 && poses && poses.length > 0) {
      const buildPosesAOIRing = (poses: PoseMeters[]): [number,number][] => {
        if (!poses || poses.length < 3) return [];
        const MAX_POINTS = 2000;
        const step = Math.max(1, Math.floor(poses.length / MAX_POINTS));
        const pts = poses.filter((_,i)=> i % step === 0).map(p=>{ const [lng, lat] = metersToLngLat(p.x, p.y); return turf.point([lng, lat]); });
        const fc = turf.featureCollection(pts); const hull = turf.convex(fc); if (!hull) return [];
        const geom: any = (hull as any).geometry; return geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
      };
      const ring = poseAreaRingRef.current?.length ? poseAreaRingRef.current : buildPosesAOIRing(poses);
      poseAreaRingRef.current = ring;
      if (ring.length >= 4) {
        const synth = { id: '__POSES__', ring } as PolygonLngLatWithId;
        allPolygons = [synth];
        tilesSourcePolygons = [synth];
      }
    }

    // Polygons used inside worker for union mask + per‑polygon stats (ALWAYS all current polygons)
    const polygonsForWorker: PolygonLngLatWithId[] = allPolygons;

    if (!poses || poses.length===0 || allPolygons.length===0) {
      toast({ variant: 'destructive', title: 'Missing inputs', description: 'Provide poses (or draw/import an area).' });
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
      // Collect tiles only for tilesSourcePolygons (dedup by z/x/y)
      const seen = new Set<string>();
      const tiles: {z:number;x:number;y:number}[] = [];
      for (const poly of tilesSourcePolygons) {
        for (const t of tilesCoveringPolygon(poly, zoom)) {
          const key = `${zoom}/${t.x}/${t.y}`; if (seen.has(key)) continue; seen.add(key); tiles.push({z: zoom, x: t.x, y: t.y});
        }
      }
      // Also include tiles from the PREVIOUS ring of this polygon (if this is a targeted edit)
      if (opts?.polygonId) {
        const prevRing = prevPolygonRingsRef.current.get(opts.polygonId);
        if (prevRing && prevRing.length >= 4) {
          const prevPoly = { id: opts.polygonId, ring: prevRing } as PolygonLngLatWithId;
            for (const t of tilesCoveringPolygon(prevPoly, zoom)) {
              const key = `${zoom}/${t.x}/${t.y}`; if (seen.has(key)) continue; seen.add(key); tiles.push({ z: zoom, x: t.x, y: t.y });
            }
        }
      }
      // Process tiles and collect per-polygon statistics
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
          const MAX_TILES = 256; // simple LRU trim
          if (tileCacheRef.current.size > MAX_TILES) {
            const firstKey = tileCacheRef.current.keys().next().value; if (firstKey) tileCacheRef.current.delete(firstKey);
          }
        }
        const freshData = new Uint8ClampedArray(tileData.data);
        const tile = { z:t.z, x:t.x, y:t.y, size: tileData.width, data: freshData };

        // Always pass ALL polygons so each tile overlay is the union of all current areas
        const res = await worker.runTile({ tile, polygons: polygonsForWorker, poses, cameras: camerasArr, poseCameraIndices: poseIdxArr, camera: (!camerasArr || camerasArr.length===0)? undefined : undefined, options: { clipInnerBufferM } } as any);

        if (res.perPolygon) {
          for (const polyStats of res.perPolygon) {
            if (!perPolyTileStatsRef.current.has(polyStats.polygonId)) {
              perPolyTileStatsRef.current.set(polyStats.polygonId, new Map());
            }
            perPolyTileStatsRef.current.get(polyStats.polygonId)!.set(cacheKey, polyStats);
          }
          for (const polyStats of res.perPolygon) {
            if (!perPolygonResults.has(polyStats.polygonId)) {
              perPolygonResults.set(polyStats.polygonId, []);
            }
            perPolygonResults.get(polyStats.polygonId)!.push(polyStats);
          }
        }

        if (showOverlap) addOrUpdateTileOverlay(map, res, { kind: "overlap", runId, opacity });
        if (showGsd) addOrUpdateTileOverlay(map, res, { kind: "gsd", runId, opacity, gsdMax: 0.1 });
      }

      // --- PRUNE STALE TILES (tiles no longer under ANY current polygon) ---
      // Build set of needed tile keys for all CURRENT polygons at this zoom.
      const currentPolysForPrune = getPolygons();
      const neededTileKeys = new Set<string>();
      for (const poly of currentPolysForPrune) {
        for (const t of tilesCoveringPolygon(poly, zoom)) {
          neededTileKeys.add(`${zoom}/${t.x}/${t.y}`);
        }
      }
      // If poses-only synthetic AOI active
      if (currentPolysForPrune.length === 0 && poseAreaRingRef.current.length >= 4) {
        // derive needed tiles from synthetic ring
        const synthPoly: PolygonLngLatWithId = { id: '__POSES__', ring: poseAreaRingRef.current };
        for (const t of tilesCoveringPolygon(synthPoly, zoom)) neededTileKeys.add(`${zoom}/${t.x}/${t.y}`);
      }
      // Remove overlay layers/sources whose tile key not needed
      const styleLayers = map.getStyle()?.layers ?? [];
      const toRemove: string[] = [];
      for (const layer of styleLayers) {
        const id = layer.id;
        if (!id.startsWith(`ogsd-${runId}-`)) continue;
        const parts = id.split('-');
        if (parts.length < 6) continue; // expect ogsd, runId, kind, z, x, y
        const zStr = parts[parts.length - 3];
        const xStr = parts[parts.length - 2];
        const yStr = parts[parts.length - 1];
        const key = `${zStr}/${xStr}/${yStr}`;
        if (!neededTileKeys.has(key)) toRemove.push(id);
      }
      for (const id of toRemove) {
        try {
          if (map.getLayer(id)) map.removeLayer(id);
          if (map.getSource(id)) map.removeSource(id);
        } catch { /* ignore */ }
      }
      // Drop cached per-polygon tile stats for pruned tiles
      perPolyTileStatsRef.current.forEach(tileMap => {
        for (const k of Array.from(tileMap.keys())) {
          if (!neededTileKeys.has(k)) tileMap.delete(k);
        }
      });
      // --- END PRUNE ---

      // Aggregate statistics per polygon - process all polygons that had tiles updated
      const aggregatedPerPolygon = new Map<string, {
        polygonId: string;
        gsdStats: GSDStats;
        areaAcres: number;
        imageCount: number;
        cameraLabel: string;
      }>();

      const allUpdatedPolygonIds = new Set<string>();
      perPolygonResults.forEach((_, polygonId) => allUpdatedPolygonIds.add(polygonId));
      perPolyTileStatsRef.current.forEach((_, polygonId) => {
        if (polygonsForWorker.some((p: any) => (p.id || 'unknown') === polygonId) || polygonId==='__POSES__') {
          allUpdatedPolygonIds.add(polygonId);
        }
      });

      allUpdatedPolygonIds.forEach(polygonId => {
        const polygon = polygonsForWorker.find((p: any) => (p.id || 'unknown') === polygonId) || (polygonId==='__POSES__' && poseAreaRingRef.current.length? { id:'__POSES__', ring: poseAreaRingRef.current }: null);
        if (!polygon) return;
        const areaAcres = calculatePolygonAreaAcres(polygon.ring);
        const polygonTileStatsMap = perPolyTileStatsRef.current.get(polygonId);
        if (!polygonTileStatsMap || polygonTileStatsMap.size === 0) return;
        const allTileStats = Array.from(polygonTileStatsMap.values());
        const allGsdStats = allTileStats.map(ts => ts.gsdStats).filter(Boolean);
        const aggregatedGsdStats = aggregateGSDStats(allGsdStats);
        const uniquePoseIds = new Set<number>();
        for (const ts of allTileStats) for (let i=0;i<ts.hitPoseIds.length;i++) uniquePoseIds.add(ts.hitPoseIds[i]);
        // Determine camera label used
        let cameraLabel: string;
        if (overrideCam) {
          cameraLabel = overrideCamKey ? `Override (${overrideCamKey})` : 'Override';
        } else {
          const params = (paramsMap as any)[polygonId];
          cameraLabel = params?.cameraKey || 'SONY_RX1R2';
        }
        aggregatedPerPolygon.set(polygonId, { polygonId, gsdStats: aggregatedGsdStats, areaAcres, imageCount: uniquePoseIds.size, cameraLabel });
      });

      setPerPolygonStats(prev => {
        const next = new Map(prev);
        aggregatedPerPolygon.forEach((v, k) => next.set(k, v));
        const overall = aggregateGSDStats(Array.from(next.values()).map(v => v.gsdStats));
        setGsdStats(overall);
        return next;
      });

      if (showCameraPoints && poses.length > 0) {
        const cameraPositions: [number, number, number][] = poses.map(pose => {
          const [lng, lat] = metersToLngLat(pose.x, pose.y); return [lng, lat, pose.z];
        });
        const api = mapRef.current; if (api?.addCameraPoints) { const idForCameras = opts?.polygonId ?? '__ALL__'; api.addCameraPoints(idForCameras, cameraPositions); }
      }

      // Update previous rings snapshot AFTER successful tile updates so next edit invalidates correctly
      prevPolygonRingsRef.current = new Map((getPolygons()).map(p => [p.id || 'unknown', p.ring] as const));
    } finally {
      worker.terminate();
      setRunning(false);
    }
  }, [mapRef, getPerPolygonParams, parseCameraOverride, parsePosesMeters, getPolygons, zoom, opacity, showOverlap, showGsd, showCameraPoints, clipInnerBufferM, altitude]);

  // Auto-run function that can be called externally
  const autoRun = useCallback(async (opts?: { polygonId?: string; reason?: 'lines'|'spacing'|'alt'|'manual' }) => {
    if (running) return;
    const api = mapRef.current;
    const map = api?.getMap?.();
    const ready = !!map?.isStyleLoaded?.();

    // Poses-only mode auto-run
    if (!autoGenerate && importedPoses.length > 0) {
      if (ready) {
        autoTriesRef.current = 0;
        compute();
        return;
      }
    }

    if (!autoGenerate) return; // nothing else to auto-run

    const rings: [number, number][][] = api?.getPolygons?.() ?? [];
    const fl = api?.getFlightLines?.();
    const tiles = api?.getPolygonTiles?.();
    const haveLines = !!fl && (
      opts?.polygonId
        ? !!fl.get(opts.polygonId) && fl.get(opts.polygonId)!.flightLines.length > 0
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
      compute(opts?.polygonId ? { polygonId: opts.polygonId } : undefined);
      return;
    }
    if (autoTriesRef.current < 5) {
      autoTriesRef.current += 1;
      setTimeout(()=>{ if ((autoGenerate || importedPoses.length>0) && !running) autoRun(opts); }, 300);
    } else { autoTriesRef.current = 0; }
  }, [running, autoGenerate, importedPoses, compute, mapRef]);

  // Provide autoRun function to parent component - register immediately and on changes
  React.useEffect(() => {
    onAutoRun?.(autoRun);
  }, [autoRun, onAutoRun]);

  const clear = useCallback(() => {
    const map: any = mapRef.current?.getMap?.();
    if (map) {
      if (globalRunIdRef.current) clearRunOverlays(map, globalRunIdRef.current);
      perPolyTileStatsRef.current.clear();
      const now = Date.now();
      globalRunIdRef.current = `${now}`;
      const api = mapRef.current;
      if (api?.removeCameraPoints) {
        api.removeCameraPoints('__ALL__');
        api.removeCameraPoints('__POSES__');
      }
      setImportedPoses([]);
      poseAreaRingRef.current = [];
      setGsdStats(null);
      setPerPolygonStats(new Map());
      onPosesImported?.(0); // notify parent
    }
  }, [mapRef, onPosesImported]);

  const handlePoseFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const text = evt.target?.result as string;
        const posesWgs = extractPoses(text);
        const djiCam = extractCameraModel(text);
        let matchedRegistryKey: string | null = null;
        if (djiCam) {
          // Try to match against known cameras (same dimensions + ~5% focal length tolerance)
          for (const [key, cam] of Object.entries(CAMERA_REGISTRY)) {
            if (cam.w_px === djiCam.w_px && cam.h_px === djiCam.h_px) {
              const relErr = Math.abs(cam.f_m - djiCam.f_m) / cam.f_m;
              if (relErr < 0.05) { matchedRegistryKey = key; break; }
            }
          }
          if (matchedRegistryKey) {
            console.log(`Matched DJI camera to registry key: ${matchedRegistryKey}`);
            setCameraText(JSON.stringify(CAMERA_REGISTRY[matchedRegistryKey], null, 2));
          } else {
            setCameraText(JSON.stringify(djiCam, null, 2));
          }
          // Auto‑enable override so imported intrinsics are actually used
          setUseOverrideCamera(true);
        }
        const posesMeters: PoseMeters[] = posesWgs.map((p, i) => {
          const { x, y } = wgs84ToWebMercator(p.lat, p.lon);
            return { id: p.id ?? `pose_${i}`, x, y, z: p.alt ?? 0, omega_deg: p.roll ?? 0, phi_deg: p.pitch ?? 0, kappa_deg: p.yaw ?? 0 } as PoseMeters;
        });
        setImportedPoses(posesMeters);
        if (posesMeters.length) {
          poseAreaRingRef.current = []; // force rebuild in compute via AOI function
        }
        setAutoGenerate(false);
        setShowCameraPoints(true);
        toast({ title: "Imported poses", description: `${posesMeters.length} camera poses loaded${djiCam ? (matchedRegistryKey ? ` using ${matchedRegistryKey} camera.` : ' with camera intrinsics.') : '.'}` });
        onPosesImported?.(posesMeters.length);
        setTimeout(()=>{ if (poseAreaRingRef.current.length>=4) { const api = mapRef.current; const map = api?.getMap?.(); if(map){ const ring=poseAreaRingRef.current; const lngs=ring.map(c=>c[0]); const lats=ring.map(c=>c[1]); map.fitBounds([[Math.min(...lngs), Math.min(...lats)],[Math.max(...lngs), Math.max(...lats)]], { padding:50, duration:800, maxZoom:16 }); } } }, 30);
      } catch (error) {
        toast({ variant: "destructive", title: "Invalid file", description: "Unable to parse DJI OPF input_cameras.json" });
        onPosesImported?.(0);
      }
    };
    reader.readAsText(file);
  }, [mapRef, onPosesImported, CAMERA_REGISTRY]);

  React.useEffect(()=>{
    if (onExposePoseImporter) {
      onExposePoseImporter(()=>{ poseFileRef.current?.click(); });
    }
  }, [onExposePoseImporter]);

  // Auto-compute when imported poses arrive (poses-only mode)
  React.useEffect(()=>{
    if (!autoGenerate && importedPoses.length>0) {
      const attempt = () => {
        const map = mapRef.current?.getMap?.();
        if (map?.isStyleLoaded?.()) compute(); else setTimeout(attempt, 200);
      };
      attempt();
    }
  }, [importedPoses.length, autoGenerate, compute, mapRef]);

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
      </div>

      {/* Per-Polygon Statistics */}
      {perPolygonStats.size > 0 && (
        <div className="space-y-2">
          {Array.from(perPolygonStats.entries()).map(([polygonId, stats]) => {
            const { displayName, shortId } = getPolygonDisplayName(polygonId);
            return (
              <Card key={polygonId} className="mt-2 cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-blue-500" onClick={() => highlightPolygon(polygonId)}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <span>{displayName}</span>
                    <Badge variant="secondary" className="text-xs font-mono">#{shortId}</Badge>
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Area: {stats.areaAcres.toFixed(2)} acres • Images: {stats.imageCount} • Camera: {stats.cameraLabel} • Pixels: {stats.gsdStats.count.toLocaleString()}<br />
                    <span className="text-blue-600">Click to view on map</span>
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-3 gap-4 text-xs">
                    <div className="text-center"><div className="font-medium text-green-600">{(stats.gsdStats.min * 100).toFixed(1)} cm</div><div className="text-gray-500">Min GSD</div></div>
                    <div className="text-center"><div className="font-medium text-blue-600">{(stats.gsdStats.mean * 100).toFixed(1)} cm</div><div className="text-gray-500">Mean GSD</div></div>
                    <div className="text-center"><div className="font-medium text-red-600">{(stats.gsdStats.max * 100).toFixed(1)} cm</div><div className="text-gray-500">Max GSD</div></div>
                  </div>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={convertHistogramToArea(stats.gsdStats).map(bin => ({ gsd: (bin.bin * 100).toFixed(1), areaM2: bin.areaM2, areaAcres: bin.areaM2 / ACRE_M2 }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis dataKey="gsd" tick={{ fontSize: 10 }} label={{ value: 'GSD (cm)', position: 'insideBottom', offset: -5, style: { fontSize: '10px' } }} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={(v:number)=> (v/ACRE_M2).toFixed(2)} label={{ value: 'Area (acres)', angle: -90, position: 'insideLeft', style: { fontSize: '10px' } }} />
                        <Tooltip formatter={(value)=>{ const m2=value as number; const acres=m2/ACRE_M2; return [`${acres.toFixed(2)} acres (${m2.toFixed(0)} m²)`, 'Area']; }} labelFormatter={(label)=>`GSD: ${label} cm`} labelStyle={{ fontSize: '11px' }} contentStyle={{ fontSize: '11px' }} />
                        <Bar dataKey="areaM2" fill="#8b5cf6" stroke="#7c3aed" strokeWidth={0.5} radius={[1,1,0,0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {gsdStats && gsdStats.count > 0 && (
        <Card className="mt-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Overall GSD Analysis</CardTitle>
            <CardDescription className="text-xs">Cumulative Ground Sample Distance statistics for {gsdStats.count.toLocaleString()} pixels</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4 text-xs">
              <div className="text-center"><div className="font-medium text-green-600">{(gsdStats.min * 100).toFixed(1)} cm</div><div className="text-gray-500">Min GSD</div></div>
              <div className="text-center"><div className="font-medium text-blue-600">{(gsdStats.mean * 100).toFixed(1)} cm</div><div className="text-gray-500">Mean GSD</div></div>
              <div className="text-center"><div className="font-medium text-red-600">{(gsdStats.max * 100).toFixed(1)} cm</div><div className="text-gray-500">Max GSD</div></div>
            </div>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={convertHistogramToArea(gsdStats).map(bin => ({ gsd: (bin.bin * 100).toFixed(1), areaM2: bin.areaM2, areaAcres: bin.areaM2 / ACRE_M2 }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="gsd" tick={{ fontSize: 10 }} label={{ value: 'GSD (cm)', position: 'insideBottom', offset: -5, style: { fontSize: '10px' } }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v:number)=> (v/ACRE_M2).toFixed(2)} label={{ value: 'Area (acres)', angle: -90, position: 'insideLeft', style: { fontSize: '10px' } }} />
                  <Tooltip formatter={(value)=>{ const m2=value as number; const acres=m2/ACRE_M2; return [`${acres.toFixed(2)} acres (${m2.toFixed(0)} m²)`, 'Area']; }} labelFormatter={(label)=>`GSD: ${label} cm`} labelStyle={{ fontSize: '11px' }} contentStyle={{ fontSize: '11px' }} />
                  <Bar dataKey="areaM2" fill="#3b82f6" stroke="#1e40af" strokeWidth={0.5} radius={[1,1,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-2">
        <div className="space-y-2">
          <div className="text-xs font-medium">Poses (optional)</div>
          <div className="flex items-center gap-2">
            <button className="h-8 px-2 rounded border text-xs" onClick={()=>poseFileRef.current?.click()} title="Import camera poses from JSON" id="poses-json-input-proxy">Import poses (JSON)</button>
            <input ref={poseFileRef} type="file" accept=".json,application/json" onChange={(e)=>{ handlePoseFileChange(e); }} style={{ display:'none' }} />
            <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={autoGenerate} onChange={e=>setAutoGenerate(e.target.checked)} />Auto-generate</label>
          </div>
          {!autoGenerate && (<div className="text-[11px] text-gray-600">{importedPoses.length ? `${importedPoses.length.toLocaleString()} poses imported` : 'No poses imported yet'}</div>)}
        </div>
        <div className="space-y-2">
          <div className="text-xs font-medium mb-1">Flight Parameters</div>
          <label className="text-xs text-gray-600 block">Altitude AGL (m)<input className="w-full border rounded px-2 py-1 text-xs" type="number" value={altitude} onChange={e=>setAltitude(parseInt(e.target.value||'100'))} /></label>
          <label className="text-xs text-gray-600 block">Front overlap (%)<input className="w-full border rounded px-2 py-1 text-xs" type="number" min={0} max={95} value={frontOverlap} onChange={e=>setFrontOverlap(parseInt(e.target.value||'80'))} /></label>
            <label className="text-xs text-gray-600 block">Side overlap (%)<input className="w-full border rounded px-2 py-1 text-xs" type="number" min={0} max={95} value={sideOverlap} onChange={e=>setSideOverlap(parseInt(e.target.value||'70'))} /></label>
          <label className="text-xs text-gray-600 block">Max tilt (deg)<input className="w-full border rounded px-2 py-1 text-xs" type="number" min={0} max={90} value={maxTiltDeg} onChange={e=>setMaxTiltDeg(Math.max(0, Math.min(90, parseFloat(e.target.value||'10'))))} /></label>
          <label className="text-xs text-gray-600 block">DEM zoom (tile level)<input className="w-full border rounded px-2 py-1 text-xs" type="number" min={8} max={16} value={zoom} onChange={e=>setZoom(Math.max(8, Math.min(16, parseInt(e.target.value||'14'))))} /></label>
          <label className="text-xs text-gray-600 block">Clip edge (m)<input className="w-full border rounded px-2 py-1 text-xs" type="number" min={0} value={clipInnerBufferM} onChange={e=>setClipInnerBufferM(Math.max(0, parseFloat(e.target.value||'0')))} /></label>
          {autoGenerate && <div className="text-xs text-gray-500">{parsePosesMeters()?.length || 0} poses generated</div>}
        </div>
      </div>

      <div className="flex gap-2 items-center">
        <button onClick={() => compute()} disabled={running} className="h-8 px-2 rounded bg-blue-600 text-white text-xs disabled:opacity-50">{running ? 'Computing…' : 'Manual Compute'}</button>
        <button onClick={clear} className="h-8 px-2 rounded border text-xs">Clear overlay</button>
      </div>

      <p className="text-[11px] text-gray-500">Automatic GSD analysis runs when polygons are created or flight parameters change.</p>
    </div>
  );
}

export default OverlapGSDPanel;
