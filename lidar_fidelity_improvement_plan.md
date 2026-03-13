# Wingtra Lidar Fidelity Improvement Plan

## Purpose

Improve the lidar preflight density model so the webapp's predicted raster and per-area `pts/m²` are materially closer to delivered mission data, not just internally consistent with the `.flightplan` nominal density field.

This plan is specifically about fidelity improvement, not basic lidar support. The app already supports:

- Wingtra lidar import/export
- lidar-specific flight planning
- terrain-aware density rasters
- range cutoff holes
- editing imported lidar areas

The remaining problem is model realism.

## Progress

- `[x]` Step 1: make the XT32M2X scan geometry explicit in the shared lidar model
  - added `32` vertical channel angles
  - added native vs mapping FOV fields
  - added native vs effective point-rate fields
  - added frame-rate and boresight placeholders for the beam model
  - validated with `npm run build` and a direct code-level sanity check of the exported geometry
- `[-]` Step 2: plumb scan-geometry fields through the lidar worker input
  - strip records now carry channel angles, frame rate, mapping sector, and boresight defaults
  - those fields are now used by the worker during beam sampling
- `[-]` Step 3: replace the strip-density worker core with time-sampled beam accumulation
  - lidar density now comes from sampled beam hits into the DEM, not a uniform strip-density lookup
  - default comparison path is now tuned toward first-return density rather than all-return emitted-point density
  - straight-runout logging is now modeled:
    - each lidar sweep is extended beyond the polygon edges by the straight lead-out / lead-in distance before the turn
    - the turn curves themselves are still excluded from density accumulation
  - current `Ecores` validation after calibration:
    - actual LAS overall mean: about `66.1 pts/m²`
    - app predicted overall mean: about `59.1 pts/m²`
    - per-area prediction is improved but not finished:
      - Area 1: `39.3` vs actual `40.1`
      - Area 2: `73.8` vs actual `101.5`
      - Area 3: `65.9` vs actual `103.0`
      - Area 4: `65.4` vs actual `66.9`
      - Area 5: `74.2` vs actual `66.9`
      - Area 6: `43.7` vs actual `61.6`
- `[ ]` Step 4: calibrate azimuth-sector orientation and boresight so Areas 2 and 3 stop underpredicting while keeping the current overall match
  - after adding straight runout, `Uetliberg` moved upward to roughly:
    - predicted overall mean: `221.0 pts/m²`
    - actual all-return overall mean: `199.35 pts/m²`
    - actual first-return overall mean: `162.15 pts/m²`
  - interpretation:
    - the straight-runout fix is directionally plausible
    - but the model semantics and sector calibration still need refinement

## Current State

### What the app does now

The current lidar worker is a terrain-aware strip model:

- derive terrain-aware 3D flight lines from the planned path
- turn each line into a swath
- compute local `pts/m²` from effective point rate, speed, and local swath width
- weight density by terrain incidence
- clip by max lidar range
- accumulate overlaps

This is a reasonable V1 planner, but it is still a swath approximation. It does not explicitly model the XT32M2X scan geometry.

### What is missing

The current model does **not** explicitly represent:

- the `32` discrete vertical channels
- the `90°` Wingtra mapping azimuth sector inside a native `360°` spinning lidar
- per-channel ground intersection on the DEM
- scan-phase anisotropy from motor rotation / firing sequence
- return-mode semantics beyond a simple effective-rate multiplier
- first-return-only comparison when validating against LAS data
- unit-specific channel calibration offsets from the Hesai correction file

### Why this matters

These omissions explain why the app can get the average magnitude roughly right while still producing the wrong spatial pattern and optimistic density in some missions.

The app currently behaves like "uniform density across a strip." The real sensor behaves like "many discrete beams sampled over time and azimuth, intersecting non-flat terrain at different ranges and incidence angles."

## Real-Data Baseline

The two local missions give us a practical validation set:

### Mission A: `20240819_EcoresDemo.flightplan`

- `6` areas
- lidar payload
- altitude about `90 m AGL`
- side overlap about `60%`
- nominal `.flightplan` density about `55.5 pts/m²`
- imported cruise speed about `18.17 m/s`

Observed comparison after the current fixes:

- actual LAS overall density: about `66.1 pts/m²`
- app preflight overall density: about `78.1 pts/m²`
- app is still optimistic overall, and some polygons are high by roughly `15%` to `35%`

This mission is especially useful because it is close to a first-return-only case.

### Mission B: `Uetliberg_LIDAR_Flight.flightplan`

- `2` areas
- lidar payload
- altitude about `60 m AGL`
- side overlap about `60%`
- nominal `.flightplan` density about `83.3 pts/m²`
- imported cruise speed about `16.04 m/s`

This mission is useful because the delivered cloud includes meaningful second/third returns, so it tests return-mode semantics and comparison methodology.

### Validation implication

We should stop treating "flightplan nominal density," "predicted deliverable density," and "all-return delivered LAS density" as the same metric.

The model and the validation pipeline need to distinguish:

- nominal single-pass density
- predicted spatial density from the planned mission
- first-return delivered density
- all-return delivered density

