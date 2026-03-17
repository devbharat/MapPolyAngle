# Backend Region Objective Cache Plan

## Goal

Reduce backend solver wall-clock time without changing solver behavior or pruning candidates.

The expensive path is repeated evaluation of the same region geometry and the same `(region, bearing)` objective core in:

- [costs.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/costs.py)
- [solver_frontier.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/solver_frontier.py)

The main optimization direction is to cache work by its true scope of invariance.

## Invariance Layers

### 1. Request-Invariant

Fixed for a single `/v1/partition/solve` request:

- payload kind
- altitude AGL
- overlaps
- lidar FOV / return mode / max range
- speed
- camera model parameters

Derived constants should be computed once per request:

- line spacing constants
- forward spacing constants
- lidar target density
- line-lift thresholds

### 2. Region-Static

Depends only on the exact set of region cell ids:

- region polygon
- polygon ring
- area
- centroid
- convexity
- compactness
- packed arrays for:
  - `x`
  - `y`
  - `area_m2`
  - `terrain_z`
  - `preferred_bearing_deg`
  - `confidence`
  - `slope_magnitude`

This should become a `RegionStaticCache[cell_ids]`.

### 3. Region-Bearing Core

Depends only on the exact region and exact bearing:

- weighted mean mismatch
- local node-cost aggregates
- line-lift summary
- flight-time / line-geometry summary
- full `RegionObjective` core except for boundary-alignment injection

This should become a `RegionBearingCoreCache[(cell_ids, bearing_key)]`.

`bearing_key` should be a stable rounded representation, e.g. millidegrees.

## Important Decomposition

The expensive objective should be split conceptually into:

`RegionObjective(region, bearing, boundaryAlignment) = Core(region, bearing) + cheap boundary metadata`

Where `Core(region, bearing)` contains:

- local sensor fit
- line-lift summary
- flight geometry / mission-time proxy
- shape descriptors

`boundary_break_alignment` should not force recomputation of the expensive core. It should be injected afterward when constructing the final `RegionObjective`.

## Implementation Plan

### Phase 1. RegionStatic cache

Add a cached structure keyed by sorted `cell_ids` containing:

- polygon
- ring
- area
- centroid
- convexity
- compactness
- region arrays

Expected effect:

- avoid rebuilding the same polygon and shape descriptors
- avoid rebuilding per-region packed arrays

### Phase 2. RegionBearing core cache

Add a second cache keyed by:

- `cell_ids`
- rounded bearing

Store:

- weighted mean mismatch
- line-lift summary
- flight-time summary
- aggregated node metrics
- final `normalized_quality_cost`
- final mission-time proxy

Expected effect:

- eliminate repeated calls into:
  - `evaluate_sensor_node_cost(...)`
  - `summarize_line_lift(...)`
  - `estimate_region_flight_time(...)`

### Phase 3. Cheap boundary injection

When a cached region-bearing core is reused under a different split context:

- do not recompute the core
- only rebuild the final `RegionObjective` with the new `boundary_break_alignment`

### Phase 4. Internal sub-caches if needed

If `RegionBearingCoreCache` is still not enough, add exact internal caches for:

- line projection bins per `(region, bearing)`
- polygon flight-line intersections per `(polygon, bearing)`
- line-lift support bins per `(region, bearing)`

This should only happen if phase 2 still leaves excessive time in:

- `estimate_region_flight_time(...)`
- `summarize_line_lift(...)`

## Cache Effectiveness Instrumentation

We need explicit instrumentation so we can tell whether:

- caches are working correctly
- caches are being bypassed by unstable keys
- or the solver structure is naturally generating too few repeats

### Required counters

Log these per solve request:

- `regionStaticHits`
- `regionStaticMisses`
- `regionBearingHits`
- `regionBearingMisses`
- `regionCacheHitRate`
- `regionBearingHitRate`

Also log the existing counters alongside them:

- `buildRegionCalls`
- `objectiveCalls`
- `solveRegionCalls`
- `splitAttempts`
- `combinedCandidates`

### Required timing split

For each solve request, keep timing buckets for:

- `regionStaticBuildMs`
- `regionBearingCoreMs`
- `flightTimeMs`
- `lineLiftMs`
- `nodeCostMs`

That lets us see not just whether hits happen, but whether they hit the expensive parts.

### Correctness guard metrics

Add sanity counters:

- `regionBearingRewraps`
  - number of times a cached core is reused and only boundary metadata is changed
- `regionBearingKeyCollisions`
  - should stay zero
- `regionStaticNullHits`
  - cached invalid / null regions reused

### Expected signal

After caching is working on recursive solves, we should expect:

- nontrivial `regionStaticHitRate`
- nontrivial `regionBearingHitRate`
- `objectiveCalls` materially lower than today
- `buildRegionCalls` still present, but with much less time spent in expensive internals

If hit rates stay near zero, the likely causes are:

- keys are not stable
- bearings are not normalized consistently
- region cell tuples differ unnecessarily between equivalent regions
- the solver path truly does not revisit the same `(region, bearing)` pairs enough

### Logging format

Keep these in the existing backend perf line so one request can be compared directly:

- request total time
- solver time
- cache hit/miss counts
- cache hit rates
- timing buckets

That makes it easy to compare before/after runs from the terminal alone.

## Success Criteria

The first success target is not algorithmic quality change. It is runtime reduction with identical solver behavior.

We should consider this phase successful if:

- returned solutions are unchanged for the same request
- backend solve time drops materially
- `objectiveCalls` decreases or expensive objective work shifts from misses to hits
- cache hit rates are high enough to prove the cache is doing real work

## Non-Goals

This plan does not:

- prune candidate splits
- reduce quality target
- change solver tradeoffs
- alter the accepted frontier

It is purely about removing wasteful recomputation.
