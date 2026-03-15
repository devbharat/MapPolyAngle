# Terrain Partition Current State

## Snapshot

This snapshot captures the current terrain-partitioning work as of March 15, 2026.

The branch now contains:

- a legacy heuristic splitter in `src/utils/terrainFacePartition.ts`
- a newer objective-driven partition backend in `src/utils/terrainPartitionObjective.ts`
- a graph/segmentation backend in `src/utils/terrainPartitionGraph.ts`
- panel and map API integration for:
  - `Auto split`
  - `Plan options`
  - exact preview before apply
- regression tests in:
  - `src/tests/terrain_face_partition.test.ts`
  - `src/tests/terrain_partition_objective.test.ts`
  - `src/tests/terrain_partition_graph.test.ts`
- qualitative reference inputs in:
  - `example/singleArea.flightplan`
  - `example/handCraftedMultiArea.flightplan`

## Added Behavior

- `Auto split` now:
  - computes partition candidates from the new backend
  - picks a default option, preferring the first practical split
  - applies it immediately
  - falls back to the legacy heuristic splitter if the chosen partition fails to apply
- `Plan options` now:
  - loads the available partition hierarchy
  - exposes a faster-to-better-quality slider
  - shows estimated region count, mission time, mismatch, convexity, and exact preview
  - applies the exact selected partition signature without fallback
- split/reset flows now clear all `ogsd-*` raster overlays instead of only the last remembered run id
- split application now rejects catastrophically broken child sets instead of silently replacing the parent with tiny partial polygons

## Verified Working

- `npm run test:terrain-objective`
- `npm run test:terrain-graph`
- `npm run build`

Manual smoke checks done in the live app:

- imported `example/singleArea.flightplan`
- ran `Auto split`
- confirmed the split produced two child polygons instead of tiny disconnected fragments
- confirmed only one `ogsd-*` overlay run id remained after the split, rather than stacked stale rasters

## Current Findings

### 1. Preview partitions are still approximate geometry

The new graph backend builds region polygons from terrain-guidance support, not from a true exact tessellation of the source polygon. That means the returned `regions[].ring` geometry is still an approximation of the intended partition, not a guaranteed full cover of the parent area.

Practical impact:

- some partition options can look reasonable in the planner but still fail at apply time
- quality/time ranking from the partition planner is useful, but the polygon geometry itself is not yet “ground truth”

### 2. `Plan options` can surface partitions that `Auto split` would never leave in place

`Auto split` is more robust than `Plan options` because it has a fallback path:

- if the selected graph-backed partition fails the apply-time coverage guard, `Auto split` falls back to the legacy heuristic splitter
- `Apply partition` from `Plan options` does not do that; it only applies the chosen signature

Practical impact:

- `Auto split` and `Plan options -> Apply partition` are not equivalent today
- a user can still select a partition option that later fails to apply

### 3. The apply-time coverage guard is intentionally loose

The current guard rejects only catastrophic failures. It does **not** guarantee near-perfect parent coverage.

Current thresholds:

- minimum parent coverage ratio: `0.5`
- maximum overlap ratio: `0.35`

These values were chosen because stricter thresholds started rejecting coarse but still useful partitions from the raster-backed search.

Practical impact:

- the worst broken splits are blocked
- but a successful apply is not yet proof of a high-quality exact tessellation

### 4. Exact preview is exact only for the candidate geometry, not for the final fallback result

The exact preview in the panel is computed for the selected candidate partition geometry. If `Auto split` later rejects that candidate and falls back to the legacy heuristic splitter, the preview no longer describes the final applied result.

Practical impact:

- preview is reliable for `Apply partition` when that exact partition succeeds
- preview is only advisory for `Auto split`, because the auto path may change strategy

### 5. Parent restoration is still a risk on late split failure

The split flow creates children first and deletes the parent later, which is good. But after the parent is deleted, there are still asynchronous child-analysis steps. If one of those later steps throws, the current code removes the children but does not reconstruct the original parent polygon.

Practical impact:

- this looks like a real transactional gap
- it should be treated as an outstanding bug/risk until the split operation is made atomic or the parent can be restored on failure

## Recommended Next Work

1. Stop using support-region rings as the final partition geometry.
   - The planner should optimize over the guidance field, but final child polygons should come from an exact tessellation step.

2. Make partition application transactional.
   - Either delay parent deletion until all child setup succeeds, or keep enough parent state to restore it on failure.

3. Align `Plan options` with `Auto split`.
   - Either give `Apply partition` the same fallback semantics, or explicitly mark options that are preview-only / low-confidence.

4. Replace the loose coverage guard with a real tessellation validator.
   - Final children should be contiguous, non-overlapping, and their union should match the parent polygon to a much tighter tolerance.
