# Terrain Partition Boundary-Cost Integration Plan

## Why This Plan Exists

The current partitioner still relies too much on:

- post-hoc shape filtering
- post-hoc convexity / compactness penalties
- post-hoc flight-line fragmentation penalties

That helps reject bad outputs, but it is not the same as making the optimizer *avoid creating* bad cuts in the first place.

The key idea to integrate cleanly is:

- treat partitioning as a region-labeling problem on a terrain-atom graph
- use a **node cost** for how well an atom fits a region orientation
- use an **edge cut cost** for how expensive it is to separate neighboring atoms

This is directly inspired by the older graph-cut formulation that worked well:

- cutting an edge should only happen when it buys a meaningful reduction in node cost
- cuts should be expensive across smooth same-face terrain
- cuts should be cheaper along real terrain breaks

We do **not** need to jump straight to a full graph-cut solver in this iteration. The immediate goal is to integrate the same idea into the current optimization cleanly.

## Current Formulation Gap

Today the optimizer mostly works like this:

1. build terrain atoms
2. assign atoms to regions using bearing-fit and a few geometric heuristics
3. score the resulting regions
4. reject obviously bad shapes afterward

What is missing is an explicit local penalty for the act of cutting a boundary.

That causes two failure modes:

- **token cuts / outlier peeling**
  - small edge regions get peeled off cheaply because the system is not paying enough for new boundaries
- **dumbbell / necked regions**
  - regions remain connected through a thin neck because the optimizer is not paying enough for the operational cost of disconnected flight-line fragments inside one region

The second issue is especially important for lidar:

- if one region contains two lobes with a narrow bridge
- its flight lines can overfly space that practically belongs to a neighboring region
- that is operationally bad and should be expensive during optimization, not only at the final filter stage

## Clean Target Formulation

Let:

- `G = (V, E)` be the terrain-atom graph
- each atom `i in V` has:
  - area
  - preferred flight bearing
  - slope magnitude
  - break strength
  - centroid
- each adjacency edge `(i, j) in E` has:
  - shared boundary length
  - local bearing discontinuity
  - local break/barrier score

For a partition with region labels `z_i` and region orientations `theta_r`, optimize:

`E_total = E_node + E_cut + E_region + E_mission`

Where:

- `E_node`
  - how poorly each atom fits the orientation of its assigned region
- `E_cut`
  - how expensive it is to cut boundaries between neighboring atoms
- `E_region`
  - region-level practicality and shape costs
- `E_mission`
  - actual flight efficiency costs

This keeps the graph-cut insight while remaining compatible with the current backend.

## Objective Terms

### 1. Node Term

For atom `i` assigned to region `r`:

`E_node(i, r) = w_fit * A_i * C_i * mismatch(preferredBearing_i, theta_r)`

Where:

- `A_i` = atom area
- `C_i` = confidence / steepness weight
- `mismatch(...)` = axial bearing mismatch loss

Practical rule:

- steep, confident terrain should contribute more strongly than flat/ambiguous terrain
- gradual-transition areas should still be representable because the cost is local, not binary

This term should keep using the current guidance field and sensor-aware region objective as the base.

### 2. Edge Cut Term

For neighboring atoms `i, j`:

- if `z_i == z_j`, no cut cost
- if `z_i != z_j`, pay:

`E_cut(i, j) = w_cut * L_ij * smoothnessCost_ij`

Where:

- `L_ij` = shared boundary length
- `smoothnessCost_ij` should be:
  - **high** across smooth same-face terrain
  - **low** along strong terrain breaks

Recommended structure:

`smoothnessCost_ij = baseSmoothness * S_ij * B_ij`

With:

- `S_ij`
  - same-face continuity factor
  - high when adjacent atoms have similar preferred bearing
  - low when they differ meaningfully
- `B_ij`
  - break/barrier discount
  - low when break strength is high
  - high when break strength is low

So the optimizer naturally learns:

- do not cut across smooth homogeneous terrain unless node-fit savings are large
- do cut along ridges / face boundaries when that materially improves region fit

This is the most important new term to add.

### 3. Region Shape Term

This should remain, but as a secondary term:

`E_region = E_convexity + E_compactness + E_thinness + E_fragmentation`

Include:

- convexity penalty
- compactness / perimeter penalty
- width vs line-spacing penalty
- line-fragmentation penalty
- inter-segment-gap penalty
- overflight-transit penalty

Important design point:

- perimeter / circumference belongs here **and** partly in `E_cut`
- `E_cut` penalizes internal boundaries
- compactness penalizes ugly outer shape

That separation is clean and avoids double-counting confusion.

### 4. Mission Term

Keep the existing mission-time model:

- flight-line length
- turn count
- per-region overhead
- inter-region transition

This remains the tradeoff counterweight to over-segmentation.

## Solver Strategy

### Short-Term Goal

Do not replace the backend with a brand-new solver immediately.

Instead:

1. keep the current terrain atoms
2. keep the current multi-region assignment loop
3. make each assignment / swap decision include the local cut cost
4. keep region-level scoring and hierarchy construction on top

This yields a clean intermediate formulation:

- still iterative and practical
- but now boundary-aware

### Medium-Term Goal

If the local edge-cost integration works well, the same formulation can later be upgraded to:

- alpha-expansion / alpha-beta swap style optimization
- or a real graph-cut style subproblem for fixed region bearings

That future path stays open if needed.

## Concrete Implementation Plan

### Phase 1. Refactor Partition Energy Components

Files:

