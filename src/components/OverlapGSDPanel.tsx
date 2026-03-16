import React, { useCallback, useMemo, useRef, useState } from "react";
import type mapboxgl from "mapbox-gl";
import { LidarDensityWorker, OverlapWorker, fetchTerrainRGBA, tilesCoveringPolygon } from "@/overlap/controller";
import { addOrUpdateTileOverlay, clearRunOverlays, clearAllOverlays } from "@/overlap/overlay";
import type { CameraModel, PoseMeters, PolygonLngLatWithId, GSDStats, PolygonTileStats, LidarStripMeters } from "@/overlap/types";
import { lngLatToMeters, tileMetersBounds } from "@/overlap/mercator";
import { metersToLngLat } from "@/services/Projection";
import { SONY_RX1R2, DJI_ZENMUSE_P1_24MM, ILX_LR1_INSPECT_85MM, MAP61_17MM, RGB61_24MM, forwardSpacingRotated } from "@/domain/camera";
import { DEFAULT_LIDAR_MAX_RANGE_M, getLidarMappingFovDeg, getLidarModel, lidarDeliverableDensity, lidarSinglePassDensity, lidarSwathWidth } from "@/domain/lidar";
import { sampleCameraPositionsOnFlightPath, build3DFlightPath, extendFlightLineForTurnRunout, queryMinMaxElevationAlongPolylineWGS84 } from "@/components/MapFlightDirection/utils/geometry";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import type { MapFlightDirectionAPI } from "@/components/MapFlightDirection/api";
import { extractPoses, wgs84ToWebMercator, CameraPoseWGS84, extractCameraModel } from "@/utils/djiGeotags";
import type { PolygonAnalysisResult } from "@/components/MapFlightDirection/types";
// Turf types may be unresolved if TS can't find bundled types; cast as any.
// @ts-ignore
import * as turf from '@turf/turf';

type Props = {
  mapRef: React.RefObject<MapFlightDirectionAPI>;
  mapboxToken: string;
  /** Provide per‑polygon params (altitude/front/side) so we can compute per‑polygon photoSpacing. */
  getPerPolygonParams?: () => Record<string, { altitudeAGL: number; frontOverlap: number; sideOverlap: number; cameraKey?: string; triggerDistanceM?: number; payloadKind?: 'camera' | 'lidar'; lidarKey?: string; speedMps?: number; lidarReturnMode?: 'single' | 'dual' | 'triple'; mappingFovDeg?: number; maxLidarRangeM?: number; pointDensityPtsM2?: number }> ;
  onEditPolygonParams?: (polygonId: string) => void;
  onAutoRun?: (autoRunFn: (opts?: { polygonId?: string; reason?: 'lines'|'spacing'|'alt'|'manual' }) => void) => void;
  onClearExposed?: (clearFn: () => void) => void;
  // NEW: expose a method so parent (header) can trigger DJI / Wingtra pose JSON import
  onExposePoseImporter?: (openImporter: (mode?: 'dji' | 'wingtra') => void) => void;
  // NEW: report pose import count to parent so parent can enable panel when only poses exist
  onPosesImported?: (count: number) => void;
  polygonAnalyses: PolygonAnalysisResult[];
  overrides: Record<string, { bearingDeg: number; lineSpacingM?: number; source: 'wingtra' | 'user' }>;
  importedOriginals: Record<string, { bearingDeg: number; lineSpacingM: number }>;
  selectedPolygonId?: string | null;
  onSelectPolygon?: (id: string | null) => void;
};

type MetricKind = 'gsd' | 'density';

type PolygonMetricSummary = {
  polygonId: string;
  metricKind: MetricKind;
  stats: GSDStats;
  areaAcres: number;
  sampleCount: number;
  sampleLabel: string;
  sourceLabel: string;
};

type OverallMetricStats = {
  gsd: GSDStats | null;
  density: GSDStats | null;
};

function lidarComparisonLabel(mode?: 'first-return' | 'all-returns') {
  return mode === 'all-returns' ? 'All returns' : 'First return';
}

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

