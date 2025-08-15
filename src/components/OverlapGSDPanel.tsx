import React, { useCallback, useMemo, useRef, useState } from "react";
import type mapboxgl from "mapbox-gl";
import { OverlapWorker, fetchTerrainRGBA, tilesCoveringPolygon } from "@/overlap/controller";
import { addOrUpdateTileOverlay, clearRunOverlays } from "@/overlap/overlay";
import type { CameraModel, PoseMeters, PolygonLngLat, GSDStats } from "@/overlap/types";
import { lngLatToMeters } from "@/overlap/mercator";
import { sampleCameraPositionsOnFlightPath, build3DFlightPath } from "@/components/MapFlightDirection/utils/geometry";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Props = {
  // Ref to MapFlightDirection (must expose getMap() and getPolygons())
  mapRef: React.RefObject<any>;
  mapboxToken: string;
  onLineSpacingChange?: (lineSpacing: number) => void;
  onPhotoSpacingChange?: (photoSpacing: number) => void;
  onAltitudeChange?: (altitudeAGL: number) => void;
  onAutoRun?: (autoRunFn: () => void) => void; // NEW: Callback to provide auto-run function
};

// Sony RX1R II camera specifications
const sonyRX1R2Camera: CameraModel = {
  f_m: 0.035,          // 35 mm fixed lens
  sx_m: 4.88e-6,       // 4.88 µm pixel pitch (42.4MP full frame)
  sy_m: 4.88e-6,
  w_px: 7952,          // 7952 x 5304 pixels
  h_px: 5304,
};

