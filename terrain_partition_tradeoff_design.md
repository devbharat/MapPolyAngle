# Terrain Partition Tradeoff Design

## Current Implementation Status

Phases 1 through 4 now exist as backend prototypes in the working branch, but the latest real-mountain validation exposed a major formulation flaw in the current frontier builder.

- `src/utils/terrainPartitionObjective.ts`
  - builds a terrain guidance field
  - evaluates one region for one candidate bearing
  - estimates surrogate quality loss for camera and lidar
  - estimates mission time from line geometry, turns, and region overhead
  - combines multiple region objectives into one partition-level objective
- `src/tests/terrain_partition_objective.test.ts`
  - validates quality-preferred vs time-preferred bearing selection
  - validates lidar tail-risk behavior
  - validates partition-level time aggregation
- `src/utils/terrainPartitionGraph.ts`
  - atomizes the guidance field into contiguous terrain atoms
  - builds an atom adjacency graph
  - evaluates a merge-path partition frontier over tradeoff samples
  - retains intermediate merge states instead of only one terminal partition per tradeoff sample
- `src/tests/terrain_partition_graph.test.ts`
  - validates multi-atom graph construction on a synthetic two-face terrain
  - validates that the frontier retains both faster merged and higher-quality split solutions
  - validates that the frontier does not collapse to only one partition size

What is still missing:

- replacing the current merge frontier with a coarse-to-fine major-face splitter
- local refinement / cleanup of the final chosen partition
- frontier thinning / clustering for UI readability on large polygons
- user-facing explanation of quality/time deltas beyond the current technical preview

What now exists in the app:

- `Auto split` can use the partition frontier before falling back to the legacy heuristic splitter
- the map API exposes partition solution previews and solution application
- the analysis panel has a first in-app harness for loading and applying partition tradeoff options
- the selected frontier option can run an exact worker-backed preview of predicted GSD or lidar density before the partition is applied
- the frontier now preserves multiple intermediate partition sizes on real mixed-terrain polygons, so the tradeoff control is no longer forced to a single endpoint in many cases

What the latest validation showed:

- on polygons spanning two adjacent mountain faces, the current frontier often keeps one large parent-like region and peels off a few tiny edge regions
- that improves the scalar objective cheaply, but does not produce the meaningful first split the user expects
- the desired coarsest non-trivial solution is usually a balanced two-face partition, not a large area plus small residual outliers

So the current graph frontier is useful as a prototype for the objective and exact-preview plumbing, but it is not the right final optimizer.

## Why The Current Approach Tops Out Early

The current auto-splitter is a heuristic top-down splitter:

- score one polygon
- test a few candidate cuts
- accept a split if the child polygons look better than the parent
- recurse conservatively

That can produce useful results, but it is not solving the real product problem.

The real problem is not:

- "find a ridge"
- or "make polygons more face-aligned"

The real problem is:

- maximize predicted data quality
- while keeping estimated mission time reasonable

Those two goals oppose each other. One area is fast but lower quality. Many small areas can give better quality but more turns, more repositioning, and longer missions.

So the correct formulation is a **regularized partition optimization problem** with an explicit tradeoff parameter, not a single heuristic split threshold.

There is also a second, more specific lesson from the latest tests:

- a generic merge frontier over small terrain atoms tends to optimize by shaving off small high-error regions
- this is an "outlier peeling" behavior
- it does not force the first split to explain the dominant mountain faces

That is why the current model can improve the score while still producing visually and operationally poor partitions.

## Product Goal

For one user polygon, produce a family of candidate partitions ranging from:

- few regions / faster mission
- more regions / higher quality mission

Then expose a UI slider that lets the user choose a point on that tradeoff curve.

This is better than a simple "aggressiveness" threshold because the slider should correspond to something meaningful:

- predicted quality improvement
- estimated mission-time increase

## Proper Problem Formulation

Given:

- polygon `P`
- terrain `D`
- sensor model `S` (camera or lidar)
- flight parameters `F`
- user tradeoff weight `lambda` in `[0, 1]`

