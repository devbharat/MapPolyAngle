/**
 * Formal API interface for the MapFlightDirection component.
 * This provides type safety for the imperative ref API used by consumers.
 */

import type { Map as MapboxMap } from 'mapbox-gl';
import type { 
  FlightParams, 
  TerrainTile
} from '@/domain/types';
import type { PolygonAnalysisResult } from './types';

export interface PolygonWithId {
  id?: string;
  ring: [number, number][];
}

export interface ImportedFlightplanArea {
  polygonId: string;
  params: FlightParams & {
    angleDeg: number;
    lineSpacingM: number;
    triggerDistanceM: number;
    source: 'wingtra';
  };
}

export interface MapFlightDirectionAPI {
  // Core map operations
  clearAllDrawings(): void;
  clearPolygon(polygonId: string): void;
  startPolygonDrawing(): void;
  getMap(): MapboxMap | undefined;

  // Polygon management
  getPolygons(): [number, number][][]; // legacy format for backward compatibility
  getPolygonsWithIds(): PolygonWithId[];
  getPolygonResults(): PolygonAnalysisResult[];
  getPolygonTiles(): Map<string, any[]>; // Keep as any[] for now to match current implementation

  // Flight planning
  applyPolygonParams(polygonId: string, params: FlightParams): void;
  getFlightLines(): Map<string, { 
    flightLines: number[][][]; 
    lineSpacing: number; 
    altitudeAGL: number 
  }>;
  getPerPolygonParams(): Record<string, FlightParams>;

  // 3D visualization
  addCameraPoints(polygonId: string, positions: [number, number, number][]): void;
  removeCameraPoints(polygonId: string): void;

  // KML import
  openKmlFilePicker(): void;
  importKmlFromText(kml: string): Promise<{ added: number; total: number }>;

  // Wingtra flightplan import
  openFlightplanFilePicker(): void;
  importWingtraFromText(json: string): Promise<{ added: number; total: number; areas: ImportedFlightplanArea[] }>;

  // Overrides & optimization
  optimizePolygonDirection(polygonId: string): void;                 // drop override → use terrain-optimal
  revertPolygonToImportedDirection(polygonId: string): void;         // re-apply file heading/spacing
  getBearingOverrides(): Record<string, { bearingDeg: number; lineSpacingM?: number; source: 'wingtra' | 'user' }>;
  getImportedOriginals(): Record<string, { bearingDeg: number; lineSpacingM: number }>;
}
