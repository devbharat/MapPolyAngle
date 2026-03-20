import React, { Suspense, lazy, useState, useRef, useCallback, useMemo } from 'react';
import type { BearingOverride, MapFlightDirectionAPI } from '@/components/MapFlightDirection/api';
import type { PolygonAnalysisResult } from '@/components/MapFlightDirection/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useIsMobile } from '@/hooks/use-mobile';
import { Map, Trash2, AlertCircle, Upload, Download } from 'lucide-react';
import type { PolygonParams } from '@/components/MapFlightDirection/types';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { toast } from "@/hooks/use-toast";

const MapFlightDirection = lazy(async () => {
  const mod = await import('@/components/MapFlightDirection');
  return { default: mod.MapFlightDirection };
});

const OverlapGSDPanel = lazy(() => import('@/components/OverlapGSDPanel'));
const PolygonParamsDialog = lazy(() => import('@/components/PolygonParamsDialog'));

function DeferredPanelFallback() {
  return (
    <Card className="backdrop-blur-md bg-white/95">
      <CardContent className="p-6">
        <div className="flex items-center justify-center gap-2 text-sm text-gray-600">
          <LoadingSpinner size="sm" />
          <span>Loading analysis tools…</span>
        </div>
      </CardContent>
    </Card>
  );
}

function DeferredMapFallback() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-gray-100">
      <div className="flex items-center gap-3 rounded-lg bg-white/90 px-4 py-3 text-sm text-gray-700 shadow-sm">
        <LoadingSpinner size="sm" />
        <span>Loading map workspace…</span>
      </div>
    </div>
  );
}

