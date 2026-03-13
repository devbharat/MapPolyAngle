# Wingtra Lidar Implementation Plan

Status legend:
- `[ ]` Pending
- `[-]` In progress
- `[x]` Completed

## Current Focus

- `[x]` Phase 1: Sensor model refactor
- `[x]` Phase 2: Wingtra lidar import/export
- `[x]` Phase 3: Planning UI and params
- `[x]` Phase 4: Lidar flight-line math
- `[x]` Phase 5: Density analysis engine
- `[x]` Phase 6: Panel integration
- `[ ]` Phase 7: Validation and regression

## Phases

### Phase 1: Sensor Model Refactor

- Introduce a payload abstraction instead of treating everything as a camera.
- Add `payloadKind: 'camera' | 'lidar'` and lidar-specific params to the shared flight params.
- Create a lidar domain module with:
  - effective point rate by return mode
  - swath width from altitude and mapping FOV
  - line spacing from side overlap
  - nominal density formulas using `16 m/s` default speed
- Goal: make the math layer capable of handling lidar without breaking camera logic.

### Phase 2: Wingtra Lidar Import/Export

- Extend Wingtra interop types and converters to detect `LIDAR` / `LIDAR_v5`.
- Import from the sample `.flightplan`:
  - `grid.altitude`
  - `grid.spacing`
  - `camera.imageSideOverlap`
  - `camera.pointDensity`
  - `terrainFollowing`
- Stop resolving lidar payloads to `SONY_RX1R2`.
- Export lidar plans back out with lidar-specific fields preserved.
- Checkpoint: imported lidar plans round-trip cleanly and still render areas/lines.

### Phase 3: Planning UI and Params

- Update the polygon params dialog to render different controls for camera vs lidar.
- For lidar, show:
  - altitude AGL
  - side overlap
  - speed (`16 m/s` default)
  - return mode (`single/dual/triple`)
  - optional mapping FOV, likely fixed at `90°` initially
- Hide camera-only fields for lidar:
  - front overlap
  - camera rotation
  - trigger spacing concepts
- Keep shared controls:
  - optimize direction
  - custom bearing
  - revert to file direction
- Checkpoint: lidar imports can be optimized and reverted exactly like camera plans.

### Phase 4: Lidar Flight-Line Math

- Update map planning so line spacing for lidar comes from swath width and side overlap, not lens footprint.
- Reuse the existing terrain direction optimization unchanged.
- Preserve imported `grid.spacing` when reverting to file direction.
- Goal: planning geometry becomes correct for lidar while keeping the existing map behavior.

### Phase 5: Density Analysis Engine

- Do not force lidar into the current camera pose/GSD worker.
- Add a dedicated lidar density computation path, likely parallel to the camera worker.
- Current version uses a terrain-aware strip model, not individual 32-channel ray tracing:
  - per-pass density = `effectiveRate / (speed * swathWidth)`
  - accumulate density where strips overlap
  - derive strip geometry from the terrain-aware 3D flight path
  - vary local swath width from per-pixel height-above-ground
  - scale density by local terrain incidence using DEM normals
- Output should mirror the camera analysis shape:
  - overlay heatmap
  - per-polygon min/mean/max
  - histogram in `pts/m²`

### Phase 6: Panel Integration

- Generalize the current GSD panel into a payload-aware analysis panel.
- Camera polygons keep GSD.
- Lidar polygons show point density.
- Update labels, legends, tooltips, and summary cards so units are explicit.
- If mixed payloads become possible, keep stats per polygon rather than trying to force one global metric.

### Phase 7: Validation and Regression

- Add formula tests using the lidar note:
  - 45 m, 66 m, 90 m, 120 m
  - single/dual/triple return
  - `16 m/s`
  - overlap scaling
- Add import/export regression using `test lidar.flightplan`.
- Manual smoke test:
  - import lidar plan
  - optimize direction
  - revert to file direction
  - edit/delete areas
  - confirm density overlay updates

## Notes

- The sample `test lidar.flightplan` uses:
  - `payload: LIDAR`
  - `payloadUniqueString: LIDAR_v5`
  - `camera.pointDensity`
  - `camera.imageSideOverlap`
  - `camera.imageFrontalOverlap: 0`
  - `camera.cameraTriggerDistance: 0`
- V1 density should use the average-density strip model from `lidar_info.md`, not a fake optical-camera model.

## Progress Log

### Completed

- Added shared lidar payload fields to the flight params model.
- Added `src/domain/lidar.ts` with Wingtra lidar defaults and density / swath math.
- Updated Wingtra import/export conversion to recognize `LIDAR` / `LIDAR_v5` as a lidar payload instead of falling back to a camera.
- Preserved lidar-specific fields through import:
  - payload kind
  - side overlap
  - spacing
  - nominal point density
  - lidar model key
  - default speed / return mode / mapping FOV assumptions

### In Progress

- Manual regression checks are still outstanding for the full import/edit/export loop.
- Automated regression tests are still outstanding for the new terrain-aware lidar density worker.

### Remaining Before Density Visualization

- Add formula regression tests for the published Wingtra lidar density examples.
- Add import/export regression coverage for `test lidar.flightplan`.
- Run a manual browser smoke test against a real Mapbox token.

### Latest Update

- Added a dedicated `src/overlap/lidar-worker.ts` density worker. It computes pass count and `pts/m²` rasters from lidar flight lines instead of reusing the camera projection worker.
- Extended overlay rendering to support lidar density heatmaps and separate lidar pass-count overlays.
- Generalized `OverlapGSDPanel.tsx` into a payload-aware coverage panel:
  - camera polygons still show GSD
  - lidar polygons now show point density
  - overall summaries now render separately for GSD and density when both exist
- Updated auto-run so lidar-only plans no longer block on generated camera poses.
- Upgraded the lidar density path to use terrain-aware geometry:
  - strip centerlines come from the same terrain-aware 3D path builder used for flight planning
  - each DEM pixel uses local sensor height above terrain to derive swath width
  - local density is incidence-weighted with DEM normals instead of assuming a flat horizontal surface
  - this is still a planning-grade strip model, not a full per-channel beam tracer
- Added a configurable lidar max-range cutoff with a default of `200 m`:
  - pixels beyond the configured slant range are treated as no-return holes
  - density coloring is inverted so low density is worse/red and high density is better/blue
- Fixed pass overcounting in the terrain-aware lidar worker:
  - segments from the same flight line are now collapsed to a single pass contribution per pixel
  - histogram and "Flight lines" counts now track actual sweep lines instead of polyline segments
