import React, { useState, useRef, useCallback, useMemo } from 'react';
import { MapFlightDirection } from '@/components/MapFlightDirection';
import type { MapFlightDirectionAPI } from '@/components/MapFlightDirection/api';
import { PolygonAnalysisResult } from '@/components/MapFlightDirection/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useIsMobile } from '@/hooks/use-mobile';
import { Map, Trash2, CheckCircle, AlertCircle, TrendingUp, Target, X, Upload } from 'lucide-react';
import OverlapGSDPanel from "@/components/OverlapGSDPanel";
import PolygonParamsDialog from "@/components/PolygonParamsDialog";
import type { PolygonParams } from '@/components/MapFlightDirection/types';

export default function Home() {
  const isMobile = useIsMobile();
  const mapRef = useRef<MapFlightDirectionAPI>(null);

  const [polygonResults, setPolygonResults] = useState<PolygonAnalysisResult[]>([]);
  const [analyzingPolygons, setAnalyzingPolygons] = useState<Set<string>>(new Set());

  // NEW: per‑polygon flight parameters
  const [paramsByPolygon, setParamsByPolygon] = useState<Record<string, PolygonParams>>({});
  const [paramsDialog, setParamsDialog] = useState<{ open: boolean; polygonId: string | null }>({ open: false, polygonId: null });

  // Auto-run GSD analysis when flight lines are updated (already wired)
  const autoRunGSDRef = useRef<((opts?: { polygonId?: string; reason?: 'lines'|'spacing'|'alt'|'manual' }) => void) | null>(null);
  const clearGSDRef = useRef<(() => void) | null>(null);
  
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

  const handleLineSpacingChange = useCallback((newLineSpacing: number) => {
    // Remove old global line spacing handler - now per-polygon
  }, []);

  const handleFlightLinesUpdated = useCallback((which: string | '__all__') => {
    if (!autoRunGSDRef.current) return;
    if (which === '__all__') {
      autoRunGSDRef.current({ reason: 'spacing' });
    } else {
      autoRunGSDRef.current({ polygonId: which, reason: 'lines' });
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

  const clearAllDrawings = useCallback(() => {
    mapRef.current?.clearAllDrawings?.();
    setPolygonResults([]);
    setAnalyzingPolygons(new Set());
    setParamsByPolygon({});
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
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2 whitespace-nowrap"
              onClick={() => mapRef.current?.openKmlFilePicker?.()}
            >
              <Upload className="w-3 h-3 mr-1" />
              Import KML
            </Button>
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
          defaults={{
            altitudeAGL: paramsByPolygon[paramsDialog.polygonId || ""]?.altitudeAGL ?? 100,
            frontOverlap: paramsByPolygon[paramsDialog.polygonId || ""]?.frontOverlap ?? 80,
            sideOverlap: paramsByPolygon[paramsDialog.polygonId || ""]?.sideOverlap ?? 70,
          }}
        />

        {/* Right Side Panel - Combined Controls and Instructions - Hidden on mobile */}
        {!isMobile && (
          <div className="absolute top-2 right-2 z-40 w-80 max-h-[calc(100vh-120px)] overflow-y-auto">

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
                    
                    return (
                      <div key={polygonId} className="border rounded-lg p-3 bg-white">
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
                <div className="border-t pt-2 mt-3">
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
                </div>
              )}
            </CardContent>
          </Card>

          {/* Always mount the GSD Panel to ensure auto-run callback is registered */}
          <Card className="backdrop-blur-md bg-white/95 mt-4">
            <CardContent className="p-3">
              <div className={hasResults ? '' : 'opacity-50 pointer-events-none'}>
                <OverlapGSDPanel 
                  mapRef={mapRef} 
                  mapboxToken={mapboxToken} 
                  getPerPolygonParams={() => paramsByPolygon}
                  onAutoRun={handleAutoRunReceived}
                  onClearExposed={handleClearReceived}
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