## Confirmed Sensor and Payload Facts

From the local note, the Hesai XT32M2X manual, and the payload guidance:

- lidar: Hesai XT32M2X
- native horizontal FOV: `360°`
- Wingtra mapping horizontal FOV: `90°`
- vertical FOV: `40.3°`
- vertical angle range: `-20.8°` to `+19.5°`
- vertical spacing: `1.3°`
- channels: `32`
- frame rate options: `5 / 10 / 20 Hz`
- native point rates:
  - single return: `640k pts/s`
  - dual return: `1280k pts/s`
  - triple return: `1920k pts/s`
- effective mapping-sector rates used in the app today:
  - single: `160k pts/s`
  - dual: `320k pts/s`
  - triple: `480k pts/s`
- practical max range currently assumed in the app: `200 m`

Known implementation guidance from the payload team:

- horizontal mapping FOV: `90°`
- vertical FOV: `-20.8°` to `19.5°`
- vertical spacing: `1.3°`

## Target Outcome

The planner should produce a lidar raster that is closer to the delivered mission in both:

- **magnitude**: area mean `pts/m²`
- **shape**: striping, edge falloff, holes, and terrain-related variation

It does not need to be a forensic sensor simulator. It does need to be a defensible planning model.

## Fidelity Strategy

Replace the current uniform strip model with a **scan-geometry model** that samples the actual lidar acquisition pattern at planning time.

At a high level:

1. build the terrain-aware 3D flight trajectory
2. turn trajectory into time-sampled lidar scan states
3. emit beams for the `32` channels over the `90°` mapping sector
4. intersect those beams with the DEM
5. accumulate beam hits into a density raster
6. compute stats over the polygon mask

This keeps the existing planning UI and raster pipeline, but changes the physical model behind the density.

## Proposed Phases

### Phase 0: Lock the Measurement Harness

Before changing the worker again, freeze the verification path.

Work:

- commit a reusable comparison tool for:
  - flightplan polygons
  - delivered LAS density raster
  - flown trajectory overlay
  - per-area stats
- add a repeatable metric extractor for:
  - all returns
  - first returns only
  - optional strongest / last if derivable
- produce one saved baseline report for:
  - Ecores
  - Uetliberg

Deliverable:

- one command that regenerates the comparison HTML and CSV/JSON summaries for both missions

Acceptance:

- re-running the tool produces stable per-area stats for both missions

### Phase 1: Upgrade the Lidar Domain Model

Add explicit sensor geometry to the domain layer instead of storing only effective rates and horizontal FOV.

Files:

- `src/domain/lidar.ts`
- `src/domain/types.ts`

Add:

- `verticalAnglesDeg: number[]` with the `32` XT32M2X design angles
- `nativeHorizontalFovDeg: 360`
- `mappingHorizontalFovDeg: 90`
- `frameRateHz`
- `nativePointRates`
- `effectivePointRates`
- `azimuthSectorCenterDeg`
- `boresightYawDeg`
- `boresightPitchDeg`
- `boresightRollDeg`
- `maxRangeM`
- `comparisonReturnMode`

Notes:

- Use the published design angles first.
- Keep room for a future per-unit correction file if Wingtra or Hesai calibration becomes available.
- Represent return mode separately for:
  - planning assumption
  - validation comparison

Acceptance:

- lidar configuration is explicit in the domain model and no longer implied by helper constants alone

### Phase 2: Replace Swath Math with Scan-State Sampling

Move from "density per strip" to "beam sampling over time."

Files:

- `src/overlap/lidar-worker.ts`
- likely `src/overlap/types.ts`
- possibly `src/overlap/controller.ts`

Model:

- treat each planned line as a time-varying sensor path
- derive scan samples at a configurable cadence
- for each sample:
  - compute aircraft position from the 3D path
  - compute sensor orientation
  - generate beam directions for the `32` channel angles
  - sweep only the Wingtra-used azimuth sector

Implementation choices:

- default to a deterministic sample grid, not Monte Carlo
- discretize along-track time and azimuth so results are stable across runs
- expose a quality setting internally:
  - `fast`: coarse scan sampling for interactive updates
  - `high`: denser sampling for manual verification

Acceptance:

- raster shape begins to show realistic cross-track and along-track banding instead of nearly uniform strip fill

### Phase 3: Terrain Intersection per Beam

Every sampled beam should intersect terrain explicitly.

Files:

- `src/overlap/lidar-worker.ts`
- shared math helpers as needed

Model:

- cast a ray from sensor position along the beam direction
- intersect against the DEM
- stop when:
  - hitting terrain
  - exceeding max range
  - leaving the sampled tile bounds

Recommended implementation:

- first pass: stepped ray march with bounded refinement
- second pass if needed: binary search refinement near sign change

Accumulate:

- deposit one contribution into the target raster cell at the intersection point
- optionally spread into a small kernel if a smoother raster is needed

Acceptance:

- range holes are physically tied to missing intersections, not just strip-distance masks
- terrain-facing slopes and ridges affect the raster through actual beam geometry