Find a partition:

- `Partition(P) = { (R1, theta1), (R2, theta2), ..., (Rk, thetak) }`

where:

- the `Ri` are contiguous, non-overlapping regions
- their union equals `P`
- each `theta_i` is the flight direction for region `R_i`

such that the total objective is minimized:

`J_lambda = lambda * Q(partition) + (1 - lambda) * T(partition) + H(partition)`

Where:

- `Q(partition)` = predicted data-quality loss
- `T(partition)` = estimated mission-time cost
- `H(partition)` = hard and soft regularization penalties

## The Three Objective Terms

### 1. Quality Term `Q`

This should measure how much quality we lose by forcing one orientation over a region with real terrain variation.

It must be sensor-aware.

#### Camera quality loss

For a candidate region/orientation pair, use a low-resolution predicted quality metric built from:

- terrain-direction mismatch
- expected GSD worsening from terrain variation across lines
- expected overlap shortfall / weak coverage zones
- tail risk, not just mean quality

Recommended camera region loss:

`Q_cam(R, theta) =`

- `w1 * mean_excess_gsd`
- `+ w2 * p90_excess_gsd`
- `+ w3 * underlap_area_fraction`
- `+ w4 * fragmented_line_fraction`

Where `excess_gsd` is measured relative to the flat-ground or target GSD implied by the chosen altitude and camera.

#### Lidar quality loss

For lidar, use:

- density shortfall below target
- no-return / hole area
- range-violation area
- tail risk, not just mean density

Recommended lidar region loss:

`Q_lidar(R, theta) =`

- `w1 * mean_density_shortfall`
- `+ w2 * p10_density_shortfall`
- `+ w3 * hole_area_fraction`
- `+ w4 * range_violation_area_fraction`

Where density shortfall is measured against the target density implied by altitude, speed, return mode, and overlap.

### 2. Mission-Time Term `T`

This is the operational counterweight to over-splitting.

Mission time should not be approximated only by polygon count. It should come from the actual flight pattern we would fly.

Recommended region time model:

`T(R, theta) = sweep_time + turn_time + overhead_time`

With:

- `sweep_time = total_flight_line_length / cruise_speed`
- `turn_time = turn_count * average_turn_cost`
- `overhead_time = per_region_entry_exit_cost`

For the whole partition:

`T(partition) = sum_i T(R_i, theta_i) + inter_region_penalty * (k - 1)`

This captures the actual user complaint:

- too many small regions are bad because they increase turns and area-to-area inefficiency

### 3. Regularization / Hard Constraints `H`

These keep the result practical.

Hard constraints:

- min area
- min width relative to line spacing
- contiguous regions only
- no holes unless explicitly allowed
- max polygon count cap

Soft penalties:

- high concavity
- extreme aspect ratio
- ragged boundaries
- too much boundary length

Important: this term should be weaker than the actual quality/time terms. It exists to eliminate pathological shapes, not to dominate the tradeoff.

## The Right User Slider

The slider should not directly mean:

- "split more"
- or "be more aggressive"

It should mean:

- "prefer higher quality" on one side
- "prefer shorter mission time" on the other side

So the UI should operate on a **Pareto frontier** of candidate solutions.

Workflow:

1. generate a set of candidate partitions
2. evaluate each candidate with `(Q, T)`
3. keep only Pareto-non-dominated solutions
4. sort the frontier from fastest to best-quality
5. map the slider to this ordered frontier

This gives the user something honest:

- every slider position corresponds to a real solution
- no hidden arbitrary threshold
- the UI can show the estimated quality and mission-time deltas

Additional requirement from the latest validation:

- the first nontrivial slider step should usually correspond to a major balanced face split when the polygon clearly spans two dominant aspects
- tiny residual regions should appear only at finer slider positions, not at the coarsest quality-improving level

## Recommended Search Strategy

The best practical approach is not the current pure merge frontier. It should be:

- **dominant-face discovery first**
- then **balanced contiguous bipartition**
- then **coarse-to-fine recursive refinement**

