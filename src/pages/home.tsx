import React, { useState, useRef } from 'react';
import { MapFlightDirection } from '@/components/MapFlightDirection';
import { AspectResult } from '@/utils/terrainAspectHybrid';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useToast } from '@/hooks/use-toast';
import { Map, Trash2, CheckCircle, AlertCircle, TrendingUp, Target } from 'lucide-react';

export default function Home() {
  const { toast } = useToast();
  const [analysisResult, setAnalysisResult] = useState<AspectResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const terrainZoom = 15;
  const sampleStep = 1;
  const [mapboxToken, setMapboxToken] = useState(
    import.meta.env.VITE_MAPBOX_TOKEN || 
    import.meta.env.VITE_MAPBOX_ACCESS_TOKEN || 
    ""
  );
  

  const [center, setCenter] = useState<[number, number]>([8.54, 47.37]);
  const [initialZoom, setInitialZoom] = useState(13);

  const handleAnalysisStart = () => {
    setIsAnalyzing(true);
    setAnalysisResult(null);
  };

  const handleAnalysisComplete = (result: AspectResult | null) => {
    setIsAnalyzing(false);
    setAnalysisResult(result);
    
    if (result && result.samples > 0) {
      const qualityText = result.fitQuality ? ` (${result.fitQuality} quality)` : '';
      toast({
        title: "Analysis Complete",
        description: `Calculated flight direction from ${result.samples.toLocaleString()} sample points${qualityText}`,
      });
    }
  };

  const handleError = (error: string) => {
    setIsAnalyzing(false);
    toast({
      title: "Analysis Error",
      description: error,
      variant: "destructive",
    });
  };

  const clearDrawings = () => {
    // Clear drawings functionality will be handled by the map component
    setAnalysisResult(null);
  };

  // Helper function to get quality indicator
  const getQualityIndicator = (quality?: string) => {
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
  };

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

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200 px-6 py-4 relative z-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <Map className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-medium text-gray-900">Terrain Flight Director</h1>
              <p className="text-sm text-gray-500">3D plane fitting for optimal flight paths</p>
            </div>
          </div>
          
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2 bg-green-100 text-green-700 px-3 py-1 rounded-full text-sm">
              <div className="w-2 h-2 bg-green-500 rounded-full"></div>
              <span>Connected to Mapbox</span>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 relative">
        {/* Right Side Panel - Combined Controls and Instructions */}
        <div className="absolute top-4 right-4 z-40 w-80">
          {/* Instructions */}
          <Card className="backdrop-blur-md bg-white/95 mb-4">
            <CardContent className="p-3">
              <h3 className="font-medium text-gray-900 mb-2">How to Use</h3>
              <ol className="text-xs text-gray-600 space-y-1">
                <li className="flex items-start space-x-2">
                  <span className="flex-shrink-0 w-4 h-4 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">1</span>
                  <span>Use 3D navigation controls (top-right) to rotate the map</span>
                </li>
                <li className="flex items-start space-x-2">
                  <span className="flex-shrink-0 w-4 h-4 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">2</span>
                  <span>Click the square tool (top-left) to draw polygon</span>
                </li>
                <li className="flex items-start space-x-2">
                  <span className="flex-shrink-0 w-4 h-4 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">3</span>
                  <span>Click points on terrain to create polygon</span>
                </li>
                <li className="flex items-start space-x-2">
                  <span className="flex-shrink-0 w-4 h-4 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">4</span>
                  <span>Double-click to finish and see flight direction</span>
                </li>
              </ol>
              <div className="mt-2 pt-2 border-t">
                <p className="text-xs text-gray-500">
                  <strong>New:</strong> Uses 3D plane fitting for more accurate and stable results
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Analysis Results */}
          <Card className="backdrop-blur-md bg-white/95">
            <CardContent className="p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-medium text-gray-900">Analysis Results</h3>
                <Button size="sm" variant="outline" onClick={clearDrawings}>
                  <Trash2 className="w-3 h-3 mr-1" />
                  Clear
                </Button>
              </div>
              
              {isAnalyzing && (
                <div className="flex items-center justify-center py-6">
                  <div className="text-center">
                    <LoadingSpinner size="sm" className="mx-auto mb-2" />
                    <p className="text-xs text-gray-600">Fitting 3D plane to terrain...</p>
                  </div>
                </div>
              )}
              
              {!isAnalyzing && !analysisResult && (
                <div className="text-center py-6 text-gray-500">
                  <p className="text-xs">Draw a polygon to start analysis</p>
                </div>
              )}

              {!isAnalyzing && analysisResult && (
                <div className="space-y-3">
                  {/* Quality Indicator */}
                  {analysisResult.fitQuality && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-600">Fit Quality:</span>
                      <div className={`flex items-center space-x-1 px-2 py-1 rounded-full text-xs font-medium ${getQualityIndicator(analysisResult.fitQuality).bgColor} ${getQualityIndicator(analysisResult.fitQuality).color}`}>
                        <span>{getQualityIndicator(analysisResult.fitQuality).icon}</span>
                        <span>{getQualityIndicator(analysisResult.fitQuality).label}</span>
                      </div>
                    </div>
                  )}

                  {/* Flight Direction - Primary Result */}
                  <div className="bg-blue-50 rounded-lg p-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <Target className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-medium text-blue-900">Flight Direction:</span>
                      </div>
                      <span className="font-mono text-lg font-bold text-blue-700">{analysisResult.contourDirDeg.toFixed(1)}°</span>
                    </div>
                  </div>
                  
                  {/* Secondary Metrics */}
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-gray-600">Terrain Aspect:</span>
                      <span className="font-mono text-xs font-medium">{analysisResult.aspectDeg.toFixed(1)}°</span>
                    </div>
                    
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-gray-600">Sample Points:</span>
                      <span className="font-mono text-xs font-medium">{analysisResult.samples.toLocaleString()}</span>
                    </div>

                    {/* Advanced Metrics */}
                    {analysisResult.rSquared !== undefined && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-gray-600">R² (fit accuracy):</span>
                        <span className="font-mono text-xs font-medium">{analysisResult.rSquared.toFixed(3)}</span>
                      </div>
                    )}

                    {analysisResult.rmse !== undefined && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-gray-600">RMSE:</span>
                        <span className="font-mono text-xs font-medium">{analysisResult.rmse.toFixed(1)}m</span>
                      </div>
                    )}

                    {analysisResult.slopeMagnitude !== undefined && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-gray-600">Terrain Slope:</span>
                        <span className="font-mono text-xs font-medium">{(analysisResult.slopeMagnitude * 100).toFixed(1)}%</span>
                      </div>
                    )}
                  </div>
                  
                  <div className="border-t pt-2 mt-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2 text-xs text-green-600">
                        <CheckCircle className="w-3 h-3" />
                        <span>3D Plane Fitted</span>
                      </div>
                      <div className="flex items-center space-x-1 text-xs text-gray-500">
                        <TrendingUp className="w-3 h-3" />
                        <span>Enhanced Algorithm</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Quality Legend (only show when there's a result) */}
          {analysisResult && (
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
          )}
        </div>

        {/* Map Container */}
        <MapFlightDirection
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