# Line-Lift Objective Plan

## Why This Plan Exists

The partition optimizer still misses an important physical effect:

- flight lines in one region share a single planned altitude profile
- one ridge / peak under a line can raise the entire line
- that makes the sensor too high above large parts of the region
- this can damage quality even when the region heading is otherwise correct

So splitting can be beneficial for **two different reasons**:

1. the terrain aspect changes, so a different heading is better
2. a ridge / peak lifts a set of lines, so separating it reduces over-height for nearby terrain even if the heading stays the same

The current formulation mostly captures the first reason.
It only weakly approximates the second.

That is why the optimizer can still produce partitions that look terrain-aware but do not actually heal the large low-density or bad-GSD bands.

## Core Insight

The app already computes the real effect in the evaluation path:

- exact flight lines exist
- the exact camera / lidar workers compute quality on the ground below them
- the UI displays the resulting raster

So the missing piece is not missing physics.
The missing piece is:

- the optimizer does not use an **optimization-time surrogate** for that same line-lift effect

The remedy is to add a new objective term that approximates the quality cost caused by line support height.

## New Objective Term

Add a new region-level term:

- `E_line(R, theta)`

The full formulation becomes:

- `E_total = E_node + E_cut + E_line + E_region + E_mission`

Where:

- `E_node`
  - sensor-aware local fit for assigning atoms
- `E_cut`
  - boundary creation cost on the atom graph
- `E_line`
  - cost from line support height / line-lift coupling
- `E_region`
  - convexity, compactness, fragmentation, overflight
- `E_mission`
  - turns, line length, inter-region overhead

This is the missing coupling term.

## What `E_line` Should Mean

For a candidate region `R` and heading `theta`:

1. approximate the family of flight lines that would cover `R`
2. for each line, compute the terrain profile under that line
3. determine the support height of the line
4. measure how much that support height exceeds the local terrain at the rest of the line

That excess height is the relevant quantity.

Call it:

- `delta_h(x) = planned_line_height(line(x)) - local_terrain_height(x) - target_AGL`

If `delta_h` is large:

- camera GSD gets worse
- camera overlap gets worse
- lidar density gets weaker
- lidar can hit no-return / range-limit holes

So the optimizer should penalize:

- large mean `delta_h`
- large upper-tail `delta_h`
- large area with `delta_h` above sensor-specific thresholds

## Design Goal

Use a cheap surrogate that is physically aligned with the exact coverage workers.

That means:

- do not invent another independent heuristic
- instead approximate the same quantity the exact raster depends on:
  - excess sensor height caused by the maximum terrain under each line

## Practical Surrogate

### Representation

For a region and heading:

- bin the region’s guidance cells into approximate flight lines using cross-track distance and line spacing
- each bin corresponds to one planned line

For each line bin:

- estimate `supportTerrainZ = max terrain z among cells in that bin`

For each cell assigned to that line:

- compute `lineLiftM = supportTerrainZ - cellTerrainZ`

This gives a cheap estimate of how much the line is being lifted above local terrain.

### Region summary metrics

From the set of `lineLiftM` values, compute:

- `meanLineLiftM`
- `p90LineLiftM`
- `maxLineLiftM`
- `liftAffectedAreaFraction(threshold)`

The threshold can be sensor-specific.

## Camera-Specific Use

For camera regions:

- convert line lift into GSD worsening
- estimate overlap / underlap risk from line lift

Recommended camera line-lift cost:

- mean excess GSD from line lift
- p90 excess GSD from line lift
- underlap risk from line lift

This term should be distinct from the current pure terrain-bearing mismatch term.

## Lidar-Specific Use

For lidar regions:

- convert line lift into slant-range increase / reduced density
- estimate hole / no-return risk where line lift pushes the beam beyond effective range

Recommended lidar line-lift cost:

- mean density deficit caused by line lift
- low-tail density deficit caused by line lift
- hole area fraction caused by line lift

This is especially important because:

- a narrow ridge can damage a wide swath of area under the same line family
- splitting off that ridge can help even if both child polygons keep similar or identical heading

## Relationship To Current Terms

### `E_node`

Keep `E_node` local and cheap.

It should still represent:

- local sensor-aware suitability
- local hole risk / weak-density risk

But it is atom-local and does not fully capture the shared-line coupling.