export function OverlapGSDPanel({ mapRef, mapboxToken, onLineSpacingChange, onPhotoSpacingChange, onAltitudeChange, onAutoRun }: Props) {
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
  const runIdRef = useRef<string>("");
  const autoTriesRef = useRef(0);

  const parseCamera = useCallback((): CameraModel | null => {
    try { return JSON.parse(cameraText); } catch { return null; }
  }, [cameraText]);

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

    // Aggregate histograms by creating new bins across the full range
    const numBins = 20;
    const binSize = (totalMax - totalMin) / numBins;
    const histogram: { bin: number; count: number }[] = [];
    
    for (let i = 0; i < numBins; i++) {
      const binStart = totalMin + i * binSize;
      const binEnd = binStart + binSize;
      const binCenter = binStart + binSize / 2;
      
      // Sum counts from all tiles for this bin range
      let binCount = 0;
      validStats.forEach(stat => {
        stat.histogram.forEach(bin => {
          const binBinStart = bin.bin - (stat.max - stat.min) / (stat.histogram.length * 2);
          const binBinEnd = bin.bin + (stat.max - stat.min) / (stat.histogram.length * 2);
          
          // Check if this histogram bin overlaps with our aggregated bin
          if (binBinEnd > binStart && binBinStart < binEnd) {
            binCount += bin.count;
          }
        });
      });
      
      histogram.push({ bin: binCenter, count: binCount });
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

  // Notify parent when line spacing changes
  React.useEffect(() => {
    onLineSpacingChange?.(lineSpacing);
  }, [lineSpacing, onLineSpacingChange]);

  // Propagate photo spacing and altitude up so the map can render trigger ticks & 3D height
  React.useEffect(() => {
    onPhotoSpacingChange?.(photoSpacing);
  }, [photoSpacing, onPhotoSpacingChange]);

  React.useEffect(() => {
    onAltitudeChange?.(altitude);
  }, [altitude, onAltitudeChange]);

  // Generate poses from existing flight lines using 3D paths
  const generatePosesFromFlightLines = useCallback((): PoseMeters[] => {
    const api = mapRef.current;
    if (!api?.getFlightLines || !api?.getPolygonTiles) return [];
    
    const flightLinesMap = api.getFlightLines();
    const tilesMap = api.getPolygonTiles();
    const poses: PoseMeters[] = [];
    let poseId = 0;

    // Process each polygon's flight lines using 3D paths
    for (const [polygonId, { flightLines, lineSpacing }] of flightLinesMap) {
      const tiles = tilesMap.get(polygonId) || [];
      
      if (flightLines.length === 0 || tiles.length === 0) continue;
      
      // Use the same 3D flight path building logic as the visualization
      const path3D = build3DFlightPath(
        flightLines, 
        tiles, 
        lineSpacing, 
        altitude  // height above ground (AGL)
      );
      
      // Sample camera positions along the 3D flight path
      const cameraPositions = sampleCameraPositionsOnFlightPath(path3D, photoSpacing);
      
      // Convert to poses format
      cameraPositions.forEach(([lng, lat, altMSL, yawDeg]) => {
        // Convert to EPSG:3857 meters
        const [x, y] = lngLatToMeters(lng, lat);
        
        poses.push({
          id: `photo_${poseId++}`,
          x, y, z: altMSL,  // altitude is already MSL from the 3D flight path
          omega_deg: 0,     // level (nadir)
          phi_deg: 0,       // level (nadir) 
          kappa_deg: yawDeg // flight direction yaw with no sideslip
        });
      });
    }
    
    return poses;
  }, [mapRef, altitude, photoSpacing]);

  const parsePosesMeters = useCallback((): PoseMeters[] | null => {
    if (autoGenerate) {
      return generatePosesFromFlightLines();
    }
    // Manual pose entry fallback could go here
    return [];
  }, [autoGenerate, generatePosesFromFlightLines]);

  const getPolygons = useCallback((): PolygonLngLat[] => {
    const api = mapRef.current;
    if (!api?.getPolygons) return [];
    const rings: [number,number][][] = api.getPolygons(); // each is ring: [lng,lat][]
    return rings.map(r => ({ ring: r }));
  }, [mapRef]);

  const compute = useCallback(async () => {
    const camera = parseCamera();
    const poses = parsePosesMeters();
    const polygons = getPolygons();

    if (!camera || !poses || poses.length===0 || polygons.length===0) {
      alert("Please provide valid camera, poses, and draw at least one polygon.");
      return;
    }

    const map: mapboxgl.Map | undefined = mapRef.current?.getMap?.();
    if (!map) { alert("Map not ready."); return; }

    // Clear previous overlays for this run
    if (runIdRef.current) clearRunOverlays(map, runIdRef.current);
    const runId = `${Date.now()}`; runIdRef.current = runId;

    setRunning(true);
    autoTriesRef.current = 0; // Reset retry counter when starting computation

    const worker = new OverlapWorker();
    try {
      // Collect tiles for all polygons (dedup)
      const seen = new Set<string>();
      const tiles: {z:number;x:number;y:number}[] = [];
      for (const poly of polygons) {
        for (const t of tilesCoveringPolygon(poly, zoom)) {
          const key = `${t.x}/${t.y}`; if (seen.has(key)) continue;
          seen.add(key); tiles.push({z: zoom, x: t.x, y: t.y});
        }
      }

      // Process sequentially for simplicity (can parallelize with multiple workers)
      const allGsdStats: GSDStats[] = [];
      for (const t of tiles) {
        const imgData = await fetchTerrainRGBA(t.z, t.x, t.y, mapboxToken);
        const tile = { z:t.z, x:t.x, y:t.y, size: imgData.width, data: imgData.data };
        const res = await worker.runTile({ tile, polygons, poses, camera } as any);

        // Collect GSD statistics from each tile
        if (res.gsdStats) {
          allGsdStats.push(res.gsdStats);
        }

        if (showOverlap) addOrUpdateTileOverlay(map, res, { kind: "overlap", runId, opacity });
        if (showGsd) addOrUpdateTileOverlay(map, res, { kind: "gsd", runId, opacity, gsdMax: 0.1 });
      }

      // Aggregate GSD statistics from all tiles
      const aggregatedStats = aggregateGSDStats(allGsdStats);
      setGsdStats(aggregatedStats);

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
          api.addCameraPoints(runId, cameraPositions);
        }
      }
    } finally {
      worker.terminate();
      setRunning(false);
    }
  }, [mapRef, mapboxToken, parseCamera, parsePosesMeters, getPolygons, zoom, opacity, showOverlap, showGsd, showCameraPoints]);

  // Auto-run function that can be called externally
  const autoRun = useCallback(async () => {
    if (!autoGenerate || running) return;
    
    const api = mapRef.current;
    const map = api?.getMap?.();
    const ready = !!map?.isStyleLoaded?.();
    const rings: [number, number][][] = api?.getPolygons?.() ?? [];
    const fl = api?.getFlightLines?.();
    const tiles = api?.getPolygonTiles?.();
    const haveLines = !!fl && Array.from(fl.values()).some((v: any) => v.flightLines.length > 0);
    const haveTiles = !!tiles && Array.from(tiles.values()).some((t: any) => (t?.length ?? 0) > 0);

    if (ready && rings.length > 0 && haveLines && haveTiles) {
      autoTriesRef.current = 0;
      compute(); // all prerequisites present
      return;
    }
    
    // Not ready yet — retry a few times while state settles, but only if not already retrying
    if (autoTriesRef.current < 5) { // Reduced retry count
      autoTriesRef.current += 1;
      setTimeout(() => {
        // Check again if we should still retry (component might have unmounted or conditions changed)
        if (autoGenerate && !running && autoTriesRef.current > 0) {
          autoRun();
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
    if (map && runIdRef.current) {
      clearRunOverlays(map, runIdRef.current);
      
      // Clear camera positions using the new 3D camera point methods
      const api = mapRef.current;
      if (api?.removeCameraPoints) {
        api.removeCameraPoints(runIdRef.current);
      }
      
      runIdRef.current = "";
      
      // Clear GSD statistics
      setGsdStats(null);
    }
  }, [mapRef]);

  return (
    <div className="backdrop-blur-md bg-white/95 rounded-md border p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-900">Overlap & GSD (Client)</h3>
        <div className="text-xs text-gray-500">WASM‑free prototype</div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-gray-600">Tile zoom
          <input className="w-full border rounded px-2 py-1 text-xs"
                 type="number" min={12} max={15} value={zoom}
                 onChange={e => setZoom(parseInt(e.target.value||"15",10))} />
        </label>
        <label className="text-xs text-gray-600">Opacity
          <input className="w-full" type="range" min={0.1} max={1} step={0.05}
                 value={opacity} onChange={e => setOpacity(parseFloat(e.target.value))} />
        </label>
        <label className="text-xs col-span-1">
          <input type="checkbox" checked={showGsd} onChange={e=>setShowGsd(e.target.checked)} className="mr-2" />
          <span className="font-medium">Show GSD (Primary)</span>
        </label>
        <label className="text-xs col-span-1">
          <input type="checkbox" checked={showOverlap} onChange={e=>setShowOverlap(e.target.checked)} className="mr-2" />
          Show overlap count
        </label>
        <label className="text-xs col-span-2">
          <input type="checkbox" checked={showCameraPoints} onChange={e=>setShowCameraPoints(e.target.checked)} className="mr-2" />
          Show camera positions
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-xs font-medium mb-1">Sony RX1R II Camera</div>
          <textarea className="w-full h-24 border rounded p-2 text-xs font-mono"
                    value={cameraText} onChange={e=>setCameraText(e.target.value)} />
        </div>
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
        <button onClick={compute} disabled={running}
                className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm disabled:opacity-50">
          {running ? "Computing…" : "Manual Compute"}
        </button>
        <button onClick={clear}
                className="px-3 py-1.5 rounded border text-sm">
          Clear overlay
        </button>
      </div>

      {/* GSD Statistics and Histogram */}
      {gsdStats && gsdStats.count > 0 && (
        <Card className="mt-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">GSD Analysis Results</CardTitle>
            <CardDescription className="text-xs">
              Ground Sample Distance statistics for {gsdStats.count.toLocaleString()} pixels
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

      <p className="text-[11px] text-gray-500">
        <strong>Auto-mode:</strong> GSD analysis runs automatically when polygons are created or flight parameters change.
        Uses Sony RX1R II specs (35mm, 42MP) with automatic pose generation. Computes <em>Ground Sample Distance</em> 
        and optional <em>overlap count</em> per terrain pixel using nadir photography.
      </p>
    </div>
  );
}

export default OverlapGSDPanel;
