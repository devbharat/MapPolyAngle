import React, { useState, useRef } from 'react';
import { MapFlightDirection } from '@/components/MapFlightDirection';
import { AspectResult } from '@/utils/terrainAspect';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { useToast } from '@/hooks/use-toast';
import { Settings, Map, Trash2, CheckCircle, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export default function Home() {
  const { toast } = useToast();
  const [analysisResult, setAnalysisResult] = useState<AspectResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [terrainZoom, setTerrainZoom] = useState(12);
  const [sampleStep, setSampleStep] = useState(2);
  const [mapboxToken, setMapboxToken] = useState(
    import.meta.env.VITE_MAPBOX_TOKEN || 
    import.meta.env.VITE_MAPBOX_ACCESS_TOKEN || 
    ""
  );
  
  // Debug environment variables
  console.log('Environment variables:', {
    VITE_MAPBOX_TOKEN: import.meta.env.VITE_MAPBOX_TOKEN ? 'Present' : 'Missing',
    VITE_MAPBOX_ACCESS_TOKEN: import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ? 'Present' : 'Missing',
    mapboxToken: mapboxToken ? 'Present' : 'Missing'
  });
  const [center, setCenter] = useState<[number, number]>([8.54, 47.37]);
  const [initialZoom, setInitialZoom] = useState(13);
  const [configOpen, setConfigOpen] = useState(false);

  const handleAnalysisStart = () => {
    setIsAnalyzing(true);
    setAnalysisResult(null);
  };

  const handleAnalysisComplete = (result: AspectResult | null) => {
    setIsAnalyzing(false);
    setAnalysisResult(result);
    
    if (result && result.samples > 0) {
      toast({
        title: "Analysis Complete",
        description: `Calculated flight direction from ${result.samples.toLocaleString()} sample points`,
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

  const saveConfiguration = () => {
    setConfigOpen(false);
    toast({
      title: "Configuration Saved",
      description: "Map settings have been updated",
    });
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
              <p className="text-sm text-gray-500">Analyze terrain aspects for optimal flight paths</p>
            </div>
          </div>
          
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2 bg-green-100 text-green-700 px-3 py-1 rounded-full text-sm">
              <div className="w-2 h-2 bg-green-500 rounded-full"></div>
              <span>Connected to Mapbox</span>
            </div>
            
            <Dialog open={configOpen} onOpenChange={setConfigOpen}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="sm">
                  <Settings className="w-5 h-5" />
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Configuration</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="mapbox-token">Mapbox Access Token</Label>
                    <Input
                      id="mapbox-token"
                      type="password"
                      value={mapboxToken}
                      onChange={(e) => setMapboxToken(e.target.value)}
                      placeholder="pk.eyJ1IjoieW91ci11c2VybmFtZSIsImEiOiJjbGxxOG..."
                    />
                    <p className="text-xs text-gray-500 mt-1">Required for terrain data access</p>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label htmlFor="center-lng">Longitude</Label>
                      <Input
                        id="center-lng"
                        type="number"
                        step="0.000001"
                        value={center[0]}
                        onChange={(e) => setCenter([parseFloat(e.target.value), center[1]])}
                      />
                    </div>
                    <div>
                      <Label htmlFor="center-lat">Latitude</Label>
                      <Input
                        id="center-lat"
                        type="number"
                        step="0.000001"
                        value={center[1]}
                        onChange={(e) => setCenter([center[0], parseFloat(e.target.value)])}
                      />
                    </div>
                  </div>
                  
                  <div>
                    <Label htmlFor="zoom">Initial Zoom Level: {initialZoom}</Label>
                    <Input
                      id="zoom"
                      type="range"
                      min="1"
                      max="18"
                      value={initialZoom}
                      onChange={(e) => setInitialZoom(parseInt(e.target.value))}
                      className="mt-2"
                    />
                  </div>
                  
                  <div className="flex justify-end space-x-3 pt-4">
                    <Button variant="outline" onClick={() => setConfigOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={saveConfiguration}>
                      Save Configuration
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </header>

      <div className="flex-1 relative">
        {/* Control Panel */}
        <div className="absolute top-4 left-4 z-40 max-w-sm">
          <Card className="backdrop-blur-md bg-white/95">
            <CardContent className="p-4">
              <h3 className="font-medium text-gray-900 mb-3">Drawing Tools</h3>
              
              <div className="space-y-3">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Draw Polygon</span>
                    <Button size="sm" variant="destructive" onClick={clearDrawings}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="text-xs text-gray-500 bg-blue-50 p-2 rounded">
                    Click the polygon tool (⬛) in the top-left corner of the map, then click points to draw your polygon
                  </div>
                </div>
                
                <div className="border-t pt-3">
                  <Label className="text-sm font-medium text-gray-700 mb-2">Terrain Zoom Level</Label>
                  <Select value={terrainZoom.toString()} onValueChange={(value) => setTerrainZoom(parseInt(value))}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">10 (Low Detail)</SelectItem>
                      <SelectItem value="11">11</SelectItem>
                      <SelectItem value="12">12 (Recommended)</SelectItem>
                      <SelectItem value="13">13</SelectItem>
                      <SelectItem value="14">14 (High Detail)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                <div className="border-t pt-3">
                  <Label className="text-sm font-medium text-gray-700 mb-2">Sample Step: {sampleStep}</Label>
                  <Input
                    type="range"
                    min="1"
                    max="5"
                    value={sampleStep}
                    onChange={(e) => setSampleStep(parseInt(e.target.value))}
                    className="mt-2"
                  />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>Accurate</span>
                    <span>Fast</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Analysis Results */}
          <Card className="backdrop-blur-md bg-white/95 mt-4">
            <CardContent className="p-4">
              <h3 className="font-medium text-gray-900 mb-3">Analysis Results</h3>
              
              {isAnalyzing && (
                <div className="flex items-center justify-center py-8">
                  <div className="text-center">
                    <LoadingSpinner className="mx-auto mb-4" />
                    <p className="text-gray-600">Calculating terrain aspect...</p>
                  </div>
                </div>
              )}
              
              {!isAnalyzing && !analysisResult && (
                <div className="text-center py-8 text-gray-500">
                  <p className="text-sm">Draw a polygon to analyze terrain</p>
                </div>
              )}

              {!isAnalyzing && analysisResult && (
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Terrain Aspect:</span>
                    <span className="font-mono text-sm font-medium">{analysisResult.aspectDeg.toFixed(1)}°</span>
                  </div>
                  
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Flight Direction:</span>
                    <span className="font-mono text-sm font-medium text-pink-600">{analysisResult.contourDirDeg.toFixed(1)}°</span>
                  </div>
                  
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Sample Points:</span>
                    <span className="font-mono text-sm font-medium">{analysisResult.samples.toLocaleString()}</span>
                  </div>
                  
                  <div className="border-t pt-3">
                    <div className="flex items-center space-x-2 text-sm text-green-600">
                      <CheckCircle className="w-4 h-4" />
                      <span>Analysis Complete</span>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Instructions Panel */}
        <div className="absolute top-4 right-4 z-40 max-w-xs">
          <Card className="backdrop-blur-md bg-white/95">
            <CardContent className="p-4">
              <h3 className="font-medium text-gray-900 mb-3">How to Use</h3>
              <ol className="text-sm text-gray-600 space-y-2">
                <li className="flex items-start space-x-2">
                  <span className="flex-shrink-0 w-5 h-5 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">1</span>
                  <span>Click the polygon tool to start drawing</span>
                </li>
                <li className="flex items-start space-x-2">
                  <span className="flex-shrink-0 w-5 h-5 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">2</span>
                  <span>Click points on the map to create your polygon</span>
                </li>
                <li className="flex items-start space-x-2">
                  <span className="flex-shrink-0 w-5 h-5 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">3</span>
                  <span>Double-click to finish the polygon</span>
                </li>
                <li className="flex items-start space-x-2">
                  <span className="flex-shrink-0 w-5 h-5 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-medium">4</span>
                  <span>View the calculated flight direction</span>
                </li>
              </ol>
            </CardContent>
          </Card>
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