export default function Home() {
  const isMobile = useIsMobile();
  const mapRef = useRef<MapFlightDirectionAPI>(null);

  const [polygonResults, setPolygonResults] = useState<PolygonAnalysisResult[]>([]);
  const [analyzingPolygons, setAnalyzingPolygons] = useState<Set<string>>(new Set());

  // NEW: per‑polygon flight parameters
  const [paramsByPolygon, setParamsByPolygon] = useState<Record<string, PolygonParams>>({});
  const [paramsDialog, setParamsDialog] = useState<{ open: boolean; polygonId: string | null }>({ open: false, polygonId: null });

  // Imported/or override state (queried from Map component)
  const [importedOriginals, setImportedOriginals] = useState<Record<string, { bearingDeg: number; lineSpacingM: number }>>({});
  const [overrides, setOverrides] = useState<Record<string, BearingOverride>>({});
  const [selectedPolygonId, setSelectedPolygonId] = useState<string | null>(null);
  // NEW: track imported pose count
  const [importedPoseCount, setImportedPoseCount] = useState(0);

  // Auto-run GSD analysis when flight lines are updated (already wired)
  const autoRunGSDRef = useRef<((opts?: { polygonId?: string; reason?: 'lines'|'spacing'|'alt'|'manual' }) => void) | null>(null);
  const clearGSDRef = useRef<(() => void) | null>(null);
  // NEW: ref to open pose JSON importer (DJI or Wingtra) inside OverlapGSDPanel
  const openDJIImporterRef = useRef<((mode?: 'dji' | 'wingtra') => void) | null>(null);

  const sampleStep = 1;
  const mapboxToken = useMemo(() =>
    import.meta.env.VITE_MAPBOX_TOKEN ||
    import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ||
    "", []
  );

  // Use useMemo to prevent center from being recreated on every render
  const center = useMemo<[number, number]>(() => [8.54, 47.37], []);
  const initialZoom = useMemo(() => 13, []);

  // Expose mapRef to window for console testing
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      if (mapRef.current) {
        (window as any).mapApi = mapRef.current;
        console.log('🔧 Map API available as window.mapApi for console testing');
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // Memoize handlers to prevent unnecessary re-renders
  const handleAnalysisStart = useCallback((polygonId: string) => {
    setAnalyzingPolygons(prev => new Set(prev).add(polygonId));
  }, []);

  const handleAnalysisComplete = useCallback((results: PolygonAnalysisResult[]) => {
    console.log('[home] handleAnalysisComplete', {
      resultIds: results.map((result) => result.polygonId),
    });
    setPolygonResults(results);
    setAnalyzingPolygons(new Set()); // Clear all analyzing states
    const api = mapRef.current;
    if (api) {
      const imported = api.getImportedOriginals?.() ?? {};
      const overrides = api.getBearingOverrides?.() ?? {};
      setImportedOriginals(imported);
      setOverrides(overrides);
      const mapParams = api.getPerPolygonParams?.() ?? {};
      setParamsByPolygon(mapParams as any);
      console.log('[home] synced map state after analysis complete', {
        importedOriginalIds: Object.keys(imported),
        overrideIds: Object.keys(overrides),
        polygonParamIds: Object.keys(mapParams),
      });
    }
  }, []);

  const handleError = useCallback((error: string, polygonId?: string) => {
    if (polygonId) {
      setAnalyzingPolygons(prev => {
        const newSet = new Set(prev);
        newSet.delete(polygonId);
        return newSet;
      });
    }
    toast({
      variant: 'destructive',
      title: 'Action failed',
      description: error,
    });
  }, []);

  // MapFlightDirection now calls us to request params per polygon
  const handleRequestParams = useCallback((polygonId: string) => {
    setParamsDialog({ open: true, polygonId });
  }, []);

  const handleEditPolygonParams = useCallback((polygonId: string) => {
    setSelectedPolygonId(polygonId);
    setParamsDialog({ open: true, polygonId });
  }, []);

  const handleApplyParams = useCallback((params: PolygonParams) => {
    const polygonId = paramsDialog.polygonId!;
    mapRef.current?.applyPolygonParams?.(polygonId, params);
    const updated = mapRef.current?.getPerPolygonParams?.() || {};
    setParamsByPolygon(updated as any);
    setParamsDialog({ open: false, polygonId: null });
  }, [paramsDialog.polygonId]);

  const handleCloseParams = useCallback(() => {
    setParamsDialog({ open: false, polygonId: null });
  }, []);

  const handleFlightLinesUpdated = useCallback((which: string | '__all__') => {
    const api = mapRef.current;
    const polygons = api?.getPolygonsWithIds?.() ?? [];

    if (api) {
      setImportedOriginals(api.getImportedOriginals?.() ?? {});
      setOverrides(api.getBearingOverrides?.() ?? {});
      const mapParams = api.getPerPolygonParams?.() ?? {};
      setParamsByPolygon(mapParams as any);
    }

    if (polygons.length === 0 && importedPoseCount === 0) {
      clearGSDRef.current?.();
      setSelectedPolygonId(null);
      return;
    }

    if (autoRunGSDRef.current) {
      if (which === '__all__') autoRunGSDRef.current({ reason: 'spacing' });
      else autoRunGSDRef.current({ polygonId: which, reason: 'lines' });
    }
  }, [importedPoseCount]);

  // Handler to receive the auto-run function from OverlapGSDPanel
  const handleAutoRunReceived = useCallback((autoRunFn: (opts?: { polygonId?: string; reason?: 'lines'|'spacing'|'alt'|'manual' }) => void) => {
    autoRunGSDRef.current = autoRunFn;
    // Don't call immediately—only when MapFlightDirection tells us something changed
  }, []);

  // Handler to receive the clear function from OverlapGSDPanel
  const handleClearReceived = useCallback((clearFn: () => void) => {
    clearGSDRef.current = clearFn;
  }, []);

  // Also refresh overrides when results change
  React.useEffect(() => {
    if (mapRef.current) {
      setImportedOriginals(mapRef.current.getImportedOriginals?.() ?? {});
      setOverrides(mapRef.current.getBearingOverrides?.() ?? {});
      const mapParams = mapRef.current.getPerPolygonParams?.() ?? {};
      setParamsByPolygon(mapParams as any);
    }
  }, [polygonResults.length]);

  const clearAllDrawings = useCallback(() => {
    mapRef.current?.clearAllDrawings?.();
    clearGSDRef.current?.(); // Clear GSD overlays and analysis
    setPolygonResults([]);
    setAnalyzingPolygons(new Set());
    setParamsByPolygon({});
    setImportedOriginals({});
    setOverrides({});
    setSelectedPolygonId(null);
  }, []);

  // helper to export Wingtra flight plan
  const handleExportWingtra = useCallback(() => {
    const api = mapRef.current; if (!api?.exportWingtraFlightPlan) return;
    const { blob } = api.exportWingtraFlightPlan();
    const original = api.getLastImportedFlightplanName?.();
    const fn = (original && /\.flightplan$/.test(original)) ? original.replace(/\.flightplan$/, '-exported.flightplan') : 'exported.flightplan';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fn; document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 1000);
  }, []);

  if (!mapboxToken) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-gray-50">
        <Card className="w-full max-w-md mx-4">
          <CardContent className="pt-6">
            <div className="flex mb-4 gap-2">
              <AlertCircle className="h-8 w-8 text-red-500" />
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Missing Mapbox Token</h1>
                <p className="text-sm text-gray-600 mt-2">
                  Please set your Mapbox access token in the environment variables:
                </p>
                <code className="block bg-gray-100 p-2 rounded text-xs mt-2">
                  VITE_MAPBOX_TOKEN=your_token_here
                </code>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isAnalyzing = analyzingPolygons.size > 0;
  const hasResults = polygonResults.length > 0;
  const hasImportedPolygons = Object.keys(importedOriginals).length > 0;
  const hasPolygonsToAnalyze = hasResults || hasImportedPolygons;
  const panelEnabled = hasPolygonsToAnalyze || importedPoseCount>0; // enable if poses-only

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header (compact) */}
      <header className="bg-white/95 backdrop-blur border-b border-gray-200 px-3 md:px-4 py-2 z-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-blue-600 rounded-md flex items-center justify-center">
              <Map className="w-4 h-4 text-white" />
            </div>
            <div className="leading-tight">
              <h1 className="text-sm md:text-base font-semibold text-gray-900 tracking-tight">
                Flight Plan Analyser
              </h1>
              <p className="hidden md:block text-[11px] text-gray-500">
                Terrain‑aware flight planning &amp; GSD analysis
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Consolidated Import dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="h-8 px-2 whitespace-nowrap">
                  <Upload className="w-3 h-3 mr-1" /> Import ▾
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>Import</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => mapRef.current?.openFlightplanFilePicker?.()}>
                  Wingtra Flightplan (.flightplan)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => mapRef.current?.openKmlFilePicker?.()}>
                  KML Polygons (.kml)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openDJIImporterRef.current?.('dji')}>
                  DJI Camera JSON (input_cameras.json)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openDJIImporterRef.current?.('wingtra')}>
                  Wingtra Geotags (.json)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Consolidated Export dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="h-8 px-2 whitespace-nowrap" title="Export data">
                  <Download className="w-3 h-3 mr-1" /> Export ▾
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>Export</DropdownMenuLabel>
                <DropdownMenuItem onSelect={handleExportWingtra}>
                  Wingtra Flightplan
                </DropdownMenuItem>
                {/* Future export targets */}
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled>
                  CSV Report (soon)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2 whitespace-nowrap"
              onClick={clearAllDrawings}
            >
              <Trash2 className="w-3 h-3 mr-1" />
              Clear All
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 relative">
        {/* PER‑POLYGON PARAMS DIALOG */}
        <Suspense fallback={null}>
        {(() => {
          const pid = paramsDialog.polygonId || "";
          const mapParams = mapRef.current?.getPerPolygonParams?.() || {} as any;
          const current = mapParams[pid] || paramsByPolygon[pid] || {} as any;
          return (
        <PolygonParamsDialog
          open={paramsDialog.open}
          polygonId={paramsDialog.polygonId}
          onClose={handleCloseParams}
          onSubmit={handleApplyParams}
          onSubmitAll={(params) => {
            mapRef.current?.applyParamsToAllPending?.(params);
            // Refresh local cache from source of truth
            const updated = mapRef.current?.getPerPolygonParams?.() || {};
            setParamsByPolygon(updated as any);
            setParamsDialog({ open: false, polygonId: null });
          }}
          defaults={{
            payloadKind: current.payloadKind ?? 'camera',
            altitudeAGL: current.altitudeAGL ?? 100,
            frontOverlap: current.frontOverlap ?? ((current.payloadKind ?? 'camera') === 'lidar' ? 0 : 70),
            sideOverlap: current.sideOverlap ?? 70,
            cameraKey: current.cameraKey ?? 'MAP61_17MM',
            lidarKey: current.lidarKey,
            cameraYawOffsetDeg: current.cameraYawOffsetDeg ?? 0,
            speedMps: current.speedMps,
            lidarReturnMode: current.lidarReturnMode,
            mappingFovDeg: current.mappingFovDeg,
            maxLidarRangeM: current.maxLidarRangeM,
            pointDensityPtsM2: current.pointDensityPtsM2,
            useCustomBearing: current.useCustomBearing ?? false,
            customBearingDeg: current.customBearingDeg ?? undefined,
          }}
        />); })()}
        </Suspense>

        {/* Right Side Panel - Combined Controls and Instructions - Hidden on mobile */}
        {!isMobile && (
          <div className="absolute top-2 right-2 z-40 w-[500px] max-w-[90vw] max-h-[calc(100vh-120px)] overflow-y-auto">

          {/* Unified Analysis Panel */}
          <Card className="backdrop-blur-md bg-white/95">
            <CardContent className="p-3 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-gray-900">Analysis</h3>
              </div>

              {isAnalyzing && (
                <div className="flex items-center justify-center py-4 border-b mb-3">
                  <div className="text-center">
                    <LoadingSpinner size="sm" className="mx-auto mb-2" />
                    <p className="text-xs text-gray-600">
                      Analyzing {analyzingPolygons.size} polygon{analyzingPolygons.size !== 1 ? 's' : ''}...
                    </p>
                  </div>
                </div>
              )}

              {!isAnalyzing && !hasResults && (
                <div className="text-center py-6 text-gray-500">
                  <p className="text-xs">Draw polygons to start analysis</p>
                  <p className="text-xs mt-1 text-gray-400">Support for multiple areas!</p>
                </div>
              )}

              {/* Multiple Polygon Results */}

              <div className={panelEnabled ? '' : 'opacity-50 pointer-events-none'}>
                <Suspense fallback={<DeferredPanelFallback />}>
                  <OverlapGSDPanel
                    mapRef={mapRef}
                    mapboxToken={mapboxToken}
                    getPerPolygonParams={() => paramsByPolygon}
                    onEditPolygonParams={handleEditPolygonParams}
                    onAutoRun={handleAutoRunReceived}
                    onClearExposed={handleClearReceived}
                    onExposePoseImporter={(fn)=>{ openDJIImporterRef.current = fn; }}
                    onPosesImported={(c)=> setImportedPoseCount(c)}
                    polygonAnalyses={polygonResults}
                    overrides={overrides}
                    importedOriginals={importedOriginals}
                    selectedPolygonId={selectedPolygonId}
                    onSelectPolygon={setSelectedPolygonId}
                  />
                </Suspense>
              </div>
            </CardContent>
          </Card>
        </div>
        )}

        {/* Map Container */}
        <Suspense fallback={<DeferredMapFallback />}>
          <MapFlightDirection
            ref={mapRef}
            mapboxToken={mapboxToken}
            center={center}
            zoom={initialZoom}
            sampleStep={sampleStep}
            onAnalysisStart={handleAnalysisStart}
            onAnalysisComplete={handleAnalysisComplete}
            onError={handleError}
            onRequestParams={handleRequestParams}
            onFlightLinesUpdated={handleFlightLinesUpdated}
            onClearGSD={() => clearGSDRef.current?.()}
            onPolygonSelected={setSelectedPolygonId}
          />
        </Suspense>
      </div>
    </div>
  );
}