- `src/utils/terrainPartitionObjective.ts`
- `src/utils/terrainPartitionGraph.ts`

Work:

- formalize the partition energy into explicit terms:
  - node fit
  - cut edge
  - region shape
  - mission time
- stop burying all practicality inside one scalar `shapePenalty`
- expose edge-local energy helpers so assignment code can evaluate:
  - the cost of keeping neighbors together
  - the cost of separating them

Deliverable:

- one clear internal API for partition energy accounting

### Phase 2. Add Explicit Edge-Cut Cost To Atom Assignment

Files:

- `src/utils/terrainPartitionGraph.ts`

Work:

- add `computeAdjacencyCutCost(edge, atomARegion, atomBRegion, ...)`
- integrate it into:
  - initial assignment refinement
  - boundary swap / local improvement steps
  - disconnected-fragment repair decisions

Rules:

- shared boundary length increases cut cost
- low break strength increases cut cost
- low local bearing discontinuity increases cut cost
- high break strength and meaningful orientation change reduce cut cost

Expected impact:

- fewer unnecessary cuts
- fewer tiny peel-off regions
- more cuts aligned with real terrain breaks

### Phase 3. Make Perimeter / Circumference A First-Class Term

Files:

- `src/utils/terrainPartitionObjective.ts`
- `src/utils/terrainPartitionGraph.ts`

Work:

- split the current compactness logic into:
  - outer perimeter / compactness
  - internal cut-boundary length
- make total internal boundary length an explicit partition cost
- keep region compactness as a separate outer-shape regularizer

Why:

- the user’s “penalize circumference” intuition is correct
- but it needs to be separated into:
  - boundary creation cost
  - region shape cost

Expected impact:

- fewer ragged, long-boundary segmentations
- coarser first splits become more natural

### Phase 4. Strengthen Non-Convex Operational Cost

Files:

- `src/utils/terrainPartitionObjective.ts`
- `src/utils/terrainPartitionGraph.ts`

Work:

- keep the new penalties already added for:
  - fragmented lines
  - inter-segment gaps
  - overflight transit
- move their role from “extra regularization” toward “true operational cost”
- explicitly treat a region as expensive when:
  - many scan lines produce multiple disjoint in-region fragments
  - the region requires long off-region bridge travel between fragments

Expected impact:

- dumbbell shapes become bad *during optimization*
- not only after the fact

### Phase 5. Tune Steepness / Confidence Weighting

Files:

- `src/utils/terrainPartitionObjective.ts`
- `src/utils/terrainPartitionGraph.ts`

Work:

- use steepness / confidence primarily to scale node fit importance
- optionally use it secondarily to modulate cut cost
- do **not** let steepness alone create cuts; it should only strengthen evidence where aspect guidance is meaningful

Recommended default:

- steep terrain increases node-fit weight more than edge-cut discount

Reason:

- a steep but smooth face should still resist unnecessary cuts

### Phase 6. Rebalance Coarse-To-Fine Hierarchy

Files:

- `src/utils/terrainPartitionGraph.ts`

Work:

- after the energy is boundary-aware, revisit hierarchy generation
- ensure the first practical split is:
  - balanced enough
  - compact enough
  - boundary-economical enough
- preserve manual `2-region` option when it exists
- avoid showing a “practical” coarse solution that is only a giant parent plus crumbs

Expected impact:

- better `Auto split`
- better default `Plan options` choice

## Proposed Internal APIs

### Edge-Level

- `computeAtomPairSmoothness(edge, atomA, atomB): number`
- `computeCutEdgeCost(edge, leftRegionState, rightRegionState): number`
- `computeBoundaryCreationCost(regionAssignments): number`

### Region-Level

- `computeRegionShapePenalty(region): number`
- `computeRegionOperationalPenalty(regionObjective): number`

### Partition-Level

- `evaluatePartitionEnergy(...)`
- `evaluateAssignmentDelta(...)`

The point is to make the energy decomposition explicit and debuggable.

## Validation Plan

### Regression Cases

Use:

- `example/singleArea.flightplan`
- `example/handCraftedMultiArea.flightplan`
- the current failing live mountain polygons
- the existing two-face synthetic case
- the existing gradual-transition synthetic case

### New Assertions

Add tests that verify:

- the optimizer prefers not cutting smooth same-face terrain when break strength is low
- the optimizer prefers cutting along strong terrain breaks when node-fit gain is meaningful
- dumbbell-like regions are scored worse than a cleaner split with similar bearing fit
- the first practical split does not create tiny edge crumbs unless the quality gain is substantial

### Live Acceptance Criteria

On difficult lidar mountains:

- `Auto split` should reduce large low-density hole bands more often than today
- repeated splits should create compact useful chunks, not bridge-shaped regions
- `Plan options` should preserve a meaningful `2-region` option when available

## Design Rules

1. Boundary cost must act during assignment, not only after partition construction.
2. Compactness and perimeter should remain explicit, but secondary to boundary-aware assignment.
3. Overflight between disconnected line fragments is a real operational cost and belongs in the objective.
4. Strong terrain breaks should lower cut cost, not force cuts by themselves.
5. The formulation should stay compatible with a future true graph-cut / alpha-expansion solver.

## Recommended Next Implementation Step

Start with **Phase 1 + Phase 2**:

- refactor the current partition energy into explicit node / cut / region / mission parts
- integrate cut-edge cost directly into atom assignment and swap decisions

That is the cleanest way to import the old graph-cut insight into the current backend without rewriting the whole optimizer at once.
