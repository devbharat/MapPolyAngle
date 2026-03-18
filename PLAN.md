# Local Backend Terrain Splitter Framework

## Summary
Build a separate local Python/FastAPI service that owns terrain fetching, grid construction, and region partition solving, while the existing frontend calls it behind a feature flag and falls back to the current in-browser splitter when the backend is not configured.

The backend should not be a thin proxy around the current TypeScript heuristic. It should start with the **right data model** for the future solver:
- a regular grid over the polygon
- sensor-aware unary costs per grid cell and candidate label
- explicit edge-cut costs between neighboring cells
- postprocessing that turns labels into compact, convex-ish polygons
- a coarse-to-fine hierarchy for the existing UI

Local v1 should already produce useful candidate partitions on real polygons. Deployment decisions come later.

## Current Status

### Implemented now
- Added a separate Python backend workspace in [backend/terrain_splitter](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter).
- Added a FastAPI app with:
  - `GET /healthz`
  - `POST /v1/partition/solve`
- Added backend modules for:
  - terrain tile fetch and cache
  - clipped XY grid construction
  - terrain feature extraction
  - sensor-aware cost evaluation
  - a first grid-based partition solver
  - polygon postprocessing
  - local debug artifact writing
- Added a frontend backend client in [src/services/terrainPartitionBackend.ts](/Users/bharat/Documents/src/MapPolyAngle/src/services/terrainPartitionBackend.ts).
- Wired the frontend so:
  - if `VITE_TERRAIN_PARTITION_BACKEND_URL` is set, partition planning calls the backend
  - if the backend is unset or fails, the current in-browser solver is used as fallback
- Kept the UI contract unchanged:
  - `getTerrainPartitionSolutions`
  - `applyTerrainPartitionSolution`
  - `autoSplitPolygonByTerrain`

### Verified
- `python3 -m compileall backend/terrain_splitter`
- `npm run build`

### Not yet verified end-to-end
- Backend pytest suite exists, but was not run in this environment because `pytest` is not installed in the current Python interpreter.
- No full browser smoke test has been completed yet against the backend-enabled path on a real polygon.

### Important limitation of the current backend v1
- The backend solver is currently a **regular-grid heuristic / graph-cut-ready formulation**, not a true `pygco`-style multi-label graph-cut solver yet.
- It is intentionally structured so we can swap the core solver later without changing the frontend contract.
- Exact preview still remains in the frontend, as planned.

## Implementation Changes

### 1. Add a separate Python solver service
Create a new backend workspace, e.g. `backend/terrain_splitter/`, with:
- `pyproject.toml`
- FastAPI app with `uvicorn` entrypoint
- no database
- local on-disk cache for fetched DEM tiles and debug artifacts

Use Python + FastAPI as the primary runtime. The service owns:
- Mapbox terrain tile fetch/decode
- polygon rasterization onto a metric grid
- terrain feature extraction
- partition solving
- polygon postprocessing
- debug outputs

Recommended module split:
- `app.py`
- `schemas.py`
- `mapbox_tiles.py`
- `grid.py`
- `features.py`
- `costs.py`
- `solver_graphcut.py`
- `postprocess.py`
- `debug.py`

### Status
- Done.
- Files now exist under [backend/terrain_splitter/terrain_splitter](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter).
- Local dev script was added in [package.json](/Users/bharat/Documents/src/MapPolyAngle/package.json).
- Cache and debug directories are ignored in [.gitignore](/Users/bharat/Documents/src/MapPolyAngle/.gitignore).

### 2. Introduce a backend solver API and frontend feature flag
Add one new frontend env var:
- `VITE_TERRAIN_PARTITION_BACKEND_URL`

Behavior:
- if set, partition planning uses the backend
- if unset or backend fails, use the current local solver as fallback

Add a small frontend client wrapper, e.g. `src/services/terrainPartitionBackend.ts`, and route the existing partition entrypoints through it. Keep the current UI and `MapFlightDirectionAPI` contract unchanged:
- `getTerrainPartitionSolutions(polygonId)`
- `applyTerrainPartitionSolution(polygonId, signature)`
- `autoSplitPolygonByTerrain(polygonId)`

The backend does not need to apply polygons directly. It only returns candidate partitions and metadata; the frontend still owns applying the chosen rings to the map.

### Status
- Done for the initial integration path.
- Backend client exists in [src/services/terrainPartitionBackend.ts](/Users/bharat/Documents/src/MapPolyAngle/src/services/terrainPartitionBackend.ts).
- Existing imperative API is routed through the backend first, then falls back to the local TypeScript partitioner in [src/components/MapFlightDirection/index.tsx](/Users/bharat/Documents/src/MapPolyAngle/src/components/MapFlightDirection/index.tsx).
- Exact preview was intentionally left in the frontend.

