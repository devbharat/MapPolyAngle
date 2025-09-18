# Flight Plan Analyser Overview

## Purpose
- Terrain-aware drone flight planner for drawing/importing polygons, computing terrain-aligned bearings, generating flight lines, and visualizing 3D paths with camera trigger points.
- Provides Ground Sample Distance (GSD) and overlap heatmaps, per-area statistics, and histograms that update as missions change.
- Integrates real-workflow features: Mapbox terrain, per-polygon altitude & overlap, camera selection, minimum-clearance mode, and trigger spacing controls.

## Architecture
- React 18 + TypeScript + Vite; routing with Wouter and async caching via React Query.
- Mapbox GL for basemap/drawing (mapbox-gl-draw) and Deck.gl overlays for 3D flight paths, camera markers, and trigger points.
- Terrain analysis performed through hooks/utilities; heavy overlap/GSD work executes inside a Web Worker to keep UI responsive.

## Primary Workflows
1. **Polygon Analysis** – `usePolygonAnalysis` fetches Mapbox terrain tiles, runs a hybrid plane fit (`terrainAspectHybrid.ts`), and produces bearings + quality metrics per polygon.
2. **Flight Planning** – Selected parameters determine spacing from camera models, add Mapbox line layers, build 3D paths (with optional min-clearance/extended turns), and sample camera poses (`geometry.ts`).
3. **GSD & Overlap Analysis** – Overlap panel gathers polygons, tiles, and poses, prepares per-polygon camera assignments, and delegates to the worker for rasterized coverage and statistics.
4. **Interop Loop** – Import/export of KML, Wingtra `.flightplan`, plus DJI/Wingtra geotag ingestion for enriched analysis.

## Notable Modules
- `src/components/MapFlightDirection` exposes an imperative API (clear, import, overrides, altitude strategy toggles) so other components stay decoupled while sharing state.
- Camera registry & spacing math live in `src/domain/camera.ts`; polygon-only flight-line generators and trigger sampling are reusable in `src/planning/lines.ts`.
- Terrain helpers manage DEM fetching, elevation conversions, and zoom selection (`utils/terrain.ts`, `components/MapFlightDirection/utils/geometry.ts`).

## Data & Interop
- **Imports:** Drag/drop or picker for KML/KMZ and Wingtra `.flightplan` files populate polygons and overrides; UI controls revert/optimize headings per polygon.
- **Exports:** Wingtra JSON regeneration ready for upload; optional pose ingestion from DJI `input_cameras.json` or Wingtra geotags supports detailed overlap studies.

## Tooling & Testing
- `src/tests/flat_gsd.test.ts` offers a numerical regression script covering multiple cameras and altitudes without the UI.
- `utils/errorHandler.ts` suppresses abort noise from cancelled fetches to keep console output actionable.

## Getting Started Tips
- Set `VITE_MAPBOX_TOKEN` (or `VITE_MAPBOX_ACCESS_TOKEN`) before running `npm run dev`.
- For mission validation, import sample Wingtra/DJI files to observe how overlap statistics react to altitude strategies.
