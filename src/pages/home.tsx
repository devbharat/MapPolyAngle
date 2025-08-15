import React, { useState, useRef, useCallback, useMemo } from 'react';
import { MapFlightDirection } from '@/components/MapFlightDirection';
import { PolygonAnalysisResult } from '@/components/MapFlightDirection/types';
import { AspectResult } from '@/utils/terrainAspectHybrid';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useIsMobile } from '@/hooks/use-mobile';
import { Map, Trash2, CheckCircle, AlertCircle, TrendingUp, Target, X } from 'lucide-react';
import OverlapGSDPanel from "@/components/OverlapGSDPanel";

export default function Home() {
  const isMobile = useIsMobile();
  const mapRef = useRef<any>(null); // Ref to access map methods
  
  // Updated state for multiple polygons
  const [polygonResults, setPolygonResults] = useState<PolygonAnalysisResult[]>([]);
  const [analyzingPolygons, setAnalyzingPolygons] = useState<Set<string>>(new Set());
  
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

  const clearAllDrawings = useCallback(() => {
    if (mapRef.current?.clearAllDrawings) {
      mapRef.current.clearAllDrawings();
    }
    setPolygonResults([]);
    setAnalyzingPolygons(new Set());
  }, []);

  const clearSpecificPolygon = useCallback((polygonId: string) => {
    if (mapRef.current?.clearPolygon) {
      mapRef.current.clearPolygon(polygonId);
    }
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
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200 px-4 md:px-6 py-3 md:py-4 relative z-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 md:space-x-3">
            <div className="w-6 h-6 md:w-8 md:h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <Map className="w-4 h-4 md:w-5 md:h-5 text-white" />
            </div>
            <div>
              <h1 className="text-base md:text-xl font-medium text-gray-900">Terrain Flight Director</h1>
              <p className="text-xs md:text-sm text-gray-500 hidden sm:block">Multi-polygon 3D plane fitting for optimal flight paths</p>
            </div>
          </div>
          
          <div className="flex items-center space-x-2 md:space-x-4">
            <div className="hidden sm:flex items-center space-x-1 md:space-x-2 bg-green-100 text-green-700 px-2 md:px-3 py-1 rounded-full text-xs md:text-sm">
              <div className="w-1.5 h-1.5 md:w-2 md:h-2 bg-green-500 rounded-full"></div>
              <span className="hidden sm:inline">Connected to Mapbox</span>
              <span className="sm:hidden">Connected</span>
            </div>
            {hasResults && (
              <div className="hidden sm:flex items-center space-x-1 md:space-x-2 bg-blue-100 text-blue-700 px-2 md:px-3 py-1 rounded-full text-xs md:text-sm">
                <span className="hidden sm:inline">{polygonResults.length} polygon{polygonResults.length !== 1 ? 's' : ''} analyzed</span>
                <span className="sm:hidden">{polygonResults.length} poly</span>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 relative">
        {/* Right Side Panel - Combined Controls and Instructions - Hidden on mobile */}
        {!isMobile && (
          <div className="absolute top-2 right-2 z-40 w-80 max-h-[calc(100vh-120px)] overflow-y-auto">
          {/* Instructions */}
          <Card className="backdrop-blur-md bg-white/95 mb-4">
            <CardContent className="p-1">
              <h3 className="font-medium text-gray-900 mb-2">How to Use</h3>
              <ol className="text-xs text-gray-600 space-y-1">
                <li className="flex items-start space-x-2">
                  <span className="flex-shrink-0 w-4 h-4 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">1</span>
                  <span>Click the square tool (top-left) to draw polygons</span>
                </li>
                <li className="flex items-start space-x-2">
                  <span className="flex-shrink-0 w-4 h-4 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">2</span>
                  <span>Click points on terrain to create each polygon</span>
                </li>
                <li className="flex items-start space-x-2">
                  <span className="flex-shrink-0 w-4 h-4 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">3</span>
                  <span>Click again the first point to finish</span>
                </li>
              </ol>
              <div className="mt-2 pt-2 border-t">
                <p className="text-xs text-gray-500">
                  <strong>Features:</strong> Multi-polygon support • Dynamic terrain resolution (15→12 zoom) • Adaptive line spacing • 3D flight paths (100m AGL) • 3D plane fitting
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Analysis Results */}
          <Card className="backdrop-blur-md bg-white/95">
            <CardContent className="p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-medium text-gray-900">Analysis Results</h3>
                <Button size="sm" variant="outline" onClick={clearAllDrawings}>
                  <Trash2 className="w-3 h-3 mr-1" />
                  Clear All
                </Button>
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

          {/* Quality Legend (only show when there are results) */}
          {hasResults && (
            <>
              <Card className="backdrop-blur-md bg-white/95 mt-4">
                <CardContent className="p-3">
                  <h4 className="font-medium text-gray-900 mb-2 text-sm">Quality Guide</h4>
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center space-x-2">
                      <span className="text-green-600">● Excellent:</span>
                      <span className="text-gray-600">R² &gt; 0.95, highly reliable</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-blue-600">● Good:</span>
                      <span className="text-gray-600">R² &gt; 0.85, reliable</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-orange-600">● Fair:</span>
                      <span className="text-gray-600">R² &gt; 0.7, use with caution</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-red-600">● Poor:</span>
                      <span className="text-gray-600">Low confidence, check terrain</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
              
              <Card className="backdrop-blur-md bg-white/95 mt-4">
                <CardContent className="p-3">
                  <h4 className="font-medium text-gray-900 mb-2 text-sm">Dynamic Terrain Resolution</h4>
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center space-x-2">
                      <span className="text-green-600">⚡ z15:</span>
                      <span className="text-gray-600">Small areas (&lt;0.1km²), highest detail</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-blue-600">● z14:</span>
                      <span className="text-gray-600">Medium areas (0.1-1km²), high detail</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-orange-600">● z13:</span>
                      <span className="text-gray-600">Large areas (1-10km²), balanced</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-orange-600">🏃 z12:</span>
                      <span className="text-gray-600">Very large areas (&gt;10km²), fast</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
              
              <Card className="backdrop-blur-md bg-white/95 mt-4">
                <CardContent className="p-3">
                  <h4 className="font-medium text-gray-900 mb-2 text-sm">Adaptive Line Spacing</h4>
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center space-x-2">
                      <span className="text-green-600">⚡ 25m:</span>
                      <span className="text-gray-600">Narrow areas (&lt;200m width), dense coverage</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-blue-600">● 50m:</span>
                      <span className="text-gray-600">Small areas (200-500m width)</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-orange-600">● 100m:</span>
                      <span className="text-gray-600">Medium areas (0.5-1km width)</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-red-600">● 150-200m:</span>
                      <span className="text-gray-600">Large areas (&gt;1km width), efficient</span>
                    </div>
                    <div className="text-gray-500 text-xs mt-2 italic">
                      * Spacing adapts to polygon width perpendicular to flight direction
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="backdrop-blur-md bg-white/95 mt-4">
                <CardContent className="p-3">
                  <OverlapGSDPanel mapRef={mapRef} mapboxToken={mapboxToken} />
                </CardContent>
              </Card>
            </>
          )}
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
        />
      </div>
    </div>
  );
}