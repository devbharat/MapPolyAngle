# Terrain Face Partition Plan

## Current Status

Implemented on the working branch as a conservative V1:

- recursive binary splitting over straight candidate cuts
- polygon scoring that combines terrain-fit, flight-line flyability, and shape penalties
- explicit split penalty to keep polygon count low
- post-split merge pass to recombine adjacent pieces when simplicity wins
- UI action in the coverage panel to auto-split one polygon in place
- synthetic regression harness in `src/tests/terrain_face_partition.test.ts`
- terrain-break-aware candidate generation and boundary scoring
- ridge-following boundary refinement for accepted cuts
- immediate analysis reset and fresh recompute after a split

Current validation:

- `npm run build`
- `npm run test:terrain-split`

Current limitations:

- boundaries are only locally ridge-following; the main search is still based on straight cut hypotheses
- no preview / accept-reject workflow yet; accepted splits replace the source polygon immediately
- thresholds are heuristic and will likely need tuning against real mountain missions
- no browser smoke test has been recorded in this plan yet

## Goal

Automatically split a large user polygon into a small number of smaller polygons so each one better matches a single mountain face, allowing the app to assign a better flight direction per sub-area.

The split must not produce:

- too many polygons
- very thin or very long sliver polygons
- highly irregular or deeply concave polygons
- polygons whose chosen flight direction leads to many short clipped lines and too many turns

This is not just a terrain segmentation problem. It is a constrained planning problem with a terrain-fit objective and an operational flyability objective.

## What Exists Today

The current app assumes one dominant face per polygon.

- `src/components/MapFlightDirection/hooks/usePolygonAnalysis.ts`
  - fetches terrain tiles for a polygon
- `src/utils/terrainAspectHybrid.ts`
  - samples DEM inside the polygon
  - fits one robust plane
  - returns one `contourDirDeg` and fit metrics
- `src/components/MapFlightDirection/utils/mapbox-layers.ts`
  - clips a family of parallel flight lines to the polygon

This works if the polygon already matches a single face. It fails when one polygon spans multiple faces, ridges, or gullies.

## Core Problem Formulation

Given polygon `P`, find a partition `{P1, P2, ..., Pn}` with small `n` such that:

- each `Pi` has low internal terrain-direction disagreement
- each `Pi` has a stable dominant contour direction
- each `Pi` is operationally flyable
- the total complexity penalty for extra polygons stays low

We should optimize a cost of the form:

`TotalCost = TerrainFit + FlightCost + ShapeCost + PolygonCountPenalty`

### Terrain Fit Terms

- local contour-direction variance within the polygon
- plane-fit `rmse`
- plane-fit `rSquared`
- local curvature / breakline strength

### Flight Cost Terms

- estimated number of flight lines
- estimated number of turns
- mean / median clipped line length
- short-line penalty
- line fragmentation count

### Shape Cost Terms

- minimum width penalty
- thinness / aspect-ratio penalty
- compactness penalty
- concavity penalty
- very small area penalty

### Complexity Terms

- explicit penalty per additional polygon
- optional hard cap on number of sub-polygons

## Promising Algorithm Families

### 1. Recursive Binary Splitting

Start with the full polygon. If its score is bad enough, test candidate cut lines, apply the best valid split, then recurse on each child.

Pros:

- naturally minimizes polygon count
- easy to add operational penalties
- easy to reject ugly or skinny splits
- fits current architecture well

Cons:

- cut candidate generation matters a lot
- straight-line cuts can be too rigid on curved terrain

### 2. Raster Segmentation Then Polygonize

Rasterize the polygon, compute local terrain descriptors per cell, segment into contiguous regions of similar terrain, polygonize, then merge aggressively.

Pros:

- can follow curved face boundaries
- best long-term fit for complex terrain

Cons:

- tends to over-segment
- requires strong post-processing and merging
- easier to produce ugly small regions

### 3. Direction-Field Segmentation