function lidarStripMayAffectTile(
  strip: LidarStripMeters,
  tileRef: { z: number; x: number; y: number }
) {
  const bounds = tileMetersBounds(tileRef.z, tileRef.x, tileRef.y);
  const reachPadM = Math.max(
    strip.halfWidthM ?? 0,
    typeof strip.maxRangeM === "number" && Number.isFinite(strip.maxRangeM) ? strip.maxRangeM : 0
  );
  const minXs = Math.min(strip.x1, strip.x2) - reachPadM;
  const maxXs = Math.max(strip.x1, strip.x2) + reachPadM;
  const minYs = Math.min(strip.y1, strip.y2) - reachPadM;
  const maxYs = Math.max(strip.y1, strip.y2) + reachPadM;
  return !(
    maxXs < bounds.minX ||
    minXs > bounds.maxX ||
    maxYs < bounds.minY ||
    minYs > bounds.maxY
  );
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

export function OverlapGSDPanel({ mapRef, mapboxToken, getPerPolygonParams, onEditPolygonParams, onAutoRun, onClearExposed, onExposePoseImporter, onPosesImported, polygonAnalyses, overrides, importedOriginals, selectedPolygonId: controlledSelectedId, onSelectPolygon }: Props) {
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
  const [overallStats, setOverallStats] = useState<OverallMetricStats>({ gsd: null, density: null });
  const [perPolygonStats, setPerPolygonStats] = useState<Map<string, PolygonMetricSummary>>(new Map());
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const isControlled = controlledSelectedId !== undefined;
  const activeSelectedId = isControlled ? (controlledSelectedId ?? null) : internalSelectedId;
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const setSelection = useCallback((id: string | null) => {
    if (onSelectPolygon) {
      onSelectPolygon(id);
    } else {
      setInternalSelectedId(id);
    }
  }, [onSelectPolygon]);

  // NEW: poses-only mode state
  const poseFileRef = useRef<HTMLInputElement>(null);
  const [poseImportKind, setPoseImportKind] = useState<'auto' | 'dji' | 'wingtra'>('auto');
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
  const autoRunTimeoutRef = useRef<number | null>(null);
  const computeSeqRef = useRef(0); // increment to invalidate in-flight computations
  const [clipInnerBufferM, setClipInnerBufferM] = useState(0);
  const [maxTiltDeg, setMaxTiltDeg] = useState(30); // NEW: max allowable camera tilt (deg from vertical)
  const [minOverlapForGsd, setMinOverlapForGsd] = useState(3); // Minimum image overlap to consider GSD valid
  const minOverlapForGsdRef = useRef(minOverlapForGsd);
  React.useEffect(() => {
    minOverlapForGsdRef.current = minOverlapForGsd;
  }, [minOverlapForGsd]);
  // NEW: altitude strategy & min clearance & turn extension (synced with map API if available)
  const [altitudeModeUI, setAltitudeModeUI] = useState<'legacy' | 'min-clearance'>('legacy');
  const [minClearanceUI, setMinClearanceUI] = useState<number>(60);
  const [turnExtendUI, setTurnExtendUI] = useState<number>(96);

  // Sync initial values from map API
  React.useEffect(() => {
    const api = mapRef.current;
    const mode = (api as any)?.getAltitudeMode ? (api as any).getAltitudeMode() : 'legacy';
    const minc = (api as any)?.getMinClearance ? (api as any).getMinClearance() : 60;
    const ext = (api as any)?.getTurnExtend ? (api as any).getTurnExtend() : 96;
    setAltitudeModeUI(mode);
    setMinClearanceUI(minc);
    setTurnExtendUI(ext);
  }, [mapRef]);

  const getMergedParamsMap = useCallback(() => {
    const externalParams = getPerPolygonParams?.() ?? {};
    const internalParams = mapRef.current?.getPerPolygonParams?.() ?? {};
    return { ...externalParams, ...internalParams };
  }, [getPerPolygonParams, mapRef]);

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

  const matchCameraKeyFromName = useCallback((name?: string | null): string | null => {
    if (!name) return null;
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const stripVersionSuffix = (s: string) => normalize(s).replace(/v\\d+$/g, "");
    const target = normalize(name);
    const targetStem = stripVersionSuffix(name);
    for (const [key, cam] of Object.entries(CAMERA_REGISTRY)) {
      const names = cam.names || [];
      if (names.some(n => {
        const t = normalize(n);
        const ts = stripVersionSuffix(n);
        if (t === target) return true;
        if (target.includes(t) || t.includes(target)) return true;
        if (targetStem && ts && (targetStem === ts || targetStem.includes(ts) || ts.includes(targetStem))) return true;
        return false;
      })) {
        return key;
      }
    }
    return null;
  }, [CAMERA_REGISTRY]);

  const toNumber = (v: any): number | undefined => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  };

  const radMaybeDegToDeg = (v: number | undefined): number | undefined => {
    if (!Number.isFinite(v)) return undefined;
    const abs = Math.abs(v as number);
    // Wingtra yaw/pitch/roll appear to be in radians; convert when value is within a 2π range
    if (abs <= Math.PI * 2 + 1e-3) return (v as number) * 180 / Math.PI;
    return v as number;
  };

  const parseWingtraGeotags = useCallback((payload: any): { poses: PoseMeters[]; cameraKey: string | null; camera: CameraModel | null; sourceLabel: string } | null => {
    if (!payload || !Array.isArray(payload.flights)) return null;
    const flights = payload.flights;
    const pickByName = (name: string) => flights.find((f: any) => String(f?.name || '').toLowerCase() === name);
    const chosen = pickByName('processedforward') || pickByName('raw') || flights[0];
    if (!chosen || !Array.isArray(chosen.geotag)) return null;

    const poses: PoseMeters[] = [];
    chosen.geotag.forEach((g: any, idx: number) => {
      const coord = g.coordinate;
      if (!Array.isArray(coord) || coord.length < 2) return;
      const lat = toNumber(coord[0]);
      const lon = toNumber(coord[1]);
      const alt = toNumber(coord[2]) ?? 0;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const { x, y } = wgs84ToWebMercator(lat as number, lon as number);
      const yawDeg = radMaybeDegToDeg(toNumber(g.yaw));
      const pitchDeg = radMaybeDegToDeg(toNumber(g.pitch));
      const rollDeg = radMaybeDegToDeg(toNumber(g.roll));
      poses.push({
        id: (g.sequence ?? idx)?.toString?.() ?? `pose_${idx}`,
        x,
        y,
        z: alt,
        omega_deg: rollDeg ?? 0,
        phi_deg: pitchDeg ?? 0,
        kappa_deg: yawDeg ?? 0,
      } as PoseMeters);
    });

    if (!poses.length) return null;
    const cameraKey = matchCameraKeyFromName(typeof payload.model === 'string' ? payload.model : undefined);
    const camera = cameraKey ? CAMERA_REGISTRY[cameraKey] : null;
    const sourceLabel = String(chosen.name || (pickByName('processedforward') ? 'ProcessedForward' : 'Raw'));
    return { poses, cameraKey, camera, sourceLabel };
  }, [CAMERA_REGISTRY, matchCameraKeyFromName]);

  const applyImportedPoses = useCallback((posesMeters: PoseMeters[], camera: CameraModel | null, cameraKey: string | null, sourceLabel: string) => {
    setImportedPoses(posesMeters);
    if (posesMeters.length) {
      poseAreaRingRef.current = []; // force rebuild in compute via AOI function
    }
    if (camera) {
      setCameraText(JSON.stringify(camera, null, 2));
      setUseOverrideCamera(true);
    }
    setAutoGenerate(false);
    setShowCameraPoints(true);
    const cameraMsg = camera ? (cameraKey ? ` using ${cameraKey} camera.` : ' with camera intrinsics.') : '.';
    toast({ title: "Imported poses", description: `${posesMeters.length} camera poses loaded (${sourceLabel})${cameraMsg}` });
    onPosesImported?.(posesMeters.length);
    setTimeout(()=>{ if (poseAreaRingRef.current.length>=4) { const api = mapRef.current; const map = api?.getMap?.(); if(map){ const ring=poseAreaRingRef.current; const lngs=ring.map(c=>c[0]); const lats=ring.map(c=>c[1]); map.fitBounds([[Math.min(...lngs), Math.min(...lats)],[Math.max(...lngs), Math.max(...lats)]], { padding:50, duration:800, maxZoom:16 }); } } }, 30);
  }, [mapRef, onPosesImported]);

  const parseCameraOverride = useCallback((): CameraModel | null => {
    if (!useOverrideCamera) return null;
    try { const obj = JSON.parse(cameraText); return obj as CameraModel; } catch { return null; }
  }, [cameraText, useOverrideCamera]);

  const effectiveCameraForPolygon = useCallback((polygonId: string, paramsMap: any): CameraModel => {
    const p = paramsMap[polygonId];
    if (p?.cameraKey && CAMERA_REGISTRY[p.cameraKey]) return CAMERA_REGISTRY[p.cameraKey];
    const override = parseCameraOverride();
    if (override) return override;
    return SONY_RX1R2; // fallback
  }, [parseCameraOverride, CAMERA_REGISTRY]);

  const isLidarPayload = useCallback((polygonId: string, paramsMap: any): boolean => {
    if (polygonId === '__POSES__') return false;
    return (paramsMap?.[polygonId]?.payloadKind ?? 'camera') === 'lidar';
  }, []);

  // Helper: per‑polygon spacing using that polygon's selected camera
  const photoSpacingFor = useCallback((polygonId: string, altitudeAGL: number, frontOverlap: number, paramsMap: any): number => {
    const p = paramsMap?.[polygonId];
    const explicit = p?.triggerDistanceM;
    if (Number.isFinite(explicit) && (explicit as number) > 0) {
      return explicit as number;
    }
    const cam = effectiveCameraForPolygon(polygonId, paramsMap);
    const yawOffset = p?.cameraYawOffsetDeg ?? 0;
    const rotate90 = Math.round((((yawOffset % 180) + 180) % 180)) === 90;
    return forwardSpacingRotated(cam, altitudeAGL, frontOverlap, rotate90);
  }, [effectiveCameraForPolygon]);

  // Accurate aggregation with tail trimming and fixed 8-bin histogram for display
  const [tailAreaAcres, setTailAreaAcres] = useState<number>(1); // trim per side (acres)

  const aggregateMetricStats = useCallback((tileStats: GSDStats[]): GSDStats => {
    // Filter valid tile stats
    const valid = tileStats.filter(s => s && s.count > 0 && isFinite(s.min) && isFinite(s.max) && s.max > 0);
    if (valid.length === 0) return { min:0, max:0, mean:0, count:0, totalAreaM2:0, histogram: [] } as any;

    // Calculate accurate aggregated statistics using original data
    let totalCount = 0, totalArea = 0, weightedSum = 0;
    let globalMin = +Infinity, globalMax = -Infinity;

    for (const s of valid) {
      totalCount += s.count;
      const areaWeight = (s.totalAreaM2 && s.totalAreaM2 > 0) ? s.totalAreaM2 : s.count;
      totalArea += areaWeight;
      weightedSum += s.mean * areaWeight;
      if (s.min < globalMin) globalMin = s.min;
      if (s.max > globalMax) globalMax = s.max;
    }

    const accurateMean = totalArea > 0 ? weightedSum / totalArea : 0;

    // Merge histograms into 8 uniform bins across [globalMin, globalMax]
    const span = globalMax - globalMin;
    if (!(span > 0)) {
      return { min: globalMin, max: globalMax, mean: accurateMean, count: totalCount, totalAreaM2: totalArea, histogram: [{ bin: globalMin, count: totalCount, areaM2: totalArea }] } as any;
    }
    const targetBins = 8;
    const binSize = span / targetBins;
    const bins = new Array<{ bin: number; count: number; areaM2: number }>(targetBins);
    for (let i = 0; i < targetBins; i++) bins[i] = { bin: globalMin + (i + 0.5) * binSize, count: 0, areaM2: 0 };

    for (const s of valid) {
      if (!s.histogram || s.histogram.length === 0) continue;
      for (const hb of s.histogram) {
        if (!hb || hb.count === 0) continue;
        let bi = Math.floor((hb.bin - globalMin) / binSize);
        if (bi < 0) bi = 0; if (bi >= targetBins) bi = targetBins - 1;
        bins[bi].count += hb.count;
        bins[bi].areaM2 += (hb.areaM2 || 0);
      }
    }

    // Trim tails by area: each side at most tailAreaAcres
    const ACRE_TO_M2 = 4046.8564224;
    const tailAreaM2 = Math.max(0, (tailAreaAcres || 0) * ACRE_TO_M2);
    const areaSum = bins.reduce((a,b)=> a + (b.areaM2 || 0), 0);
    let minTrim = globalMin, maxTrim = globalMax;
    if (areaSum > 0 && tailAreaM2 > 0 && tailAreaM2 * 2 < areaSum) {
      // left trim
      let cum = 0, i = 0;
      for (; i < bins.length; i++) { const a = bins[i].areaM2 || 0; if (cum + a >= tailAreaM2) break; cum += a; }
      if (i < bins.length) minTrim = bins[i].bin;
      // right trim
      cum = 0; let j = bins.length - 1;
      for (; j >= 0; j--) { const a = bins[j].areaM2 || 0; if (cum + a >= tailAreaM2) break; cum += a; }
      if (j >= 0) maxTrim = bins[j].bin;
      if (!(maxTrim > minTrim)) { minTrim = globalMin; maxTrim = globalMax; }
    }

    // Remove completely empty bins for display cleanliness
    const mergedHistogram = bins.filter(b => b.count > 0 || (b.areaM2 || 0) > 0);

    return {
      min: minTrim,
      max: maxTrim,
      mean: accurateMean,
      count: totalCount,
      totalAreaM2: totalArea,
      histogram: mergedHistogram
    } as any;
  }, [tailAreaAcres]);

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

    const paramsMap = getMergedParamsMap();

    const flightLinesMap = api.getFlightLines();
    const tilesMap = api.getPolygonTiles();
    const poses: PoseMeters[] = [];
    let poseId = 0;

    for (const [polygonId, { flightLines, lineSpacing, altitudeAGL }] of Array.from(flightLinesMap.entries())) {
      const tiles = tilesMap.get(polygonId) || [];
      if (flightLines.length === 0 || tiles.length === 0) continue;

      const p = (paramsMap as any)[polygonId];
      if ((p?.payloadKind ?? 'camera') === 'lidar') continue;
      const altForThisPoly = p?.altitudeAGL ?? altitudeAGL ?? 100;
      const front = p?.frontOverlap ?? 80;
      const spacingForward = photoSpacingFor(polygonId, altForThisPoly, front, paramsMap);
      const yawOffset = p?.cameraYawOffsetDeg ?? 0;

      const mode = (api as any)?.getAltitudeMode ? (api as any).getAltitudeMode() : 'legacy';
      const minClr = (api as any)?.getMinClearance ? (api as any).getMinClearance() : 60;
      const turnExtend = (api as any)?.getTurnExtend ? Math.max(0, (api as any).getTurnExtend()) : turnExtendUI;
      const path3D = build3DFlightPath(
        flightLines,
        tiles,
        lineSpacing,
        { altitudeAGL: altForThisPoly, mode, minClearance: minClr, turnExtendM: turnExtend }
      );

      const cameraPositions = sampleCameraPositionsOnFlightPath(path3D, spacingForward, { includeTurns: false });
      // Filter out cameras outside the polygon ring
      const polys = api.getPolygonsWithIds?.() || [];
      const ring = (polys.find((pp:any)=> (pp.id||'unknown')===polygonId)?.ring) as [number,number][] | undefined;
      const inside = (lng:number,lat:number,ring:[number,number][]) => {
        let ins=false; for(let i=0,j=ring.length-1;i<ring.length;j=i++){
          const xi=ring[i][0], yi=ring[i][1], xj=ring[j][0], yj=ring[j][1];
          const intersect=((yi>lat)!==(yj>lat)) && (lng < (xj-xi)*(lat-yi)/(yj-yi)+xi); if(intersect) ins=!ins;
        } return ins;
      };
      const filtered = ring && ring.length>=3 ? cameraPositions.filter(([lng,lat])=> inside(lng,lat,ring)) : cameraPositions;

      const normalizeDeg = (d: number) => ((d % 360) + 360) % 360;
      filtered.forEach(([lng, lat, altMSL, yawDeg]) => {
        const [x, y] = lngLatToMeters(lng, lat);
        // Align camera so image height (y-axis) is along flight direction; width is cross-track.
        // yawDeg is bearing CW from North; kappa in our math is CCW about +Z.
        const kappaDeg = normalizeDeg(-yawDeg + yawOffset);
        poses.push({
          id: `photo_${poseId++}`,
          x, y, z: altMSL,
          omega_deg: 0,
          phi_deg: 0,
          kappa_deg: kappaDeg,
          polygonId // tag pose with polygon for per‑camera assignment
        });
      });
    }
    return poses;
  }, [getMergedParamsMap, mapRef, photoSpacingFor, turnExtendUI]);

  const parsePosesMeters = useCallback((): PoseMeters[] | null => {
    const api = mapRef.current;
    const fl = api?.getFlightLines?.();
    const haveLines = !!fl && Array.from(fl.values()).some((v: any) => v.flightLines && v.flightLines.length > 0);
    const generated = haveLines ? generatePosesFromFlightLines() : [];
    // Always keep imported poses; add generated ones when lines exist
    const base: PoseMeters[] = [ ...(importedPoses || []), ...(generated || []) ];
    if (!base) return [];
    // NEW: filter poses by tilt (sqrt(omega^2 + phi^2) ~ small-angle off-nadir approximation)
    const filtered = maxTiltDeg >= 0 ? base.filter(p => {
      const tilt = Math.sqrt((p.omega_deg||0)*(p.omega_deg||0) + (p.phi_deg||0)*(p.phi_deg||0));
      return tilt <= maxTiltDeg;
    }) : base;
    return filtered;
  }, [generatePosesFromFlightLines, importedPoses, maxTiltDeg, mapRef]);

  const getPolygons = useCallback((): PolygonLngLatWithId[] => {
    const api = mapRef.current;
    if (!api?.getPolygonsWithIds) return [];
    return api.getPolygonsWithIds(); // returns { id?: string; ring: [number, number][] }[]
  }, [mapRef]);

  const buildLidarStrips = useCallback((paramsMap: Record<string, any>, polygonFilter?: Set<string>): {
    strips: LidarStripMeters[];
    densityPaletteMax: number;
  } => {
    const api = mapRef.current;
    const flightLinesMap = api?.getFlightLines?.();
    const tilesMap = api?.getPolygonTiles?.();
    if (!flightLinesMap || !tilesMap) return { strips: [], densityPaletteMax: 200 };

    const strips: LidarStripMeters[] = [];
    let densityPaletteMax = 0;
    let globalPassIndex = 0;
    const altitudeMode = (api as any)?.getAltitudeMode ? (api as any).getAltitudeMode() : 'legacy';
    const minClearance = (api as any)?.getMinClearance ? (api as any).getMinClearance() : 60;
    const turnExtend = (api as any)?.getTurnExtend ? Math.max(0, (api as any).getTurnExtend()) : turnExtendUI;

    for (const [polygonId, lineData] of Array.from(flightLinesMap.entries())) {
      if (polygonFilter && !polygonFilter.has(polygonId)) continue;
      if (!isLidarPayload(polygonId, paramsMap)) continue;
      const params = paramsMap[polygonId] ?? {};
      const tiles = tilesMap.get(polygonId) || [];
      const model = getLidarModel(params.lidarKey);
      const altitudeAGL = params.altitudeAGL ?? lineData.altitudeAGL ?? altitude;
      const mappingFovDeg = getLidarMappingFovDeg(model, params.mappingFovDeg);
      const speedMps = params.speedMps ?? model.defaultSpeedMps;
      const returnMode = params.lidarReturnMode ?? 'single';
      const maxLidarRangeM = params.maxLidarRangeM ?? model.defaultMaxRangeM ?? DEFAULT_LIDAR_MAX_RANGE_M;
      const frameRateHz = params.lidarFrameRateHz ?? model.defaultFrameRateHz;
      const azimuthSectorCenterDeg = params.lidarAzimuthSectorCenterDeg ?? model.defaultAzimuthSectorCenterDeg ?? 0;
      const boresightYawDeg = params.lidarBoresightYawDeg ?? model.boresightYawDeg ?? 0;
      const boresightPitchDeg = params.lidarBoresightPitchDeg ?? model.boresightPitchDeg ?? 0;
      const boresightRollDeg = params.lidarBoresightRollDeg ?? model.boresightRollDeg ?? 0;
      const comparisonMode = params.lidarComparisonMode ?? 'first-return';
      const swathWidth = lidarSwathWidth(altitudeAGL, mappingFovDeg);
      const densityPerPass = lidarSinglePassDensity(model, altitudeAGL, speedMps, returnMode, mappingFovDeg);
      const halfFovTan = Math.tan((mappingFovDeg * Math.PI) / 360);
      const effectivePointRate = model.effectivePointRates[returnMode];
      const nominalDensity = params.pointDensityPtsM2
        ?? lidarDeliverableDensity(model, altitudeAGL, params.sideOverlap ?? 0, speedMps, returnMode, mappingFovDeg);
      densityPaletteMax = Math.max(densityPaletteMax, nominalDensity);
      if (!(swathWidth > 0) || !(densityPerPass > 0)) continue;

      const sourceLines = lineData.flightLines ?? [];
      for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
        const sourceLine = sourceLines[lineIndex];
        if (!Array.isArray(sourceLine) || sourceLine.length < 2) continue;
        const passIndex = globalPassIndex++;
        const flownLine = lineIndex % 2 === 0 ? sourceLine : [...sourceLine].reverse();
        const activeSweepLine = extendFlightLineForTurnRunout(flownLine, turnExtend);
        const sweepPath3d = build3DFlightPath(
          [activeSweepLine],
          tiles,
          lineData.lineSpacing,
          { altitudeAGL, mode: altitudeMode, minClearance, turnExtendM: 0 }
        )[0];
        if (!Array.isArray(sweepPath3d) || sweepPath3d.length < 2) continue;

        for (let i = 1; i < sweepPath3d.length; i++) {
          const start = sweepPath3d[i - 1];
          const end = sweepPath3d[i];
          if (!Array.isArray(start) || !Array.isArray(end) || start.length < 3 || end.length < 3) continue;
          const [x1, y1] = lngLatToMeters(start[0], start[1]);
          const [x2, y2] = lngLatToMeters(end[0], end[1]);
          const terrainMin = tiles.length > 0
            ? queryMinMaxElevationAlongPolylineWGS84([[start[0], start[1]], [end[0], end[1]]], tiles, 12).min
            : Number.NaN;
          const maxSensorAltitude = Math.max(start[2], end[2]);
          const maxHalfWidth = Number.isFinite(terrainMin)
            ? Math.max(swathWidth / 2, Math.max(1, (maxSensorAltitude - terrainMin) * halfFovTan))
            : swathWidth / 2;
          strips.push({
            id: `${polygonId}-line-${lineIndex}-seg-${i - 1}`,
            polygonId,
            x1,
            y1,
            z1: start[2],
            x2,
            y2,
            z2: end[2],
            plannedAltitudeAGL: altitudeAGL,
            halfWidthM: maxHalfWidth,
            densityPerPass,
            speedMps,
            effectivePointRate,
            halfFovTan,
            maxRangeM: maxLidarRangeM,
            passIndex,
            frameRateHz,
            nativeHorizontalFovDeg: model.nativeHorizontalFovDeg,
            mappingFovDeg,
            verticalAnglesDeg: model.verticalAnglesDeg,
            returnMode,
            comparisonMode,
            azimuthSectorCenterDeg,
            boresightYawDeg,
            boresightPitchDeg,
            boresightRollDeg,
          });
        }
      }
    }

    return { strips, densityPaletteMax: densityPaletteMax > 0 ? densityPaletteMax * 1.15 : 200 };
  }, [altitude, isLidarPayload, mapRef, turnExtendUI]);

  const combinedPolygons = useMemo(() => {
    const polygonOrdering = getPolygons().map((p) => p.id || 'unknown');
    const order = polygonOrdering.length > 0 ? polygonOrdering : polygonAnalyses.map((analysis) => analysis.polygonId);
    const map = new Map<string, { analysis?: PolygonAnalysisResult; stats?: PolygonMetricSummary }>();

    polygonAnalyses.forEach((analysis) => {
      map.set(analysis.polygonId, { analysis, stats: perPolygonStats.get(analysis.polygonId) });
    });

    perPolygonStats.forEach((stats, polygonId) => {
      if (map.has(polygonId)) {
        map.set(polygonId, { analysis: map.get(polygonId)?.analysis, stats });
      } else {
        map.set(polygonId, { stats });
      }
    });

    const orderedIds = [...order, ...Array.from(perPolygonStats.keys()).filter((id) => !order.includes(id))];

    return orderedIds
      .map((polygonId, index) => ({ polygonId, analysis: map.get(polygonId)?.analysis, stats: map.get(polygonId)?.stats, sortIndex: index }))
      .filter(({ analysis, stats }) => analysis || stats)
      .sort((a, b) => a.sortIndex - b.sortIndex);
  }, [polygonAnalyses, perPolygonStats, getPolygons]);

  React.useEffect(() => {
    if (combinedPolygons.length === 0) {
      if (!isControlled && activeSelectedId) setInternalSelectedId(null);
      return;
    }
    if (activeSelectedId && !combinedPolygons.some(item => item.polygonId === activeSelectedId)) {
      if (!isControlled) setInternalSelectedId(combinedPolygons[0].polygonId);
    } else if (!activeSelectedId && !isControlled) {
      setInternalSelectedId(combinedPolygons[0].polygonId);
    }
  }, [combinedPolygons, activeSelectedId, isControlled]);

  React.useEffect(() => {
    if (!activeSelectedId) return;
    const node = itemRefs.current.get(activeSelectedId);
    if (node && node.scrollIntoView) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeSelectedId]);

  /**
   * Compute payload-aware coverage analysis for either:
   *  - a single polygon (opts.polygonId provided), or
   *  - all polygons (default)
   */
  const compute = useCallback(async (opts?: { polygonId?: string; suppressMapNotReadyToast?: boolean }) => {
    const mySeq = ++computeSeqRef.current;
    const api = mapRef.current;
    const paramsMap = getMergedParamsMap();
    const overrideCam = parseCameraOverride();

    const perPolyCam: Record<string, CameraModel> = {};
    Object.entries(paramsMap).forEach(([pid, p]: any) => {
      if (p?.cameraKey && CAMERA_REGISTRY[p.cameraKey]) perPolyCam[pid] = CAMERA_REGISTRY[p.cameraKey];
    });

    const identifyCameraKey = (cam: CameraModel | null): string | null => {
      if (!cam) return null;
      for (const [key, model] of Object.entries(CAMERA_REGISTRY)) {
        if (model.w_px === cam.w_px && model.h_px === cam.h_px && Math.abs(model.f_m - cam.f_m) / model.f_m < 0.02) {
          return key;
        }
      }
      return null;
    };

    const overrideCamKey = overrideCam ? identifyCameraKey(overrideCam) : null;
    const poses = parsePosesMeters() ?? [];
    let camerasArr: CameraModel[] | undefined;
    let poseIdxArr: Uint16Array | undefined;
    if (poses.length > 0) {
      const camObjToIndex = new Map<CameraModel, number>();
      const cams: CameraModel[] = [];
      const indices = new Uint16Array(poses.length);
      for (let i = 0; i < poses.length; i++) {
        const pose = poses[i];
        let cam: CameraModel | undefined;
        if (pose.polygonId && perPolyCam[pose.polygonId]) {
          cam = perPolyCam[pose.polygonId];
        } else if (!pose.polygonId && importedPoses.length > 0) {
          try {
            const parsed = JSON.parse(cameraText) as CameraModel;
            if (parsed && typeof parsed.f_m === 'number') cam = parsed;
          } catch {}
        } else if (overrideCam && typeof overrideCam === 'object' && 'f_m' in overrideCam) {
          cam = overrideCam;
        }
        if (!cam) cam = SONY_RX1R2;
        if (!camObjToIndex.has(cam)) {
          camObjToIndex.set(cam, cams.length);
          cams.push(cam);
        }
        indices[i] = camObjToIndex.get(cam)!;
      }
      camerasArr = cams.length > 0 ? cams : undefined;
      poseIdxArr = cams.length > 1 ? indices : new Uint16Array(poses.length);
    }

    let allPolygons = getPolygons();
    if (poses.length > 0 && importedPoses.length > 0) {
      const buildPosesAOIRing = (posesIn: PoseMeters[]): [number, number][] => {
        if (!posesIn || posesIn.length < 3) return [];
        const maxPoints = 2000;
        const step = Math.max(1, Math.floor(posesIn.length / maxPoints));
        const pts = posesIn
          .filter((_, i) => i % step === 0)
          .map((pose) => {
            const [lng, lat] = metersToLngLat(pose.x, pose.y);
            return turf.point([lng, lat]);
          });
        const fc = turf.featureCollection(pts);
        const hull = turf.convex(fc);
        if (!hull) return [];
        const geom: any = (hull as any).geometry;
        return geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates[0][0];
      };
      const ring = poseAreaRingRef.current.length ? poseAreaRingRef.current : buildPosesAOIRing(importedPoses);
      poseAreaRingRef.current = ring;
      if (ring.length >= 4) allPolygons = [...allPolygons, { id: '__POSES__', ring }];
    }

    if (allPolygons.length === 0) {
      toast({ variant: 'destructive', title: 'Missing inputs', description: 'Draw or import an area first.' });
      return;
    }

    const cameraPolygons = allPolygons.filter((polygon) => !isLidarPayload(polygon.id || 'unknown', paramsMap));
    const lidarPolygons = allPolygons.filter((polygon) => isLidarPayload(polygon.id || 'unknown', paramsMap));
    const targetPolygonId = opts?.polygonId;
    const targetIsCamera = targetPolygonId ? cameraPolygons.some((polygon) => (polygon.id || 'unknown') === targetPolygonId) : cameraPolygons.length > 0;
    const targetIsLidar = targetPolygonId ? lidarPolygons.some((polygon) => (polygon.id || 'unknown') === targetPolygonId) : lidarPolygons.length > 0;
    const canRunCamera = targetIsCamera && poses.length > 0;
    const canRunLidar = targetIsLidar;

    if (!canRunCamera && !canRunLidar) {
      toast({ variant: 'destructive', title: 'Missing inputs', description: 'Provide poses or generate flight lines before running analysis.' });
      return;
    }

    const map: mapboxgl.Map | undefined = mapRef.current?.getMap?.();
    if (!map || !map.isStyleLoaded?.()) {
      if (!opts?.suppressMapNotReadyToast) {
        toast({
          variant: "destructive",
          title: "Map not ready",
          description: "Please wait for the map to load completely."
        });
      }
      return;
    }

    const now = Date.now();
    if (!opts?.polygonId) {
      if (globalRunIdRef.current) clearRunOverlays(map, globalRunIdRef.current);
      globalRunIdRef.current = `${now}`;
      perPolyTileStatsRef.current.clear();
    }
    const runId = globalRunIdRef.current ?? `${now}`;
    if (!globalRunIdRef.current) globalRunIdRef.current = runId;

    const polygonMap = new Map(allPolygons.map((polygon) => [polygon.id || 'unknown', polygon] as const));
    const collectTiles = (sourcePolygons: PolygonLngLatWithId[]): { z: number; x: number; y: number }[] => {
      const seen = new Set<string>();
      const tiles: { z: number; x: number; y: number }[] = [];
      for (const poly of sourcePolygons) {
        for (const tile of tilesCoveringPolygon(poly, zoom)) {
          const key = `${zoom}/${tile.x}/${tile.y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tiles.push({ z: zoom, x: tile.x, y: tile.y });
        }
      }
      if (targetPolygonId && sourcePolygons.some((polygon) => (polygon.id || 'unknown') === targetPolygonId)) {
        const prevRing = prevPolygonRingsRef.current.get(targetPolygonId);
        if (prevRing && prevRing.length >= 4) {
          const prevPolygon = { id: targetPolygonId, ring: prevRing } as PolygonLngLatWithId;
          for (const tile of tilesCoveringPolygon(prevPolygon, zoom)) {
            const key = `${zoom}/${tile.x}/${tile.y}`;
            if (seen.has(key)) continue;
            seen.add(key);
            tiles.push({ z: zoom, x: tile.x, y: tile.y });
          }
        }
      }
      return tiles;
    };

    const buildNeededTileKeys = (polygons: PolygonLngLatWithId[]) => {
      const keys = new Set<string>();
      for (const polygon of polygons) {
        for (const tile of tilesCoveringPolygon(polygon, zoom)) {
          keys.add(`${zoom}/${tile.x}/${tile.y}`);
        }
      }
      return keys;
    };

    const pruneOverlaysByKinds = (kinds: Array<'overlap' | 'pass' | 'gsd' | 'density'>, neededTileKeys: Set<string>) => {
      const styleLayers = map.getStyle()?.layers ?? [];
      for (const layer of styleLayers) {
        const id = layer.id;
        if (!id.startsWith(`ogsd-${runId}-`)) continue;
        const parts = id.split('-');
        if (parts.length < 6) continue;
        const kind = parts[2] as 'overlap' | 'pass' | 'gsd' | 'density';
        if (!kinds.includes(kind)) continue;
        const zStr = parts[parts.length - 3];
        const xStr = parts[parts.length - 2];
        const yStr = parts[parts.length - 1];
        const key = `${zStr}/${xStr}/${yStr}`;
        if (neededTileKeys.has(key)) continue;
        try {
          if (map.getLayer(id)) map.removeLayer(id);
          if (map.getSource(id)) map.removeSource(id);
        } catch {}
      }
    };

    const getTile = async (tileRef: { z: number; x: number; y: number }) => {
      const cacheKey = `${tileRef.z}/${tileRef.x}/${tileRef.y}`;
      let tileData = tileCacheRef.current.get(cacheKey);
      if (!tileData) {
        const imgData = await fetchTerrainRGBA(tileRef.z, tileRef.x, tileRef.y, mapboxToken);
        tileData = {
          width: imgData.width,
          height: imgData.height,
          data: new Uint8ClampedArray(imgData.data),
        };
        tileCacheRef.current.set(cacheKey, tileData);
        const maxTiles = 256;
        if (tileCacheRef.current.size > maxTiles) {
          const firstKey = tileCacheRef.current.keys().next().value;
          if (firstKey) tileCacheRef.current.delete(firstKey);
        }
      }
      return {
        cacheKey,
        tile: { z: tileRef.z, x: tileRef.x, y: tileRef.y, size: tileData.width, data: new Uint8ClampedArray(tileData.data) },
      };
    };

    const normalizeTileRef = (tileRef: { z: number; x: number; y: number }) => {
      const tilesPerAxis = 1 << tileRef.z;
      const wrappedX = ((tileRef.x % tilesPerAxis) + tilesPerAxis) % tilesPerAxis;
      const clampedY = Math.max(0, Math.min(tilesPerAxis - 1, tileRef.y));
      return { z: tileRef.z, x: wrappedX, y: clampedY };
    };

    const getLidarTileWithHalo = async (tileRef: { z: number; x: number; y: number }, padTiles = 1) => {
      const center = await getTile(tileRef);
      if (padTiles <= 0) return center;

      const offsets: Array<{ dx: number; dy: number; tileRef: { z: number; x: number; y: number } }> = [];
      for (let dy = -padTiles; dy <= padTiles; dy++) {
        for (let dx = -padTiles; dx <= padTiles; dx++) {
          offsets.push({
            dx,
            dy,
            tileRef: normalizeTileRef({ z: tileRef.z, x: tileRef.x + dx, y: tileRef.y + dy }),
          });
        }
      }

      const neighborTiles = await Promise.all(offsets.map((entry) => getTile(entry.tileRef)));
      const tileSize = center.tile.size;
      const span = padTiles * 2 + 1;
      const demSize = tileSize * span;
      const demData = new Uint8ClampedArray(demSize * demSize * 4);

      for (let i = 0; i < offsets.length; i++) {
        const { dx, dy } = offsets[i];
        const srcTile = neighborTiles[i].tile;
        const offsetX = (dx + padTiles) * tileSize;
        const offsetY = (dy + padTiles) * tileSize;
        for (let row = 0; row < tileSize; row++) {
          const srcStart = row * tileSize * 4;
          const dstStart = ((offsetY + row) * demSize + offsetX) * 4;
          demData.set(srcTile.data.subarray(srcStart, srcStart + tileSize * 4), dstStart);
        }
      }

      return {
        cacheKey: center.cacheKey,
        tile: center.tile,
        demTile: {
          size: demSize,
          padTiles,
          data: demData,
        },
      };
    };

    const upsertTileStats = (cacheKey: string, stats: PolygonTileStats[] | undefined) => {
      if (!stats) return;
      for (const polyStats of stats) {
        if (!perPolyTileStatsRef.current.has(polyStats.polygonId)) {
          perPolyTileStatsRef.current.set(polyStats.polygonId, new Map());
        }
        perPolyTileStatsRef.current.get(polyStats.polygonId)!.set(cacheKey, polyStats);
      }
    };

    setRunning(true);
    autoTriesRef.current = 0;

    const cameraWorker = canRunCamera ? new OverlapWorker() : null;
    const lidarWorker = canRunLidar ? new LidarDensityWorker() : null;
    try {
      if (cameraWorker && camerasArr && cameraPolygons.length > 0) {
        const cameraSourcePolygons = targetPolygonId
          ? cameraPolygons.filter((polygon) => (polygon.id || 'unknown') === targetPolygonId)
          : cameraPolygons;
        const cameraTiles = collectTiles(cameraSourcePolygons);
        for (const tileRef of cameraTiles) {
          const { cacheKey, tile } = await getTile(tileRef);
          const res = await cameraWorker.runTile({
            tile,
            polygons: cameraPolygons,
            poses,
            cameras: camerasArr,
            poseCameraIndices: poseIdxArr,
            camera: undefined,
            options: { clipInnerBufferM, minOverlapForGsd: minOverlapForGsdRef.current },
          } as any);
          if (mySeq !== computeSeqRef.current) break;
          upsertTileStats(cacheKey, res.perPolygon);
          if (showOverlap) addOrUpdateTileOverlay(map, res, { kind: "overlap", runId, opacity });
          if (showGsd) addOrUpdateTileOverlay(map, res, { kind: "gsd", runId, opacity, gsdMin: 0.005, gsdMax: 0.05 });
        }
      }

      if (lidarWorker && lidarPolygons.length > 0) {
        const lidarSourcePolygons = targetPolygonId
          ? lidarPolygons.filter((polygon) => (polygon.id || 'unknown') === targetPolygonId)
          : lidarPolygons;
        const lidarTiles = collectTiles(lidarSourcePolygons);
        const { strips: lidarStrips, densityPaletteMax } = buildLidarStrips(paramsMap);
        for (const tileRef of lidarTiles) {
          const tileStrips = lidarStrips.filter((strip) => lidarStripMayAffectTile(strip, tileRef));
          if (tileStrips.length === 0) continue;
          const { cacheKey, tile, demTile } = await getLidarTileWithHalo(tileRef, 1);
          const res = await lidarWorker.runTile({
            tile,
            demTile,
            polygons: lidarSourcePolygons,
            strips: tileStrips,
            options: { clipInnerBufferM },
          } as any);
          if (mySeq !== computeSeqRef.current) break;
          upsertTileStats(cacheKey, res.perPolygon);
          if (showOverlap) addOrUpdateTileOverlay(map, res, { kind: "pass", runId, opacity });
          if (showGsd) addOrUpdateTileOverlay(map, res, { kind: "density", runId, opacity, densityMin: 0, densityMax: densityPaletteMax });
        }
      }

      if (mySeq !== computeSeqRef.current) return;

      const neededCameraTileKeys = buildNeededTileKeys(cameraPolygons);
      const neededLidarTileKeys = buildNeededTileKeys(lidarPolygons);
      pruneOverlaysByKinds(['overlap', 'gsd'], neededCameraTileKeys);
      pruneOverlaysByKinds(['pass', 'density'], neededLidarTileKeys);

      const emptyPolygonIds: string[] = [];
      perPolyTileStatsRef.current.forEach((tileMap, polygonId) => {
        const neededKeys = isLidarPayload(polygonId, paramsMap) ? neededLidarTileKeys : neededCameraTileKeys;
        for (const key of Array.from(tileMap.keys())) {
          if (!neededKeys.has(key)) tileMap.delete(key);
        }
        if (tileMap.size === 0 || !polygonMap.has(polygonId)) emptyPolygonIds.push(polygonId);
      });
      emptyPolygonIds.forEach((polygonId) => perPolyTileStatsRef.current.delete(polygonId));

      const nextPerPolygon = new Map<string, PolygonMetricSummary>();
      const gsdSummaries: GSDStats[] = [];
      const densitySummaries: GSDStats[] = [];

      perPolyTileStatsRef.current.forEach((polygonTileStatsMap, polygonId) => {
        const polygon = polygonMap.get(polygonId);
        if (!polygon) return;
        const areaAcres = calculatePolygonAreaAcres(polygon.ring);
        const allTileStats = Array.from(polygonTileStatsMap.values());
        const isLidarPolygon = isLidarPayload(polygonId, paramsMap);

        if (isLidarPolygon) {
          const densityStatList = allTileStats.map((stats) => stats.densityStats).filter(Boolean) as GSDStats[];
          const aggregatedDensityStats = aggregateMetricStats(densityStatList);
          if (!(aggregatedDensityStats.count > 0)) return;
          const uniqueLineIds = new Set<number>();
          for (const stats of allTileStats) {
            const hitLineIds = stats.hitLineIds;
            if (!hitLineIds) continue;
            for (let i = 0; i < hitLineIds.length; i++) uniqueLineIds.add(hitLineIds[i]);
          }
          const params = (paramsMap as any)[polygonId];
          const model = getLidarModel(params?.lidarKey);
          const comparisonLabel = lidarComparisonLabel(params?.lidarComparisonMode);
          nextPerPolygon.set(polygonId, {
            polygonId,
            metricKind: 'density',
            stats: aggregatedDensityStats,
            areaAcres,
            sampleCount: uniqueLineIds.size,
            sampleLabel: 'Flight lines',
            sourceLabel: `${model.key} · ${comparisonLabel}`,
          });
          densitySummaries.push(aggregatedDensityStats);
          return;
        }

        const gsdStatList = allTileStats.map((stats) => stats.gsdStats).filter(Boolean) as GSDStats[];
        const aggregatedGsdStats = aggregateMetricStats(gsdStatList);
        if (!(aggregatedGsdStats.count > 0)) return;
        const uniquePoseIds = new Set<number>();
        for (const stats of allTileStats) {
          const hitPoseIds = stats.hitPoseIds;
          if (!hitPoseIds) continue;
          for (let i = 0; i < hitPoseIds.length; i++) uniquePoseIds.add(hitPoseIds[i]);
        }
        const params = (paramsMap as any)[polygonId];
        let cameraLabel = 'SONY_RX1R2';
        if (params?.cameraKey && CAMERA_REGISTRY[params.cameraKey]) {
          cameraLabel = params.cameraKey;
        } else if (overrideCam) {
          cameraLabel = overrideCamKey ? `Override (${overrideCamKey})` : 'Override';
        }
        nextPerPolygon.set(polygonId, {
          polygonId,
          metricKind: 'gsd',
          stats: aggregatedGsdStats,
          areaAcres,
          sampleCount: uniquePoseIds.size,
          sampleLabel: 'Images',
          sourceLabel: cameraLabel,
        });
        gsdSummaries.push(aggregatedGsdStats);
      });

      setPerPolygonStats(nextPerPolygon);
      setOverallStats({
        gsd: gsdSummaries.length > 0 ? aggregateMetricStats(gsdSummaries) : null,
        density: densitySummaries.length > 0 ? aggregateMetricStats(densitySummaries) : null,
      });

      if (showCameraPoints && poses.length > 0) {
        const importedOnly = poses.filter((pose) => !pose.polygonId);
        const cameraPositions: [number, number, number][] = importedOnly.map((pose) => {
          const [lng, lat] = metersToLngLat(pose.x, pose.y);
          return [lng, lat, pose.z];
        });
        if (api?.addCameraPoints) api.addCameraPoints('__POSES__', cameraPositions);
      }

      prevPolygonRingsRef.current = new Map(getPolygons().map((polygon) => [polygon.id || 'unknown', polygon.ring] as const));
    } finally {
      cameraWorker?.terminate();
      lidarWorker?.terminate();
      setRunning(false);
    }
  }, [CAMERA_REGISTRY, aggregateMetricStats, buildLidarStrips, cameraText, clipInnerBufferM, getMergedParamsMap, getPolygons, importedPoses, isLidarPayload, mapRef, mapboxToken, opacity, parseCameraOverride, parsePosesMeters, showCameraPoints, showGsd, showOverlap, zoom]);

  // Auto-run function that can be called externally
  const autoRun = useCallback(async (opts?: { polygonId?: string; reason?: 'lines'|'spacing'|'alt'|'manual' }) => {
    if (running) return;
    const api = mapRef.current;
    const map = api?.getMap?.();
    const ready = !!map?.isStyleLoaded?.();
    const poses = parsePosesMeters();
    const paramsMap = getMergedParamsMap();

    // Poses-only mode auto-run
    if (!autoGenerate && importedPoses.length > 0) {
      if (ready) {
        autoTriesRef.current = 0;
        compute({ suppressMapNotReadyToast: true });
        return;
      }
    }

    if (!autoGenerate) return; // nothing else to auto-run

    const rings: [number, number][][] = api?.getPolygons?.() ?? [];
    const fl = api?.getFlightLines?.();
    const haveLines = !!fl && (
      opts?.polygonId
        ? !!fl.get(opts.polygonId) && fl.get(opts.polygonId)!.flightLines.length > 0
        : Array.from(fl.values()).some((v: any) => v.flightLines.length > 0)
    );
    const havePolys = opts?.polygonId ? (api?.getPolygonsWithIds?.() ?? []).some((p:any)=>p.id===opts.polygonId) : (rings.length > 0);
    const relevantIds = opts?.polygonId
      ? [opts.polygonId]
      : (api?.getPolygonsWithIds?.() ?? []).map((polygon: any) => polygon.id || 'unknown');
    const haveLidarPolys = relevantIds.some((polygonId) => isLidarPayload(polygonId, paramsMap));

    if (ready && !havePolys && importedPoses.length === 0) {
      autoTriesRef.current = 0;
      return;
    }

    // Run as soon as map is ready, polygons exist, and flight lines are present.
    // We no longer gate on MapFlightDirection's polygonTiles since GSD panel fetches its own tiles.
    if (ready && havePolys && haveLines) {
      if (!poses?.length && !haveLidarPolys) return;
      autoTriesRef.current = 0;
      // Recompute from scratch; defer one tick for state flush after edits/deletes
      // Always defer one tick to allow React state updates (lines/tiles) to flush
      setTimeout(() => compute({ polygonId: opts?.polygonId, suppressMapNotReadyToast: true }), 0);
      return;
    }
    if (autoTriesRef.current < 15) {
      autoTriesRef.current += 1;
      if (autoRunTimeoutRef.current !== null) clearTimeout(autoRunTimeoutRef.current);
      autoRunTimeoutRef.current = window.setTimeout(()=>{ if ((autoGenerate || importedPoses.length>0) && !running) autoRun(opts); }, 250);
    } else { autoTriesRef.current = 0; }
  }, [running, autoGenerate, importedPoses, compute, getMergedParamsMap, isLidarPayload, mapRef, parsePosesMeters]);

  // Provide autoRun function to parent component - register immediately and on changes
  React.useEffect(() => {
    onAutoRun?.(autoRun);
  }, [autoRun, onAutoRun]);

  const clear = useCallback(() => {
    const map: any = mapRef.current?.getMap?.();
    if (map) {
      // Invalidate any in-flight compute
      computeSeqRef.current += 1;
      if (autoRunTimeoutRef.current) { clearTimeout(autoRunTimeoutRef.current); autoRunTimeoutRef.current = null; }
      // Remove all overlays regardless of run id to be safe
      clearAllOverlays(map);
      perPolyTileStatsRef.current.clear();
      prevPolygonRingsRef.current = new Map();
      const now = Date.now();
      globalRunIdRef.current = `${now}`;
      const api = mapRef.current;
      if (api?.removeCameraPoints) {
        api.removeCameraPoints('__ALL__');
        api.removeCameraPoints('__POSES__');
      }
      setImportedPoses([]);
      poseAreaRingRef.current = [];
      setOverallStats({ gsd: null, density: null });
      setPerPolygonStats(new Map());
      onPosesImported?.(0); // notify parent
    }
  }, [mapRef, onPosesImported]);

  React.useEffect(() => {
    const api = mapRef.current;
    const map: any = api?.getMap?.();
    if (!map?.isStyleLoaded?.()) return;
    const polygonCount = api?.getPolygonsWithIds?.().length ?? 0;
    if (polygonCount !== 0 || importedPoses.length !== 0) return;

    const hasOverlayLayers = (map.getStyle?.().layers ?? []).some((layer: any) => String(layer?.id || '').startsWith('ogsd-'));
    const hasOverlaySources = Object.keys(map.getStyle?.().sources ?? {}).some((id) => id.startsWith('ogsd-'));
    const hasAnalysisState = perPolyTileStatsRef.current.size > 0 || perPolygonStats.size > 0 || !!overallStats.gsd || !!overallStats.density;
    if (hasOverlayLayers || hasOverlaySources || hasAnalysisState) {
      clear();
    }
  }, [clear, importedPoses.length, mapRef, overallStats.density, overallStats.gsd, perPolygonStats, polygonAnalyses.length]);

  // Provide clear function to parent so header and Map can invoke it
  React.useEffect(() => {
    onClearExposed?.(clear);
  }, [clear, onClearExposed]);

  const handlePoseFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const text = evt.target?.result as string;
        const obj = JSON.parse(text);

        // 1) Wingtra geotags (preferred when user selected Wingtra or auto-detected)
        let wingtraResult: ReturnType<typeof parseWingtraGeotags> | null = null;
        if (poseImportKind !== 'dji') {
          wingtraResult = parseWingtraGeotags(obj);
        }

        if (wingtraResult) {
          applyImportedPoses(wingtraResult.poses, wingtraResult.camera, wingtraResult.cameraKey, wingtraResult.sourceLabel || 'Wingtra');
          return;
        }

        // 2) DJI OPF input_cameras.json
        const posesWgs = extractPoses(obj);
        const djiCam = extractCameraModel(obj);
        let matchedRegistryKey: string | null = null;
        if (djiCam) {
          // Try to match against known cameras (same dimensions + ~5% focal length tolerance)
          for (const [key, cam] of Object.entries(CAMERA_REGISTRY)) {
            if (cam.w_px === djiCam.w_px && cam.h_px === djiCam.h_px) {
              const relErr = Math.abs(cam.f_m - djiCam.f_m) / cam.f_m;
              if (relErr < 0.05) { matchedRegistryKey = key; break; }
            }
          }
          const camPayload = matchedRegistryKey ? CAMERA_REGISTRY[matchedRegistryKey] : djiCam;
          setCameraText(JSON.stringify(camPayload, null, 2));
          // Auto‑enable override so imported intrinsics are actually used
          setUseOverrideCamera(true);
        }
        const posesMeters: PoseMeters[] = posesWgs.map((p, i) => {
          const { x, y } = wgs84ToWebMercator(p.lat, p.lon);
          return { id: p.id ?? `pose_${i}`, x, y, z: p.alt ?? 0, omega_deg: p.roll ?? 0, phi_deg: p.pitch ?? 0, kappa_deg: p.yaw ?? 0 } as PoseMeters;
        });
        applyImportedPoses(posesMeters, djiCam ?? null, matchedRegistryKey, 'DJI');
      } catch (error) {
        toast({ variant: "destructive", title: "Invalid file", description: "Unable to parse Wingtra geotags or DJI OPF input_cameras.json" });
        onPosesImported?.(0);
      }
    };
    reader.readAsText(file);
    // Allow selecting the same file again by resetting the input element
    e.target.value = "";
  }, [applyImportedPoses, parseWingtraGeotags, poseImportKind, CAMERA_REGISTRY, onPosesImported]);

  React.useEffect(()=>{
    if (onExposePoseImporter) {
      onExposePoseImporter((mode?: 'dji' | 'wingtra') => {
        setPoseImportKind(mode ?? 'auto');
        poseFileRef.current?.click();
      });
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

  const formatMetricValue = useCallback((metricKind: MetricKind, value: number, precision = 1) => {
    if (metricKind === 'density') return `${value.toFixed(precision)} pts/m²`;
    return `${(value * 100).toFixed(precision)} cm`;
  }, []);

  const metricLabels = useCallback((metricKind: MetricKind) => {
    if (metricKind === 'density') {
      return {
        title: 'Predicted Point Density',
        min: 'Min density',
        mean: 'Mean density',
        max: 'Max density',
        xAxis: 'Density (pts/m²)',
        tooltipLabel: 'Predicted density',
      };
    }
    return {
      title: 'GSD',
      min: 'Min GSD',
      mean: 'Mean GSD',
      max: 'Max GSD',
      xAxis: 'GSD (cm)',
      tooltipLabel: 'GSD',
    };
  }, []);

  const overallCards = useMemo(() => {
    const cards: Array<{ metricKind: MetricKind; stats: GSDStats }> = [];
    if (overallStats.gsd?.count) cards.push({ metricKind: 'gsd', stats: overallStats.gsd });
    if (overallStats.density?.count) cards.push({ metricKind: 'density', stats: overallStats.density });
    return cards;
  }, [overallStats]);
  const displayParamsMap = getMergedParamsMap();
  const lidarPolygonIds = (mapRef.current?.getPolygonsWithIds?.() ?? [])
    .map((polygon) => polygon.id || 'unknown')
    .filter((polygonId) => isLidarPayload(polygonId, displayParamsMap));
  const lidarRangeValues = lidarPolygonIds.map((polygonId) => {
    const value = displayParamsMap[polygonId]?.maxLidarRangeM;
    return Number.isFinite(value) ? value : DEFAULT_LIDAR_MAX_RANGE_M;
  });
  const lidarRangeMixed = lidarRangeValues.length > 1 && lidarRangeValues.some((value) => Math.abs(value - lidarRangeValues[0]) > 1e-6);
  const lidarRangeSharedValue = lidarRangeValues.length > 0 && !lidarRangeMixed ? String(lidarRangeValues[0]) : '';
  const [bulkLidarRangeInput, setBulkLidarRangeInput] = useState<string>(String(DEFAULT_LIDAR_MAX_RANGE_M));

  React.useEffect(() => {
    if (lidarPolygonIds.length === 0) {
      setBulkLidarRangeInput(String(DEFAULT_LIDAR_MAX_RANGE_M));
      return;
    }
    setBulkLidarRangeInput(lidarRangeSharedValue);
  }, [lidarPolygonIds.join('|'), lidarRangeSharedValue]);

  const applyBulkLidarRange = useCallback((rawValue?: string) => {
    if (lidarPolygonIds.length === 0) return;
    const nextRange = parseFloat(rawValue ?? bulkLidarRangeInput);
    if (!(nextRange > 0)) {
      toast({
        variant: 'destructive',
        title: 'Invalid lidar range',
        description: 'Enter a max lidar range greater than 0 meters.',
      });
      setBulkLidarRangeInput(lidarRangeSharedValue);
      return;
    }

    const api = mapRef.current;
    const paramsMap = getMergedParamsMap();
    const updates = lidarPolygonIds
      .map((polygonId) => {
        const currentParams = paramsMap[polygonId];
        if (!currentParams) return null;
        return {
          polygonId,
          params: {
            ...currentParams,
            maxLidarRangeM: nextRange,
          },
        };
      })
      .filter((update): update is { polygonId: string; params: any } => update !== null);
    if (updates.length === 0) return;

    if (api?.applyPolygonParamsBatch) {
      api.applyPolygonParamsBatch(updates);
    } else {
      for (const update of updates) {
        api?.applyPolygonParams?.(update.polygonId, update.params);
      }
    }
    setBulkLidarRangeInput(String(nextRange));
  }, [bulkLidarRangeInput, getMergedParamsMap, lidarPolygonIds, lidarRangeSharedValue, mapRef]);

  return (
    <div className="backdrop-blur-md bg-white/95 rounded-md border p-3 space-y-3">
      <input
        ref={poseFileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handlePoseFileChange}
      />
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-900">Coverage Analysis</h3>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <label className="text-xs col-span-1">
          <input type="checkbox" checked={showGsd} onChange={e=>setShowGsd(e.target.checked)} className="mr-2" />
          <span className="font-medium">Show analysis overlay</span>
        </label>
      </div>

      <div className="space-y-2">
        {combinedPolygons.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-xs text-gray-500">
              No polygons analyzed yet.
            </CardContent>
          </Card>
        ) : (
          combinedPolygons.map(({ polygonId, analysis, stats }) => {
            const { displayName, shortId } = getPolygonDisplayName(polygonId);
            const overrideInfo = overrides?.[polygonId];
            const directionSource = overrideInfo?.source === 'user'
              ? 'Custom'
              : overrideInfo?.source === 'wingtra'
                ? 'File'
                : 'Terrain';
            const directionDeg = (overrideInfo?.bearingDeg ?? analysis?.result?.contourDirDeg ?? 0).toFixed(1);
            const fromFile = !!importedOriginals?.[polygonId];
            const metricKind = stats?.metricKind ?? (isLidarPayload(polygonId, displayParamsMap) ? 'density' : 'gsd');
            const metricStats = stats?.stats;
            const labels = metricLabels(metricKind);
            const areaAcres = stats?.areaAcres ?? 0;
            const sampleCount = stats?.sampleCount ?? 0;
            const sampleLabel = stats?.sampleLabel ?? (metricKind === 'density' ? 'Flight lines' : 'Images');
            const sourceLabel = stats?.sourceLabel;
            const isSelected = activeSelectedId === polygonId;
            const isPoseArea = polygonId === '__POSES__';

            return (
              <Card
                key={polygonId}
                ref={(node) => {
                  if (node) {
                    itemRefs.current.set(polygonId, node);
                  } else {
                    itemRefs.current.delete(polygonId);
                  }
                }}
                className={`mt-2 transition-shadow border-l-4 ${isSelected ? 'border-l-blue-500 shadow-lg ring-1 ring-blue-400' : 'border-l-transparent hover:shadow-md'}`}
                onClick={() => {
                  setSelection(polygonId);
                  highlightPolygon(polygonId);
                }}
              >
                <CardContent className="p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-gray-900">{displayName}</div>
                      <div className="text-xs text-gray-500 font-mono">#{shortId}</div>
                    </div>
                    <Badge variant="outline" className="text-[10px] uppercase tracking-wide">{directionSource}</Badge>
                  </div>

                  <div className="bg-blue-50 rounded-lg p-2 flex items-center justify-between">
                    <span className="text-sm font-medium text-blue-900">Flight Direction</span>
                    <span className="font-mono text-lg font-bold text-blue-700">{directionDeg}°</span>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {!isPoseArea && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelection(polygonId);
                          onEditPolygonParams?.(polygonId);
                        }}
                        title="Edit flight parameters for this area"
                      >
                        Edit setup
                      </Button>
                    )}

                    {!isPoseArea && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 px-2 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelection(polygonId);
                          highlightPolygon(polygonId);
                          mapRef.current?.editPolygonBoundary?.(polygonId);
                        }}
                        title="Edit polygon vertices on the map"
                      >
                        Edit boundary
                      </Button>
                    )}

                    <Button
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={isPoseArea}
                      onClick={(e) => {
                        e.stopPropagation();
                        mapRef.current?.optimizePolygonDirection?.(polygonId);
                        setTimeout(() => setSelection(polygonId), 0);
                      }}
                      title="Use terrain-optimal direction"
                    >
                      🎯 Optimize
                    </Button>

                    {fromFile && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        disabled={overrideInfo?.source === 'wingtra'}
                        onClick={(e) => {
                          e.stopPropagation();
                          mapRef.current?.revertPolygonToImportedDirection?.(polygonId);
                          setTimeout(() => setSelection(polygonId), 0);
                        }}
                        title="Restore Wingtra file bearing/spacing"
                      >
                        📁 File dir
                      </Button>
                    )}

                    {fromFile && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          mapRef.current?.runFullAnalysis?.(polygonId);
                        }}
                        title="Clear overrides and rerun terrain analysis"
                      >
                        🔄 Full
                      </Button>
                    )}

                    {!isPoseArea && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs ml-auto text-red-500"
                        onClick={(e) => {
                          e.stopPropagation();
                          mapRef.current?.clearPolygon?.(polygonId);
                          setTimeout(() => setSelection(null), 0);
                        }}
                        title="Delete polygon"
                      >
                        Delete area
                      </Button>
                    )}
                  </div>

                  {metricStats ? (
                    <div className="space-y-2">
                      <div className="grid grid-cols-3 gap-3 text-xs">
                        <div className="text-center">
                          <div className="font-medium text-green-600">{formatMetricValue(metricKind, metricStats.min, metricKind === 'density' ? 0 : 1)}</div>
                          <div className="text-gray-500">{labels.min}</div>
                        </div>
                        <div className="text-center">
                          <div className="font-medium text-blue-600">{formatMetricValue(metricKind, metricStats.mean, metricKind === 'density' ? 1 : 2)}</div>
                          <div className="text-gray-500">{labels.mean}</div>
                        </div>
                        <div className="text-center">
                          <div className="font-medium text-red-600">{formatMetricValue(metricKind, metricStats.max, metricKind === 'density' ? 0 : 1)}</div>
                          <div className="text-gray-500">{labels.max}</div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3 text-xs text-gray-600">
                        <div>{sampleLabel}: <span className="font-medium text-gray-900">{sampleCount}</span></div>
                        <div>Area: <span className="font-medium text-gray-900">{areaAcres.toFixed(2)} acres</span></div>
                        {sourceLabel && <div className="col-span-2">System: <span className="font-medium text-gray-900">{sourceLabel}</span></div>}
                      </div>

                      <div className="h-40">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={convertHistogramToArea(metricStats).map(bin => ({ metric: metricKind === 'density' ? bin.bin.toFixed(0) : (bin.bin * 100).toFixed(1), areaM2: bin.areaM2, areaAcres: bin.areaM2 / ACRE_M2 }))}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                            <XAxis dataKey="metric" tick={{ fontSize: 10 }} label={{ value: labels.xAxis, position: 'insideBottom', offset: -5, style: { fontSize: '10px' } }} />
                            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v:number)=> (v/ACRE_M2).toFixed(2)} label={{ value: 'Area (acres)', angle: -90, position: 'insideLeft', style: { fontSize: '10px' } }} />
                            <Tooltip
                              formatter={(value)=>{ const m2=value as number; const acres=m2/ACRE_M2; return [`${acres.toFixed(2)} acres (${m2.toFixed(0)} m²)`, 'Area']; }}
                              labelFormatter={(label)=> `${labels.tooltipLabel}: ${label}${metricKind === 'density' ? ' pts/m²' : ' cm'}`}
                              labelStyle={{ fontSize: '11px' }}
                              contentStyle={{ fontSize: '11px' }}
                            />
                            <Bar dataKey="areaM2" fill="#3b82f6" stroke="#1e40af" strokeWidth={0.5} radius={[1,1,0,0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-gray-500">
                      {metricKind === 'density'
                        ? 'Point density analysis will appear after lidar flight lines are generated.'
                        : 'GSD analysis will appear after camera flight lines are generated.'}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {overallCards.map(({ metricKind, stats }) => {
        const labels = metricLabels(metricKind);
        return (
          <Card className="mt-2" key={metricKind}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Overall {labels.title} Analysis</CardTitle>
              <CardDescription className="text-xs">Cumulative {labels.title.toLowerCase()} statistics for {stats.count.toLocaleString()} pixels</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-4 text-xs">
                <div className="text-center"><div className="font-medium text-green-600">{formatMetricValue(metricKind, stats.min, metricKind === 'density' ? 0 : 1)}</div><div className="text-gray-500">{labels.min}</div></div>
                <div className="text-center"><div className="font-medium text-blue-600">{formatMetricValue(metricKind, stats.mean, metricKind === 'density' ? 1 : 2)}</div><div className="text-gray-500">{labels.mean}</div></div>
                <div className="text-center"><div className="font-medium text-red-600">{formatMetricValue(metricKind, stats.max, metricKind === 'density' ? 0 : 1)}</div><div className="text-gray-500">{labels.max}</div></div>
              </div>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={convertHistogramToArea(stats).map(bin => ({ metric: metricKind === 'density' ? bin.bin.toFixed(0) : (bin.bin * 100).toFixed(1), areaM2: bin.areaM2, areaAcres: bin.areaM2 / ACRE_M2 }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="metric" tick={{ fontSize: 10 }} label={{ value: labels.xAxis, position: 'insideBottom', offset: -5, style: { fontSize: '10px' } }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v:number)=> (v/ACRE_M2).toFixed(2)} label={{ value: 'Area (acres)', angle: -90, position: 'insideLeft', style: { fontSize: '10px' } }} />
                    <Tooltip
                      formatter={(value)=>{ const m2=value as number; const acres=m2/ACRE_M2; return [`${acres.toFixed(2)} acres (${m2.toFixed(0)} m²)`, 'Area']; }}
                      labelFormatter={(label)=> `${labels.tooltipLabel}: ${label}${metricKind === 'density' ? ' pts/m²' : ' cm'}`}
                      labelStyle={{ fontSize: '11px' }}
                      contentStyle={{ fontSize: '11px' }}
                    />
                    <Bar dataKey="areaM2" fill="#3b82f6" stroke="#1e40af" strokeWidth={0.5} radius={[1,1,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <div className="grid grid-cols-1 gap-2">
        <div className="space-y-2">
          <div className="text-xs font-medium mb-1">Flight Parameters</div>
          <label className="text-xs text-gray-600 block">
            Altitude mode
            <select
              className="w-full border rounded px-2 py-1 text-xs mt-1"
              value={altitudeModeUI}
              onChange={(e)=>{
                const m = (e.target.value as 'legacy'|'min-clearance');
                setAltitudeModeUI(m);
                const api = mapRef.current as any;
                if (api?.setAltitudeMode) api.setAltitudeMode(m);
                setTimeout(()=>{ compute(); }, 0);
              }}
            >
              <option value="legacy">Legacy (highest ground + AGL)</option>
              <option value="min-clearance">Min-clearance (lowest + AGL; enforce clearance)</option>
            </select>
          </label>
          <label className="text-xs text-gray-600 block">Min clearance (m)
            <input
              className="w-full border rounded px-2 py-1 text-xs"
              type="number"
              min={0}
              value={minClearanceUI}
              onChange={(e)=>{
                const v = Math.max(0, parseFloat(e.target.value||'60'));
                setMinClearanceUI(v);
                const api = mapRef.current as any;
                if (api?.setMinClearance) api.setMinClearance(v);
                setTimeout(()=>{ compute(); }, 0);
              }}
            />
          </label>
          <label className="text-xs text-gray-600 block">Turn extend (m)
            <input
              className="w-full border rounded px-2 py-1 text-xs"
              type="number"
              min={0}
              value={turnExtendUI}
              onChange={(e)=>{
                const v = Math.max(0, parseFloat(e.target.value||'96'));
                setTurnExtendUI(v);
                const api = mapRef.current as any;
                if (api?.setTurnExtend) api.setTurnExtend(v);
                setTimeout(()=>{ compute(); }, 0);
              }}
            />
          </label>
          {lidarPolygonIds.length > 0 && (
            <label className="text-xs text-gray-600 block">
              Max lidar range for all areas (m)
              <input
                className="w-full border rounded px-2 py-1 text-xs"
                type="number"
                min={1}
                step={1}
                value={bulkLidarRangeInput}
                placeholder={lidarRangeMixed ? 'Mixed' : undefined}
                onChange={(e) => setBulkLidarRangeInput(e.target.value)}
                onBlur={(e) => applyBulkLidarRange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyBulkLidarRange((e.target as HTMLInputElement).value);
                  }
                }}
              />
              <span className="block mt-1 text-[11px] text-gray-500">
                {lidarRangeMixed
                  ? `Different values are set across ${lidarPolygonIds.length} lidar areas. Enter one value and press Enter or click away to apply it to all.`
                  : `Applies to all ${lidarPolygonIds.length} lidar area${lidarPolygonIds.length === 1 ? '' : 's'}.`}
              </span>
            </label>
          )}
          <label className="text-xs text-gray-600 block">Max tilt (deg)<input className="w-full border rounded px-2 py-1 text-xs" type="number" min={0} max={90} value={maxTiltDeg} onChange={e=>setMaxTiltDeg(Math.max(0, Math.min(90, parseFloat(e.target.value||'10'))))} /></label>
          <label className="text-xs text-gray-600 block">
            Min overlap for GSD (images)
            <input
              className="w-full border rounded px-2 py-1 text-xs"
              type="number"
              min={1}
              max={10}
              value={minOverlapForGsd}
              onChange={(e)=>{
                const v = Math.max(1, Math.min(10, Math.round(parseFloat(e.target.value || '3'))));
                minOverlapForGsdRef.current = v;
                setMinOverlapForGsd(v);
                setTimeout(()=>{ compute(); }, 0);
              }}
            />
          </label>
          {autoGenerate && <div className="text-xs text-gray-500">{parsePosesMeters()?.length || 0} poses generated</div>}
        </div>
      </div>

      <div className="flex gap-2 items-center">
        <button onClick={() => compute()} disabled={running} className="h-8 px-2 rounded bg-blue-600 text-white text-xs disabled:opacity-50">{running ? 'Computing…' : 'Recompute Analysis'}</button>
      </div>

      <p className="text-[11px] text-gray-500">Automatic coverage analysis runs when polygons are created or flight parameters change.</p>
    </div>
  );
}

export default OverlapGSDPanel;
