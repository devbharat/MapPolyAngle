import React, { useState, useRef, useCallback, useMemo } from 'react';
import { MapFlightDirection } from '@/components/MapFlightDirection';
import type { MapFlightDirectionAPI } from '@/components/MapFlightDirection/api';
import { PolygonAnalysisResult } from '@/components/MapFlightDirection/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useIsMobile } from '@/hooks/use-mobile';
import { Map, Trash2, CheckCircle, AlertCircle, TrendingUp, Target, X, Upload, Download } from 'lucide-react';
import OverlapGSDPanel from "@/components/OverlapGSDPanel";
import PolygonParamsDialog from "@/components/PolygonParamsDialog";
import type { PolygonParams } from '@/components/MapFlightDirection/types';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';

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
  const [overrides, setOverrides] = useState<Record<string, { bearingDeg: number; lineSpacingM?: number; source: 'wingtra' | 'user' }>>({});
  const [selectedPolygonId, setSelectedPolygonId] = useState<string | null>(null);
  // NEW: track imported pose count
  const [importedPoseCount, setImportedPoseCount] = useState(0);

  // Auto-run GSD analysis when flight lines are updated (already wired)
  const autoRunGSDRef = useRef<((opts?: { polygonId?: string; reason?: 'lines'|'spacing'|'alt'|'manual' }) => void) | null>(null);
  const clearGSDRef = useRef<(() => void) | null>(null);
  // NEW: ref to open DJI camera JSON importer inside OverlapGSDPanel
  const openDJIImporterRef = useRef<(() => void) | null>(null);
  
  const terrainZoom = 15; // This is now a fallback - actual zoom is calculated dynamically
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
    if (mapRef.current) {
      (window as any).mapApi = mapRef.current;
      console.log('🔧 Map API available as window.mapApi for console testing');
    }
  }, [mapRef.current]);

  // Memoize handlers to prevent unnecessary re-renders
  const handleAnalysisStart = useCallback((polygonId: string) => {
    setAnalyzingPolygons(prev => new Set(prev).add(polygonId));
  }, []);

  const handleAnalysisComplete = useCallback((results: PolygonAnalysisResult[]) => {
    setPolygonResults(results);
    setAnalyzingPolygons(new Set()); // Clear all analyzing states
  }, []);

  const handleError = useCallback((error: string, polygonId?: string) => {
    if (polygonId) {
      setAnalyzingPolygons(prev => {
        const newSet = new Set(prev);
        newSet.delete(polygonId);
        return newSet;
      });
    }
  }, []);

  // MapFlightDirection now calls us to request params per polygon
  const handleRequestParams = useCallback((polygonId: string) => {
    setParamsDialog({ open: true, polygonId });
  }, []);

  const handleApplyParams = useCallback((params: PolygonParams) => {
    const polygonId = paramsDialog.polygonId!;
    // Send params down to MapFlightDirection so it can draw lines + 3D path
    mapRef.current?.applyPolygonParams?.(polygonId, params);
    // Store for GSD per‑polygon camera sampling
    setParamsByPolygon(prev => ({ ...prev, [polygonId]: params }));
    setParamsDialog({ open: false, polygonId: null });
  }, [paramsDialog.polygonId]);

  const handleCloseParams = useCallback(() => {
    setParamsDialog({ open: false, polygonId: null });
  }, []);

  const handleFlightLinesUpdated = useCallback((which: string | '__all__') => {
    // trigger GSD recompute
    if (autoRunGSDRef.current) {
      if (which === '__all__') autoRunGSDRef.current({ reason: 'spacing' });
      else autoRunGSDRef.current({ polygonId: which, reason: 'lines' });
    }
    // refresh imported/override state from Map
    if (mapRef.current) {
      setImportedOriginals(mapRef.current.getImportedOriginals?.() ?? {});
      setOverrides(mapRef.current.getBearingOverrides?.() ?? {});
    }
  }, []);

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
  }, []);

  const clearSpecificPolygon = useCallback((polygonId: string) => {
    mapRef.current?.clearPolygon?.(polygonId);
    setParamsByPolygon(prev => {
      const { [polygonId]: removed, ...rest } = prev;
      return rest;
    });
  }, []);

  // Helper function to get quality indicator
  const getQualityIndicator = useCallback((quality?: string) => {
    switch (quality) {
      case 'excellent':
        return { color: 'text-green-600', bgColor: 'bg-green-100', icon: '●', label: 'Excellent' };
      case 'good':
        return { color: 'text-blue-600', bgColor: 'bg-blue-100', icon: '●', label: 'Good' };
      case 'fair':
        return { color: 'text-orange-600', bgColor: 'bg-orange-100', icon: '●', label: 'Fair' };
      case 'poor':
        return { color: 'text-red-600', bgColor: 'bg-red-100', icon: '●', label: 'Poor' };
      default:
        return { color: 'text-gray-600', bgColor: 'bg-gray-100', icon: '○', label: 'Unknown' };
    }
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

  // helper to export Wingtra flight plan
  const handleExportWingtra = useCallback(() => {
    const api = mapRef.current; if (!api?.exportWingtraFlightPlan) return;
    const { json, blob } = api.exportWingtraFlightPlan();
    const original = (mapRef.current as any)?.lastImportedFlightplanName;
    const fn = (original && /\.flightplan$/.test(original)) ? original.replace(/\.flightplan$/, '-exported.flightplan') : 'exported.flightplan';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fn; document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 1000);
  }, []);

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
                <DropdownMenuItem onSelect={() => openDJIImporterRef.current?.()}>
                  DJI Camera JSON (input_cameras.json)
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
        <PolygonParamsDialog
          open={paramsDialog.open}
          polygonId={paramsDialog.polygonId}
          onClose={handleCloseParams}
          onSubmit={handleApplyParams}
          onSubmitAll={(params) => {
            mapRef.current?.applyParamsToAllPending?.(params as any);
            // Refresh local cache from source of truth
            const updated = mapRef.current?.getPerPolygonParams?.() || {};
            setParamsByPolygon(updated as any);
            setParamsDialog({ open: false, polygonId: null });
          }}
          defaults={{
            altitudeAGL: paramsByPolygon[paramsDialog.polygonId || ""]?.altitudeAGL ?? 100,
            frontOverlap: paramsByPolygon[paramsDialog.polygonId || ""]?.frontOverlap ?? 70,
            sideOverlap: paramsByPolygon[paramsDialog.polygonId || ""]?.sideOverlap ?? 70,
          }}
        />

        {/* Right Side Panel - Combined Controls and Instructions - Hidden on mobile */}
        {!isMobile && (
          <div className="absolute top-2 right-2 z-40 w-[500px] max-w-[90vw] max-h-[calc(100vh-120px)] overflow-y-auto">

          {/* Analysis Results */}
          <Card className="backdrop-blur-md bg-white/95">
            <CardContent className="p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-900">Analysis Results</h3>
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
              {hasResults && (
                <div className="space-y-4 max-h-96 overflow-y-auto">
                  {polygonResults.map((polygonResult, index) => {
                    const { polygonId, result } = polygonResult;
                    const shortId = polygonId.slice(0, 8);
                    const fromFile = !!importedOriginals[polygonId];
                    const hasOverride = !!overrides[polygonId]; // currently using file heading
                    
                    return (
                      <div key={polygonId} className={`border rounded-lg p-3 bg-white ${selectedPolygonId===polygonId ? 'ring-2 ring-blue-400' : ''}`} onClick={()=>setSelectedPolygonId(polygonId)}>
                        {/* Polygon Header */}
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center space-x-2">
                            <span className="text-sm font-medium text-gray-900">
                              Polygon {index + 1}
                            </span>
                            <span className="text-xs text-gray-500 font-mono">
                              #{shortId}
                            </span>
                          </div>
                          <div className="flex items-center space-x-2">
                            {/* Quality Indicator */}
                            {result.fitQuality && (
                              <div className={`flex items-center space-x-1 px-2 py-0.5 rounded-full text-xs font-medium ${getQualityIndicator(result.fitQuality).bgColor} ${getQualityIndicator(result.fitQuality).color}`}>
                                <span>{getQualityIndicator(result.fitQuality).icon}</span>
                                <span>{getQualityIndicator(result.fitQuality).label}</span>
                              </div>
                            )}
                            <Button 
                              size="sm" 
                              variant="ghost" 
                              className="h-6 w-6 p-0 text-gray-400 hover:text-red-500"
                              onClick={() => clearSpecificPolygon(polygonId)}
                            >
                              <X className="w-3 h-3" />
                            </Button>
                          </div>
                        </div>

                        {/* Flight Direction - Primary Result */}
                        <div className="bg-blue-50 rounded-lg p-2 mb-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-2">
                              <Target className="w-4 h-4 text-blue-600" />
                              <span className="text-sm font-medium text-blue-900">Flight Direction:</span>
                            </div>
                            <span className="font-mono text-lg font-bold text-blue-700">
                              {result.contourDirDeg.toFixed(1)}°
                            </span>
                          </div>
                        </div>

                        {/* per-polygon actions when imported */}
                        {fromFile && (
                          <div className="flex gap-2 mb-2">
                            {hasOverride ? (
                              <Button size="sm" className="h-7 px-2 text-xs"
                                      onClick={(e) => { e.stopPropagation(); mapRef.current?.optimizePolygonDirection?.(polygonId); }}
                                      title="Drop file override and use terrain-optimal direction">
                                🎯 Optimize
                              </Button>
                            ) : (
                              <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
                                      onClick={(e) => { e.stopPropagation(); mapRef.current?.revertPolygonToImportedDirection?.(polygonId); }}
                                      title="Restore Wingtra file bearing/spacing">
                                📁 File dir
                              </Button>
                            )}
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
                                    onClick={(e) => { e.stopPropagation(); mapRef.current?.runFullAnalysis?.(polygonId); }}
                                    title="Clear overrides, run fresh analysis, and ask for new params">
                              🔄 Full
                            </Button>
                          </div>
                        )}
                        
                        {/* Secondary Metrics */}
                        <div className="space-y-1 text-xs">
                          <div className="flex justify-between items-center">
                            <span className="text-gray-600">Terrain Aspect:</span>
                            <span className="font-mono font-medium">{result.aspectDeg.toFixed(1)}°</span>
                          </div>
                          
                          <div className="flex justify-between items-center">
                            <span className="text-gray-600">Sample Points:</span>
                            <span className="font-mono font-medium">{result.samples.toLocaleString()}</span>
                          </div>

                          <div className="flex justify-between items-center">
                            <span className="text-gray-600">Terrain Zoom:</span>
                            <span className="font-mono font-medium">
                              z{polygonResult.terrainZoom}
                              {polygonResult.terrainZoom === 15 && <span className="text-green-600 ml-1">⚡</span>}
                              {polygonResult.terrainZoom === 12 && <span className="text-orange-600 ml-1">🏃</span>}
                            </span>
                          </div>

                          {/* Flight Altitude Information */}
                          {result.maxElevation !== undefined && (
                            <>
                              <div className="flex justify-between items-center">
                                <span className="text-gray-600">Max Terrain:</span>
                                <span className="font-mono font-medium">{result.maxElevation.toFixed(1)}m</span>
                              </div>
                              <div className="flex justify-between items-center">
                                <span className="text-gray-600">Flight Altitude:</span>
                                <span className="font-mono font-medium text-blue-600">
                                  {(result.maxElevation + 100).toFixed(1)}m
                                  <span className="text-blue-600 ml-1">✈️</span>
                                </span>
                              </div>
                            </>
                          )}

                          {/* Advanced Metrics */}
                          {result.rSquared !== undefined && (
                            <div className="flex justify-between items-center">
                              <span className="text-gray-600">R² (fit accuracy):</span>
                              <span className="font-mono font-medium">{result.rSquared.toFixed(3)}</span>
                            </div>
                          )}

                          {result.rmse !== undefined && (
                            <div className="flex justify-between items-center">
                              <span className="text-gray-600">RMSE:</span>
                              <span className="font-mono font-medium">{result.rmse.toFixed(1)}m</span>
                            </div>
                          )}

                          {result.slopeMagnitude !== undefined && (
                            <div className="flex justify-between items-center">
                              <span className="text-gray-600">Terrain Slope:</span>
                              <span className="font-mono font-medium">{(result.slopeMagnitude * 100).toFixed(1)}%</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Summary for multiple polygons */}
              {hasResults && polygonResults.length > 1 && (
                <div className="border-t pt-2 mt-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center space-x-2 text-green-600">
                      <CheckCircle className="w-3 h-3" />
                      <span>{polygonResults.length} Areas Analyzed</span>
                    </div>
                    <div className="flex items-center space-x-1 text-gray-500">
                      <TrendingUp className="w-3 h-3" />
                      <span>3D Plane Fitting</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs flex-1"
                            onClick={()=>{ if(paramsDialog.polygonId){ /* nothing */ }}}
                            disabled={!!paramsDialog.open}>Queue Active</Button>
                  </div>
                  {selectedPolygonId && (
                    <div className="flex gap-2">
                      <Button size="sm" className="h-7 px-2 text-xs flex-1"
                              onClick={()=> mapRef.current?.optimizePolygonDirection?.(selectedPolygonId)}
                              title="Optimize selected polygon direction">
                        🎯 Optimize Selected
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Always mount the GSD Panel to ensure auto-run callback is registered */}
          <Card className="backdrop-blur-md bg-white/95 mt-4">
            <CardContent className="p-3">
              <div className={panelEnabled ? '' : 'opacity-50 pointer-events-none'}>
                <OverlapGSDPanel 
                  mapRef={mapRef} 
                  mapboxToken={mapboxToken} 
                  getPerPolygonParams={() => paramsByPolygon}
                  onAutoRun={handleAutoRunReceived}
                  onClearExposed={handleClearReceived}
                  onExposePoseImporter={(fn)=>{ openDJIImporterRef.current = fn; }}
                  onPosesImported={(c)=> setImportedPoseCount(c)}
                />
              </div>
            </CardContent>
          </Card>
        </div>
        )}

        {/* Map Container */}
        <MapFlightDirection
          ref={mapRef}
          mapboxToken={mapboxToken}
          center={center}
          zoom={initialZoom}
          terrainZoom={terrainZoom}
          sampleStep={sampleStep}
          onAnalysisStart={handleAnalysisStart}
          onAnalysisComplete={handleAnalysisComplete}
          onError={handleError}
          onRequestParams={handleRequestParams}
          onFlightLinesUpdated={handleFlightLinesUpdated}
          onClearGSD={() => clearGSDRef.current?.()}
        />
      </div>
    </div>
  );
}