Compute a local desired flight-direction field, then segment the polygon into contiguous regions where the preferred direction is approximately constant.

Pros:

- directly aligned with planning objective
- more relevant than segmenting raw slope alone

Cons:

- still needs strong shape and turn penalties
- direction is axial, so `0°` and `180°` must be treated as equivalent

### 4. Breakline-Driven Decomposition

Detect ridges, gullies, and strong aspect discontinuities first, then use those as candidate boundaries for a partitioning or merge process.

Pros:

- uses interpretable terrain structure

Cons:

- not sufficient by itself
- smooth terrain transitions will not be handled well

## Recommended V1

Use **recursive binary splitting with a strong cost function**.

This is the most pragmatic first implementation because it:

- works with the current per-polygon analysis model
- gives direct control over polygon count
- allows operational penalties to dominate when needed
- is much easier to debug than full raster segmentation

## Recommended V1 Pipeline

### Step 1. Build a Terrain Descriptor Grid

Inside the user polygon, sample a moderate-resolution raster grid from the DEM.

Per cell, compute:

- local slope
- local aspect
- local contour direction
- local plane-fit residual in a small moving window
- local curvature / terrain break strength

This gives a field that shows where one-face assumptions break down.

Current implementation note:

- the working branch now builds a coarse local contour-direction descriptor grid
- each descriptor point also gets a local break-strength score from nearby direction disagreement

### Step 2. Score the Unsplit Polygon

For the original polygon, estimate:

- direction coherence
- plane-fit quality
- expected flight-line count
- expected turn count
- expected line fragmentation
- shape quality

If the polygon already scores well, do not split.

### Step 3. Generate Candidate Cuts

Do not brute-force arbitrary cuts. Use a limited candidate set.

Candidate lines should come from:

- centroid-passing cuts at sampled angles
- axes aligned with strongest internal direction disagreement
- breakline directions from curvature/aspect changes
- optional cuts through high-residual zones

Each candidate cut produces two child polygons after clipping.

Current implementation note:

- generic sampled cut angles remain as fallback
- the splitter now also proposes cuts aligned to the principal axis of strong break-strength hotspots
- offsets are no longer only fixed fractions; cuts through the weighted centroid of the hotspot cluster are also tried
- after a cut is chosen, the shared boundary can be refined into a short ridge-following polyline built from strong break samples between the two polygon-edge intersections

### Step 4. Reject Bad Splits Early

Reject a candidate immediately if either child polygon:

- is too small
- is too thin
- is too concave
- has poor compactness
- yields too many very short flight lines

### Step 5. Evaluate Split Benefit

For each valid split:

- analyze each child polygon with the existing plane-fit direction logic
- estimate its operational flight cost with the existing line clipper
- compute total score of both children plus split penalty
- reward cuts whose boundary passes through a strong terrain break and separates different local contour directions

Only accept the split if it beats the parent score by a clear margin.

Current implementation note:

- the coverage panel now clears stale per-tile overlay state immediately after a split and reruns analysis on the child polygons instead of leaving the parent raster visible until a later incremental refresh

### Step 6. Recurse

Repeat on children until:

- no split improves score enough
- max depth is reached
- max polygon count is reached

### Step 7. Merge Pass

After recursion, examine adjacent polygons and merge any pair whose merged score remains acceptable.

This is important to undo over-splitting and keep the result simple.

## Candidate Objective Function for V1

For polygon `Pi`:

`Score(Pi) = w_dir * DirectionVariance`
`          + w_fit * PlaneFitError`
`          + w_turn * TurnCost`
`          + w_short * ShortLinePenalty`
`          + w_shape * ShapePenalty`
`          + w_count`

Where:

- `DirectionVariance`
  - axial circular variance of local contour directions
- `PlaneFitError`
  - normalized `rmse` and/or `1 - rSquared`
- `TurnCost`
  - estimated number of turns or turns per acre
- `ShortLinePenalty`
  - penalty for lines below a minimum useful straight length
