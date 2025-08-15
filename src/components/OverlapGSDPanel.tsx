import React, { useCallback, useMemo, useRef, useState } from "react";
import type mapboxgl from "mapbox-gl";
import { OverlapWorker, fetchTerrainRGBA, tilesCoveringPolygon } from "@/overlap/controller";
import { addOrUpdateTileOverlay, clearRunOverlays } from "@/overlap/overlay";
import type { CameraModel, PoseMeters, PolygonLngLat } from "@/overlap/types";
import { lngLatToMeters } from "@/overlap/mercator";
import { sampleCameraPositionsOnFlightPath, build3DFlightPath } from "@/components/MapFlightDirection/utils/geometry";

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
  const [showCameraPoints, setShowCameraPoints] = useState(true);
  const runIdRef = useRef<string>("");

  const parseCamera = useCallback((): CameraModel | null => {
    try { return JSON.parse(cameraText); } catch { return null; }
  }, [cameraText]);

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
      for (const t of tiles) {
        const imgData = await fetchTerrainRGBA(t.z, t.x, t.y, mapboxToken);
        const tile = { z:t.z, x:t.x, y:t.y, size: imgData.width, data: imgData.data };
        const res = await worker.runTile({ tile, polygons, poses, camera } as any);

        if (showOverlap) addOrUpdateTileOverlay(map, res, { kind: "overlap", runId, opacity });
        if (showGsd) addOrUpdateTileOverlay(map, res, { kind: "gsd", runId, opacity, gsdMax: 0.1 });
      }

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
    
    // Wait for flight lines to be fully updated and map to be ready
    setTimeout(() => {
      const map = mapRef.current?.getMap?.();
      if (!map || !map.isStyleLoaded()) {
        console.warn('Map not ready for auto GSD analysis, skipping');
        return;
      }
      
      const polygons = getPolygons();
      if (polygons.length === 0) {
        console.warn('No polygons available for auto GSD analysis, skipping');
        return;
      }
      
      compute();
    }, 750); // Increased delay for better reliability
  }, [autoGenerate, running, compute, getPolygons, mapRef]);

  // Provide autoRun function to parent component
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

      <p className="text-[11px] text-gray-500">
        <strong>Auto-mode:</strong> GSD analysis runs automatically when polygons are created or flight parameters change.
        Uses Sony RX1R II specs (35mm, 42MP) with automatic pose generation. Computes <em>Ground Sample Distance</em> 
        and optional <em>overlap count</em> per terrain pixel using nadir photography.
      </p>
    </div>
  );
}

export default OverlapGSDPanel;