### Stage A. Build A Terrain Guidance Field

Rasterize the polygon interior at moderate resolution.

For each cell, compute:

- local preferred flight direction `phi(x)`
- confidence / anisotropy `a(x)`
- ridge/valley / break strength `b(x)`
- local predicted quality loss for each candidate direction

This field is the foundation for everything that follows.

### Stage B. Create Small Terrain Atoms

Generate an initial oversegmentation into small contiguous "terrain atoms" using:

- watershed or superpixels on the break-strength map
- similarity of preferred direction
- spatial compactness

Important:

- these are not final flight polygons
- they are optimization primitives

Typical scale:

- roughly 20 to 60 atoms for a large mountain polygon

### Stage C. Build A Region Adjacency Graph

Each atom becomes a node.

Edges connect atoms that share a boundary.

Each node or merged region will have:

- geometry
- best orientation
- quality estimate
- time estimate
- shape penalties

### Stage D. Discover Dominant Face Modes Per Region

For each candidate region, identify whether it should stay whole or split into two major faces.

Recommended approach:

- fit `K = 1` versus `K = 2` axial direction modes over the region guidance field
- require minimum mass per mode for coarse splits, e.g. each child should represent at least `20%` to `25%` of parent area
- reject candidate splits where one side is only a small residual sliver unless the user is already at a fine-detail slider position

This is the key change relative to the current implementation. The optimizer must first decide whether there are two dominant mountain faces, not merely whether some small atoms should stay separate.

### Stage E. Solve A Balanced Contiguous Bipartition

When `K = 2` is supported strongly enough, solve a balanced graph partition over the atoms:

- unary term: how well each atom fits face mode `A` versus face mode `B`
- pairwise term: keep neighboring atoms together unless the boundary follows strong terrain breaks
- balance term: penalize very small children
- boundary term: reward cuts that align with ridges / aspect discontinuities

This produces the first major split.

### Stage F. Build The Frontier As A Hierarchical Split Tree

Instead of treating the frontier as an unordered bag of merge states, build it as a nested hierarchy:

- root: original polygon
- first split: best major two-face bipartition
- next splits: best refinement of one existing region
- continue while quality gain justifies extra mission time

Then:

- record every accepted hierarchy level as a candidate partition
- Pareto-filter or lightly prune those hierarchy levels for display

This ensures the slider moves through meaningful coarse-to-fine solutions rather than arbitrary edge peel-offs.

## Region Evaluation: Exact vs Surrogate

We should not run the full camera/lidar worker for every tiny optimization step. That will be too slow.

So use a two-level evaluator.

### Fast surrogate for search

During optimization, use a low-resolution surrogate:

- direction mismatch to local preferred field
- terrain-relief-across-lines proxy
- line fragmentation proxy
- estimated line count / turn count from the line generator

This is fast enough for iterative search.

### Exact evaluator for selected candidates

For the top candidate frontier solutions:

- run the actual camera or lidar analysis pipeline
- recompute exact predicted GSD or density maps
- update the displayed frontier stats

This gives us search speed and final accuracy.

## A Better Search Loop Than Today

The current prototype effectively works bottom-up from atoms and can prefer tiny edge regions.

The recommended design is:

1. build terrain atoms
2. for the current region, test whether it contains one dominant face or two dominant faces
3. if two dominant faces exist, solve the best balanced contiguous bipartition
4. score the split by:
   - coherence gain
   - predicted sensor-quality gain
   - added mission-time cost
   - complexity penalty
5. accept the best positive split
6. recurse only as far as needed for the chosen tradeoff level
7. for the currently selected hierarchy level:
   - finalize region orientations
   - run exact quality analysis
   - show polygons and overlays

Optional refinement pass:

- boundary smoothing / snapping to ridge field
- local boundary moves between neighboring regions
- merge tiny leftovers

This is far more principled than either the old heuristic cutter or the current atom-merge frontier.

## Why This Better Matches The Product Goal