### Phase 4: Return-Mode Semantics and Delivered-Density Comparison

The model must stop conflating "single return" with "all delivered LAS points."

Files:

- `src/domain/lidar.ts`
- `src/components/OverlapGSDPanel.tsx`
- verification scripts

Rules:

- planning `single` mode should compare primarily against **first-return** LAS density
- planning `dual` and `triple` modes may compare against all returns or a filtered subset, depending on mission output
- the UI should label what is being predicted:
  - `Predicted first-return density`
  - or `Predicted all-return density`

Needed tooling:

- LAS comparison scripts must be able to filter by return number
- summary tables should show:
  - first-return actual
  - all-return actual
  - predicted density

Acceptance:

- validation becomes apples-to-apples
- Uetliberg no longer looks anomalous simply because the comparison mixes return definitions

### Phase 5: Calibrate Azimuth Sector Orientation and Boresight

The `90°` mapping sector must be oriented correctly relative to the aircraft and the ground.

Why:

- even with correct rates and channel angles, the raster will still be wrong if the `90°` sector is centered in the wrong direction
- the exact boresight / mounting orientation may shift where density concentrates across the swath

Plan:

- start with a symmetric nadir-centered interpretation
- compare against Ecores striping and edge falloff
- evaluate a small set of boresight and sector-center hypotheses
- choose the default that minimizes per-area and per-raster error on the real missions

Important constraint:

- do not expose boresight tuning in the normal UI unless there is strong evidence users need it
- keep it as a model constant or advanced/debug setting first

Acceptance:

- raster striping aligns visually with delivered LAS striping on the comparison missions

### Phase 6: Improve Statistics and User-Facing Semantics

Once the worker is more physical, make the outputs clearer.

Files:

- `src/components/OverlapGSDPanel.tsx`
- overlay legend helpers

Changes:

- distinguish:
  - nominal density from the imported `.flightplan`
  - predicted density from the worker
  - delivered density from validation tooling
- expose the model basis in tooltips:
  - return mode
  - speed
  - horizontal sector
  - max range
- optionally show a "model fidelity" note for lidar:
  - `Strip model`
  - `Beam model`

Acceptance:

- users can tell whether a number is nominal, predicted, or measured

### Phase 7: Performance and Fallback Strategy

A beam model will be more expensive than strip math. Keep the app interactive.

Plan:

- preserve the current strip model as a fallback or low-quality preview
- run the beam model in the worker only
- sample only the azimuth sector and relevant DEM tiles
- cache per-line scan samples where possible
- allow progressive refinement:
  - quick preview first
  - refine on idle or after user stops editing

Acceptance:

- interaction remains usable on typical imported missions
- no main-thread stalls

### Phase 8: Validation and Release Criteria

Use the two real missions as hard gates before shipping the new model as default.

Validation set:

- Ecores:
  - compare against first-return density
  - focus on matching per-area means and overall raster texture
- Uetliberg:
  - compare against both first-return and all-return density
  - verify semantics for multi-return delivery

Release targets:

- overall mean density error within about `10%` on Ecores
- per-area mean density error within about `15%` on most Ecores polygons
- visible raster pattern significantly closer to delivered striping on both missions
- no obvious systematic inflation at polygon edges or overlap zones
- imported flightplan density cards remain numerically stable across repeated runs

## Concrete Code Touchpoints

These files are the primary implementation surface:

- `src/domain/lidar.ts`
  - add XT32M2X channel geometry and scan parameters
- `src/domain/types.ts`
  - add explicit lidar fidelity / scan config fields
- `src/interop/wingtra/convert.ts`
  - preserve imported speed and lidar defaults consistently
- `src/overlap/lidar-worker.ts`
  - replace strip-density accumulation with beam-ground intersection sampling
- `src/overlap/types.ts`
  - add scan-state and beam-sample data structures
- `src/components/OverlapGSDPanel.tsx`
  - clarify statistics and labels
- `src/components/PolygonParamsDialog.tsx`
  - only if advanced lidar fields become user-configurable

## Known Unknowns

These are the main fidelity risks:

- exact Wingtra boresight / mounting geometry is not fully documented in the repo
- Hesai per-unit correction files are not available in the app
- delivered LAS may have post-processing, thinning, filtering, or return-selection behavior not represented in flight planning
- Mapbox terrain is not identical to a surface derived from the delivered LAS
- browser performance may limit how dense the beam simulation can be

## Recommended Order

Recommended implementation order:

1. lock the measurement harness
2. add explicit XT32M2X geometry to the domain layer
3. implement beam sampling in the worker
4. implement DEM intersection per beam
5. split first-return vs all-return validation
6. calibrate azimuth sector orientation
7. optimize performance
8. switch the beam model to the default path after validation

## Non-Goals for the First Fidelity Pass

Do **not** try to solve all of these in the first pass:

- full waveform simulation
- vegetation penetration modeling
- intensity prediction
- exact per-unit factory calibration
- point-cloud-derived terrain inside the app itself

Those can come later if needed. The first target is a physically defensible planner that matches the delivered mission much better than the current strip model.