- `ShapePenalty`
  - thinness, concavity, compactness, min-width violations
- `w_count`
  - fixed penalty for creating one more polygon

The fixed polygon penalty is what enforces “few as possible”.

## Operational Metrics to Reuse From the Existing App

The line generator already provides a practical notion of flyability:

- `src/components/MapFlightDirection/utils/mapbox-layers.ts`

Instead of relying only on abstract geometry, use the generated clipped lines to estimate:

- line count
- median straight length
- minimum straight length
- line-length distribution
- fragmentation

This makes the splitter optimize for what the drone will actually fly.

## Data Representation Recommendation

V1 should work on a raster-backed internal representation and only polygonize accepted splits.

Suggested internal flow:

1. raster mask of the original polygon
2. candidate split line applied to the mask
3. connected-component extraction for each side
4. simplify / polygonize accepted components
5. run existing polygon analysis on resulting vector rings

This is easier than trying to perform all splitting directly in vector geometry.

## Constraints to Encode Explicitly

- max polygon count per original area
- minimum polygon area
- minimum polygon width
- minimum median straight length
- maximum allowed concavity
- optional minimum score improvement required for every accepted split

These should be user-tunable later, but hard-coded defaults are fine for V1.

## Implementation Phases

### Phase 1. Research and Scoring Harness

- add a terrain descriptor grid generator for a polygon
- add axial direction-variance utilities
- add a polygon flyability scorer using the existing line generator
- add a simple debug overlay showing local direction field / residuals

Deliverable:

- ability to score a polygon and understand why it should or should not split

### Phase 2. Candidate Split Engine

- generate candidate cut lines
- split polygon mask by a candidate line
- reject invalid child shapes early
- evaluate parent vs child score

Deliverable:

- choose the best single split for one polygon

### Phase 3. Recursive Partitioning

- recursively apply the best split
- enforce depth and polygon-count caps
- record split tree and scores

Deliverable:

- full automatic partitioning result for one user polygon

### Phase 4. Merge and Regularization

- merge adjacent polygons when the merge score is acceptable
- simplify boundaries
- remove slivers and tiny artifacts

Deliverable:

- cleaner final polygons with fewer operationally bad shapes

### Phase 5. Product Integration

- add “Auto-split by terrain faces” action
- preview proposed sub-polygons before applying
- let user accept all, reject all, or keep only selected splits

Deliverable:

- usable end-to-end feature in the app

## Recommended Validation Cases

Use several categories:

- single-face polygon
  - should not split
- two-face polygon with clear ridge
  - should split once
- broad curved hillside
  - should split minimally or not at all
- highly non-convex polygon
  - should avoid producing many slivers
- imported large Wingtra mountain mission
  - compare manual user split vs automatic split

Validation metrics:

- number of output polygons
- average fit quality improvement
- reduction in direction variance
- reduction in short clipped lines
- total estimated turns
- qualitative map review

## Main Risks

### Risk 1. Over-Splitting

Most likely failure mode.

Mitigation:

- strong polygon-count penalty
- post-merge stage
- strict minimum improvement threshold

### Risk 2. Ugly or Unflyable Polygons

Mitigation:

- explicit min-width, compactness, and short-line penalties
- early rejection of slivers

### Risk 3. Good Terrain Segmentation but Bad Flight Plans

Mitigation:

- use the actual line clipper in the score loop
- make operational cost a first-class term, not a post-check

### Risk 4. Too Slow

Mitigation:

- coarse raster for candidate search
- evaluate only a small candidate cut set
- recurse only when score is clearly poor

## Final Recommendation

Start with:

- recursive binary splitting
- raster-backed candidate evaluation
- cost function dominated by terrain-direction coherence and operational flyability
- mandatory polygon-count penalty
- post-merge cleanup

Do **not** start with free-form segmentation or generic clustering alone. Those are more likely to produce many small, irregular regions before we have the right operational constraints in place.