### 3. Define a clean local-first solve API
Add backend endpoints:
- `GET /healthz`
- `POST /v1/partition/solve`

`/v1/partition/solve` request should include:
- polygon ring
- payload kind: `camera | lidar`
- flight parameters needed for partition scoring
- altitude mode / min clearance / turn extend
- optional `tradeoff` target
- optional `debug` flag

Response should include:
- candidate partition list in the same conceptual shape the frontend already expects
- per-region rings, headings, area, convexity, compactness
- total mission time and quality score
- `isFirstPracticalSplit`
- optional debug artifact references when `debug=true`

Do not add a separate preview endpoint in v1. Keep exact preview in the frontend for now.

### Status
- Done for v1.
- API schema is implemented in [schemas.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/schemas.py).
- Handler is implemented in [app.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/app.py).
- No separate preview endpoint was added.

### 4. Use a grid-based graph-cut-ready formulation in the backend
Do not port the current atom graph. Use a regular XY grid clipped to the polygon.

Per grid cell, compute:
- elevation
- slope
- aspect / contour direction
- break strength / curvature proxy
- confidence weight from slope
- sensor-specific local risk features

Use labels as **region identities with associated heading**, not just heading families. Multiple labels may share a heading so the solver can split off a ridge/peak while keeping the same flight direction on both sides.

The backend objective should be:

`E = E_node + E_cut + E_region + E_mission`

Where:

**Node cost**
- camera: local predicted GSD/overlap penalty for assigning the cell to a region heading
- lidar: local density deficit, low-density risk, hole/no-return risk, and range pressure
- include terrain-orientation mismatch only as a prior, not the main signal

**Cut cost**
- explicit cost for separating neighboring cells
- proportional to shared edge length
- high across smooth same-face terrain
- discounted along strong breaks / ridges / meaningful bearing changes
- optionally weighted by steepness/confidence

**Region cost**
- convexity penalty
- compactness / circumference penalty
- thinness penalty
- fragmented-line / overflight penalty

**Mission cost**
- line length
- turns
- per-region overhead
- inter-region transition

### Status
- Partially done.
- The backend now uses a regular clipped XY grid in [grid.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/grid.py).
- Terrain features are computed in [features.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/features.py).
- Sensor-aware node cost and region cost are implemented in [costs.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/costs.py).
- Partition solving is implemented in [solver_graphcut.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/solver_graphcut.py).
- Current solver is iterative and edge-cost-aware, but it is still a heuristic approximation, not a true graph-cut backend yet.

### 5. Add the missing line-lift term at the backend level
The backend must explicitly model the effect where one high point lifts an entire flight line family.

Implement a region/heading line-lift surrogate:
- bin grid cells into approximate flight lines for a candidate heading
- compute support height per line as the max terrain under that line
- compute excess height above local terrain for the rest of the cells in that line

Use this in node and/or region scoring so splitting can be rewarded even when two child regions keep the same heading.

For lidar, line-lift should worsen:
- density shortfall
- low-tail density
- hole / no-return area

For camera, line-lift should worsen:
- mean GSD
- tail GSD
- overlap risk

### Status
- Partially done.
- A line-lift surrogate is implemented at the region objective level in [costs.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/costs.py).
- This is enough for v1 scoring, but not yet a full assignment-time delta or hotspot-driven candidate generator.
- Next iteration should push line-lift deeper into the segmentation decisions rather than only region evaluation.

### 6. Build partitions as fine segmentation plus merge hierarchy
Do not directly optimize the user slider. Instead:
- solve one fine segmentation with the backend objective
- clean it up into contiguous labeled regions
- polygonize regions
- merge neighboring regions greedily to build a nested coarse-to-fine hierarchy

Rules for displayed hierarchy:
- always preserve a meaningful `2-region` option when one exists
- reject token coarse splits where all non-largest regions together are too small
- reject or split dumbbell / highly non-convex regions during postprocess
- coarsest displayed level should be the first practical split
- finer levels should improve coverage quality, not just peel edge crumbs

### Status
- Partially done.
- The backend produces a fine segmentation candidate set and then builds a coarse-to-fine hierarchy by greedy merges in [solver_graphcut.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/solver_graphcut.py).
- A meaningful `2-region` option is preserved when one exists.
- Non-convexity is currently handled through compactness / convexity penalties and region filtering, not a full postprocess split of dumbbell regions yet.

### 7. Add local debug outputs for iteration
When `debug=true`, backend should save local artifacts per request:
- grid occupancy mask
- slope/aspect/break maps
- line-lift map
- lidar hole-risk / low-density-risk map
- raw label map
- merged hierarchy outlines
- per-solution summary JSON

Return the request id and artifact paths in the response. This is required for fast iteration against real polygons.