This design directly optimizes the quantity the user actually cares about:

- quality vs time

It is better than the current heuristic because:

- polygon count becomes a consequence, not the main control variable
- the user gets a real slider over real tradeoff solutions
- curved terrain faces are handled naturally
- camera and lidar can share the same optimization framework
- exact workers remain the final source of truth for selected solutions

And it is better than the current merge-frontier prototype because:

- the first split is forced to represent major terrain faces
- small edge regions are delayed until later refinement levels
- the resulting hierarchy matches what a human planner expects to see

## Recommended UI

Replace "Auto split" as a one-shot action with:

- `Auto partition`
- `Tradeoff` slider: `Faster` <-> `Better quality`
- compact summary:
  - estimated total flight time
  - estimated turns
  - estimated mean / worst quality
  - number of regions

Optional:

- show 3 frontier presets:
  - `Fast`
  - `Balanced`
  - `Quality`

That can exist alongside the continuous slider.

## Implementation Plan

### Phase 1. Formal Scoring Layer

Add a unified scoring layer for region/orientation pairs:

- camera quality surrogate
- lidar quality surrogate
- mission-time estimator
- hard constraints and soft penalties

Deliverable:

- one function that evaluates a candidate region for a given orientation and sensor

Status:

- implemented in `src/utils/terrainPartitionObjective.ts`

### Phase 2. Terrain Guidance Field

Build the raster guidance field:

- preferred direction
- confidence
- break strength
- local directional cost volume over discrete bearings

Deliverable:

- reusable optimization grid per source polygon

Status:

- implemented in `src/utils/terrainPartitionObjective.ts`

### Phase 3. Oversegmentation Into Atoms

Create contiguous terrain atoms.

Deliverable:

- adjacency graph over atoms

Status:

- implemented as a first contiguous atom graph in `src/utils/terrainPartitionGraph.ts`

### Phase 4. Prototype Frontier Builder

Implement a prototype frontier builder and use it to validate the objective plumbing and UI preview path.

Deliverable:

- a first set of candidate solutions for one polygon

Status:

- implemented as a first greedy merge frontier builder in `src/utils/terrainPartitionGraph.ts`
- validated as conceptually insufficient on real two-face mountain polygons because it prefers edge peel-offs over major face splits

### Phase 5. Major-Face Hierarchical Splitter

Replace the prototype frontier builder with a hierarchical coarse-to-fine partitioner:

- discover one-face vs two-face structure per region
- solve balanced contiguous bipartitions
- require minimum child mass for coarse splits
- build a nested split tree
- expose hierarchy levels as the main tradeoff path

Deliverable:

- the first nontrivial option is usually a meaningful two-face split when the polygon spans two dominant aspects

### Phase 6. Exact Evaluation And UI Slider

For the selected frontier solution:

- build final sub-polygons
- run exact GSD or lidar analysis
- show predicted quality and mission time

Deliverable:

- end-to-end user-facing tradeoff control

### Phase 7. Local Refinement

Improve boundaries after the coarse partition is chosen:

- boundary smoothing
- ridge snapping
- small-region cleanup

Deliverable:

- cleaner production-quality polygons

## What To Reuse From The Existing Repo

Keep and reuse:

- terrain plane fitting in `src/utils/terrainAspectHybrid.ts`
- line generation in `src/components/MapFlightDirection/utils/mapbox-layers.ts`
- camera and lidar quality workers as exact evaluators
- current overlay pipeline for final visualization

The current heuristic splitter should become:

- a temporary fallback
- or a debug/baseline mode

It should not remain the main design.

## Concrete Recommendation

Do not keep tuning the current merge-frontier prototype as the main optimizer.

The right long-term implementation is:

- raster guidance field
- terrain atoms
- dominant-face detection
- balanced contiguous bipartition
- hierarchical split tree from coarse to fine
- exact worker-backed evaluation for the selected level
- slider-driven final selection

That is the clean, principled formulation that matches the actual product outcome and the behavior shown in the latest screenshots.
