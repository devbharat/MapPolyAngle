# Sensor-Aware Node Cost Plan

## Goal

Replace the current generic terrain-only node cost in the partition optimizer with a **sensor-aware node cost**.

Today the node cost in the atom assignment loop mostly captures:

- terrain-bearing fit
- spatial compactness
- mild balance preference

That is not enough for lidar or camera planning.

The desired formulation is:

`E_total = E_node(sensor-aware) + E_cut + E_region + E_mission`

Where:

- `E_node` depends on the payload
- `E_cut` penalizes creating boundaries
- `E_region` penalizes bad region geometry and disconnected flight-line behavior
- `E_mission` accounts for turns, line length, and area-to-area overhead

The key principle is:

- **holes must be worse than low density**
- **low density must be worse than good density**
- this must affect optimization during segmentation, not only the later preview reranker

## Current Gap

The optimizer currently assigns atoms using:

- aspect/bearing mismatch
- distance to region centroid
- a local cut-edge penalty

That means the assignment step does not know:

- lidar max-range holes
- no-return areas
- weak-density bands
- camera weak-overlap or high-GSD zones

Those signals appear only later in:

- region-level surrogates
- exact partition preview reranking

So the optimizer can still build the wrong partition structure, then only discover afterward that it gives bad sensing quality.

## Design Principle

The node cost should be the **cheap local approximation of sensing quality** for assigning one terrain atom to one region orientation.

That means:

- it should be much cheaper than running the full worker for every assignment move
- but it should use the same semantics as the exact preview
- so the exact worker is refining the same objective, not a different one

## Proposed Formulation

For atom `i`, region `r`, orientation `theta_r`:

`E_node(i, r) = E_sensor(i, theta_r) + E_compact(i, r)`

Where:

- `E_sensor` is payload-specific sensing loss
- `E_compact` is the current small spatial term that keeps regions coherent

The cut cost remains separate:

- `E_cut(i, j, z_i, z_j)`

## Lidar Node Cost

### Desired semantics

For lidar, the node cost should approximate:

- good coverage: low cost
- low-density coverage: moderate cost
- hole / no-return coverage: high cost

It should specifically reflect:

- whether the region orientation keeps the atom inside effective swath coverage
- whether local terrain relief and cross-track geometry push the beam beyond usable range
- whether coverage is strong enough near the low quantiles, not just on average

### Proposed surrogate quantities per atom/orientation

For each atom `i` and candidate bearing `theta`, estimate:

- `meanDensityFactor(i, theta)`
- `lowDensityFactor(i, theta)` or `q10Factor(i, theta)`
- `holeRisk(i, theta)`
- `rangeViolationRisk(i, theta)` if distinguishable from hole risk

These should come from a lightweight geometric surrogate derived from:

- atom guidance cells
- terrain relief / slope inside the atom
- cross-track slope relative to the candidate bearing
- lidar altitude, speed, FOV, return mode, and max range

### Node loss for lidar

Recommended atom-level surrogate:

`E_node_lidar(i, theta) =`

- `a1 * meanDensityDeficit`
- `+ a2 * q10DensityDeficit`
- `+ a3 * holeRisk`
- `+ a4 * rangeViolationRisk`
- `+ a5 * residualBearingMismatch`

Where:

- `meanDensityDeficit = max(0, 1 - meanDensityFactor)`
- `q10DensityDeficit = max(0, 1 - q10Factor)`
- `holeRisk` should be weighted more strongly than the other terms

Recommended relative importance:

- hole / no-return risk: highest
- low-tail density: second
- mean density: third
- pure aspect mismatch: weakest, only as a prior

This matches the exact reranker logic already in the panel.

## Camera Node Cost

### Desired semantics

For camera, the node cost should approximate:

- GSD degradation
- weak-overlap / underlap risk
- tail risk from the worst parts of the atom

### Proposed surrogate quantities per atom/orientation

For each atom `i` and bearing `theta`, estimate:

- `meanGsdFactor(i, theta)`
- `p90GsdFactor(i, theta)`
- `underlapRisk(i, theta)`

### Node loss for camera

Recommended atom-level surrogate:

`E_node_camera(i, theta) =`

- `b1 * meanExcessGsd`
- `+ b2 * p90ExcessGsd`
- `+ b3 * underlapRisk`
- `+ b4 * residualBearingMismatch`

Again:

- the sensing metric should dominate
- aspect mismatch is only a proxy prior

## Where The Signal Comes From

### Stage 1: cheap precomputed atom-orientation table