### Status
- Partially done.
- The backend writes JSON debug artifacts under `backend/terrain_splitter/.debug/` through [debug.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/debug.py).
- Current artifacts include:
  - request payload
  - grid summary
  - feature summary
  - solution summary
  - timing
- Raster-style debug exports like slope maps, line-lift maps, and label images are not implemented yet.

## Public Interfaces / Types

### Frontend additions
- `VITE_TERRAIN_PARTITION_BACKEND_URL`
- new frontend backend client wrapper
- internal backend response type matching current `TerrainPartitionSolutionPreview` plus optional debug metadata

### Backend API
- `POST /v1/partition/solve`
- response candidates must preserve:
  - `signature`
  - `tradeoff`
  - `regionCount`
  - `totalMissionTimeSec`
  - `normalizedQualityCost`
  - `largestRegionFraction`
  - `meanConvexity`
  - `boundaryBreakAlignment`
  - `isFirstPracticalSplit`
  - per-region `ring`, `bearingDeg`, `areaM2`, `convexity`, `compactness`

### Defaults
- backend fetches Mapbox terrain using server-side `MAPBOX_TOKEN`
- local cache directory under `backend/terrain_splitter/.cache/`
- local debug artifacts under `backend/terrain_splitter/.debug/`
- frontend exact preview remains unchanged in v1

## Test Plan

### Backend unit tests
- terrain tile decode and grid clipping
- cost functions:
  - hole risk worse than low density
  - line-lift ridge case is more expensive than flat same-heading case
  - cut cost is lower on strong terrain breaks than on smooth terrain
- polygon postprocess:
  - no disconnected pieces
  - reject or further split dumbbell shapes
- preserve reasonable 2-region solutions

### Status
- Partially done.
- Synthetic backend tests were added in:
  - [backend/terrain_splitter/tests/test_costs.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/tests/test_costs.py)
  - [backend/terrain_splitter/tests/test_solver_graphcut.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/tests/test_solver_graphcut.py)
- They were not run yet in this environment because `pytest` is missing.

### Backend regression cases
- clean single-face terrain:
  - returns no practical split or only trivial 1-region result
- clear two-face mountain:
  - returns a balanced 2-region coarse option
- gradual multi-aspect terrain:
  - returns non-empty hierarchy, not one giant region plus crumbs
- current failing lidar polygon from the thread:
  - returns at least one practical option
  - coarse option has 2–4 regions
  - no displayed region may have very poor convexity
- `/example/singleArea.flightplan` vs `/example/handCraftedMultiArea.flightplan`:
  - fine hierarchy should show multiple meaningful bearing families
  - output should be compact and qualitatively similar, not edge-peeling

### Status
- Not done yet.
- These real-world regression fixtures still need to be added around the backend solver.

### Frontend integration tests
- with backend URL unset, current local behavior still works
- with backend URL set, `Plan options` loads backend candidates
- `Auto split` applies the backend’s first practical split
- exact preview still runs on selected backend-provided regions
- backend failure falls back cleanly to the current local solver

### Status
- Partially done.
- The integration path is implemented.
- Only build-level validation has been completed so far.
- Browser verification with backend enabled is still pending.

### Local smoke workflow
- start backend locally
- set `VITE_TERRAIN_PARTITION_BACKEND_URL`
- run frontend
- test on:
  - one two-face mountain
  - one complicated lidar mountain
  - the example flightplan pair
- inspect backend debug artifacts for the failing case

### Status
- Ready to run locally, but not completed yet as a full smoke workflow.

## Assumptions And Defaults
- Python FastAPI is the local runtime.
- The backend is a separate local service, not a Vercel function.
- The frontend remains the map/UI owner and only delegates partition solving.
- The current in-browser solver remains available as fallback during iteration.
- Local v1 prioritizes a clean solver framework and useful real-world behavior, not final deployment packaging.
- We are not using a database in v1.
- Exact solver engine may evolve, but the initial backend formulation is grid-based, graph-cut-ready, and decision-complete enough to support later `pygco`-style or equivalent optimization without changing the frontend contract.

## Next Recommended Steps
1. Install the backend test dependencies and run the new pytest suite locally.
2. Run the backend and frontend together with `VITE_TERRAIN_PARTITION_BACKEND_URL` set.
3. Smoke-test on:
   - a simple two-face mountain
   - a complicated lidar mountain
   - the example flightplan pair in [/Users/bharat/Documents/src/MapPolyAngle/example](/Users/bharat/Documents/src/MapPolyAngle/example)
4. Add richer debug artifacts:
   - label map
   - break-strength map
   - line-lift map
   - low-density / hole-risk map
5. Replace the current heuristic segmentation core with a stronger graph-cut-style solver once the backend I/O and regression loop are stable.