### `E_line`

This is the new nonlocal term.

It captures:

- one atom or peak raising many other samples on the same line

That is precisely the missing behavior today.

### `E_region`

Keep:

- convexity
- compactness
- fragmented lines
- inter-segment gap
- overflight transit

These are practical-shape terms, not substitutes for line-lift coupling.

## Where To Integrate It

### Objective layer

Primary file:

- `src/utils/terrainPartitionObjective.ts`

Add:

- line-bin construction helper
- line-lift summary helper
- sensor-specific conversion from line lift to quality loss

Expose something like:

- `LineLiftSummary`
- `evaluateLineLiftCost(...)`

### Partition graph layer

Primary file:

- `src/utils/terrainPartitionGraph.ts`

Use it in two ways:

1. **region evaluation**
   - include `E_line` in the region / partition score
2. **candidate generation**
   - add seed families from atoms with the strongest line-support impact

The second point matters:

- if a peak is currently lifting many lines
- that atom or neighborhood should become a split hotspot

## Candidate Generation Upgrade

Add a new hotspot family:

- **line-lift hotspot seeds**

For the parent region at its current best heading:

1. compute cheap line bins
2. identify atoms that contribute disproportionately to line support maxima
3. rank atoms by how much they raise nearby lines
4. seed new candidate regions from those atoms

This is different from:

- aspect hotspots
- break-strength hotspots
- hole-risk hotspots

It targets the exact “peak lifts whole line” failure mode.

## Incremental Computation Strategy

The optimizer cannot run the full exact worker at every assignment move.

So use a two-level approach:

### Level 1: cheap optimization-time surrogate

- based on guidance cells and approximate line bins
- fast enough to recompute during partition search

### Level 2: exact preview / reranking

- keep the existing exact worker-backed preview
- use it to validate and rerank candidate partitions

This keeps the optimizer principled without becoming too slow.

## Proposed Data Structures

Add to the objective layer:

- `LineLiftCellSample`
- `LineLiftBin`
- `LineLiftSummary`

Suggested fields:

- `supportTerrainZ`
- `meanLiftM`
- `p90LiftM`
- `maxLiftM`
- `affectedAreaFraction`

Optionally add per-region cached data for:

- line index per guidance cell
- support height per line bin

## Test Plan

### Unit tests

Add tests where:

1. two regions with the same heading differ only by whether a narrow peak is isolated
   - isolated-peak partition should score better
2. lidar line-lift hole case
   - line-lift-heavy region should have worse `E_line` than a split region
3. camera ridge-lift case
   - same heading but split region should reduce predicted GSD tail

### Graph tests

Add a synthetic terrain with:

- one dominant face
- one narrow high ridge embedded in it

Expected result:

- the optimizer should still find a practical split because of line-lift coupling
- even if aspect mode alone would not justify the split

### Browser acceptance

On hard lidar mountains:

- splits should begin isolating peaks / ridge spines that currently create long low-density bands
- repeated splits should create useful chunks even when some neighboring chunks keep similar headings

## Sequenced Implementation

### Phase 1

- add `LineLiftSummary` and line-bin surrogate helpers in `terrainPartitionObjective.ts`
- compute `E_line` for a completed region / heading

### Phase 2

- add line-lift hotspot seed generation in `terrainPartitionGraph.ts`
- use current parent heading to identify atoms that raise many lines

### Phase 3

- blend `E_line` into partition scoring
- tune its relative weight against cut cost and mission time

### Phase 4

- optionally add a fast incremental approximation for local assignment deltas
- if Phase 3 already moves the planner enough, this can remain an optimization later

## Design Rules

1. `E_line` must represent shared-line coupling, not just local aspect mismatch.
2. A narrow peak should be able to justify a split even when the child heading stays similar.
3. Exact preview and optimization surrogate should measure the same underlying phenomenon.
4. Shape penalties remain important, but they do not replace line-lift physics.
5. The formulation should continue to support both lidar and camera cleanly.

## Recommended Next Step

Implement **Phase 1**:

- add line-bin / support-height / line-lift summary to `terrainPartitionObjective.ts`
- expose a region-level `E_line` that can be plugged into partition scoring

That is the cleanest way to capture the missing nonlocal effect without overhauling the entire optimizer at once.