For each atom and each candidate bearing, precompute a cheap local sensor score.

This table becomes the node energy lookup used by the assignment loop.

Candidate bearings already exist in the partition backend.

So the new structure should be something like:

- `Map<atomId, Map<bearingBucket, SensorNodeCost>>`

This keeps assignment fast:

- assignment only looks up a precomputed cost
- it does not rerun heavy terrain sampling for every local move

### Stage 2: exact preview remains as refinement

Keep the current exact worker-backed preview and lidar reranking.

Its role becomes:

- validate/rerank a small number of candidate partitions
- provide the user-visible quality estimate

Not:

- compensate for the optimizer using the wrong objective

## Lidar Surrogate Design

### Important requirement

This must not just be “bearing mismatch dressed up.”

It needs to include a simple estimate of whether the atom is geometrically coverable at the chosen bearing.

### Recommended approximation

For each guidance cell in an atom:

1. estimate cross-track direction relative to the candidate bearing
2. estimate local terrain tilt / relief in that cross-track direction
3. estimate whether the local swath can cover the cell within max range
4. estimate how much the local geometry weakens density

Aggregate over the atom with area/confidence weights.

This does not need the full worker:

- it only needs a fast local geometry approximation
- and it should be calibrated to point in the same direction as the exact worker

### Suggested output fields

- `meanDensityFactor`
- `q10DensityFactor`
- `holeRisk`
- `rangeRisk`
- `bearingPriorLoss`

## Camera Surrogate Design

For each guidance cell in an atom:

1. estimate local terrain direction mismatch relative to candidate bearing
2. estimate local relief-induced image spacing / GSD degradation
3. estimate overlap risk

Aggregate to:

- `meanGsdFactor`
- `p90GsdFactor`
- `underlapRisk`
- `bearingPriorLoss`

## Integration Into Current Backend

Files:

- `src/utils/terrainPartitionObjective.ts`
- `src/utils/terrainPartitionGraph.ts`

### New internal data types

Add something like:

- `SensorNodeCost`
- `AtomBearingCostTable`

For example:

- `sensorKind`
- `bearingDeg`
- `qualityCost`
- `holeRisk`
- `lowCoverageRisk`
- `bearingPriorLoss`

### New helper flow

1. build candidate bearing set
2. precompute atom-bearing node cost table
3. during assignment:
   - look up `E_sensor(atom, regionBearing)`
   - add compactness term
   - add local cut-edge term
4. keep region-level and mission-level scoring on top

### Region state dependency

Because region bearing changes as assignments change:

- map each region bearing to the nearest candidate-bearing bucket
- use that bucket for fast lookup

This is a practical compromise that keeps the search cheap.

## Exact Worker Relationship

The exact worker should remain the highest-fidelity estimator.

But the optimizer should now be using a **compatible low-fidelity version of the same semantics**.

That means:

- if exact preview says holes are terrible
- the node cost should already think holes are terrible

The exact preview should refine, not reverse, the search result.

## Validation Plan

### Unit tests

Add tests showing:

- lidar node cost penalizes a clear no-return / hole scenario more than merely weak density
- camera node cost penalizes bad overlap / high-GSD tail more than mild mismatch
- changing max lidar range increases node cost for affected atoms

### Graph tests

Extend partition graph tests so:

- a lidar polygon with large hole bands prefers splits that reduce hole-heavy atoms
- a camera polygon with a two-face terrain still prefers a meaningful split

### Browser acceptance

On live lidar mountains:

- `Auto split` should begin targeting partitions that reduce hole bands, not just improve aspect fit
- repeated splits should create useful chunks where the exact density preview improves the uncovered zones

## Sequenced Implementation

### Phase 1

- add atom-bearing cost table types
- implement cheap lidar surrogate node metrics
- replace the current generic node cost with lookup-based lidar node cost when payload is lidar

### Phase 2

- add camera node metrics
- unify camera/lidar node-cost API

### Phase 3

- retune exact preview reranking weights so they complement the new node cost instead of compensating for missing semantics

## Design Rules

1. The node cost must be sensor-aware.
2. Holes must be more expensive than low density.
3. Low density must be more expensive than good density.
4. Exact preview should refine the same semantics the optimizer already uses.
5. The lookup must stay cheap enough for interactive partition search.

## Recommended Next Step

Implement **Phase 1** for lidar first.

That is the highest value path because:

- lidar currently suffers most from the optimizer not seeing holes
- the exact reranker already gives us the target semantics to approximate
- once lidar node cost is correct, the same pattern can be extended to camera cleanly
