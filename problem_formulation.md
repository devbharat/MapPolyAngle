prompt: i need your help to formulate a flight planning optimization problem formally such that it can be implemented in code. The problem addresses the Wingtra fixed wing drone flight planning issues in mountainous areas. The user wants to map an area with a downward looking camera or a lidar sensor on the drone with a specific GSD or point density on the whole area of the map. The drone though has restrictions on how it can fly, which causes the actual on ground GSD/point density to vary quite a lot around the ideal desired value. The user therefore has to learn to create the flight plan in a certain way that allows them to collect best possible data they can given the restrictions of the drone flight behaviour. What we want to do is automate this so that the user does not have to do this painful manual process himself all the time. Now ill give you some more details about the flight restrictions of the drone. When a user draws a area (area is basically a mostly convex polygon, slight non convexities are allowed) that he wants to map with a certain GSD/point density for a given camera/lidar. the area is a container for a sequence of steady level flight lines (lawn mower pattern) all having the same flight direction (heading, +/- 180) and same 'base altitude above ground'(using the camera model/lidar model and the desired GSD or point density assuming flat ground). But the ground is not flat obviously, so each flight line is allowed to have a different height above ground (the drone climbs or descends at the end of flight lines when turning it loiters up or down). For safety, each flight line is always finding the max height of the ground under it(samples the terrain on the line segment) and lifting the whole flight line by the value of the 'base height' for the area above the heighest point under it(this is a constraint for now that we cant chnage). This means a small sharp peak can cause the whole flight line to have a poorer GSD or point density. The other issue ism because all the flight lines in an area have the same heading and dont climb/descend, if the flight direction is not matching the average contour line direction for the area below it, the whole flight plan becomes very suboptimal very quickly (the drone flies straight while the ground curves away from under it effectively increasing the height above ground a lot). So we generally tell the users to manually break the big polygon representing the area they want to map into smaller polygons, each roughly matching the face of mountains, and set the flight direction along the contour lines (sort of live median aspect plus 90 degrees). this tackles most of the first order effects we care about. Something also to consider is that having many small areas vs one big area has a direct effect on the drone coverage per set of batteries. this is because turns are inefficient and consume more battery than steady level flights, and data is only captured in steady level flights. also more areas means having to fly from one area to another which is also not capturing any useful data and draining batteries. so the rule of thumb becomes that if you care about flight time and not much the quality of data stay with a single or few polygons, or instead if you really care about the quality of data and not flight time, then break the whole area into many small polygons such that each individual polygon can be mapped with good GSD/point density and the union of all areas covers the full original area (having some intersection between neighbouring areas is not bad, and sometimes a whole small area inside a bigger area is also good, but not too many tiny specks of areas as drone needs time to stabilize after turns). So this is how it works right now. What we need to do is formulate this into an optimization problem such that given an initial polygon and the terrain raster under it (say from mapbox), the optimization runs and outputs a serise of solutions along the spectrum of fast but ok quality --> slow but high quality where each solution is a set of polygons and a flight direction and base height for each polygon. Ive tried a lot of small hacky solutions that work sometimes but not sometimes, so thats why i am asking your help, i am sure there is a theoretically well thoughtout way to formulate this problem (i think the best way i got so far was a multi label graph cut where node cost was ground aspect - avg region aspect and edge cost was fixed, causing regions of similar aspects to cluster, but it was not always good). Id like you to give this your best shot. 

## In Progress Status

This section records how much of the formulation below is already implemented in the repo and what is still missing.

### Implemented now

- A separate local Python/FastAPI backend exists in [backend/terrain_splitter](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter).
- The frontend can call the backend via `VITE_TERRAIN_PARTITION_BACKEND_URL`, and falls back to the current in-browser solver if the backend is unavailable.
- The backend already uses a regular XY grid clipped to the polygon, rather than the old frontend atom graph:
  - [backend/terrain_splitter/terrain_splitter/grid.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/grid.py)
  - [backend/terrain_splitter/terrain_splitter/features.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/features.py)
- There is a backend region-level frontier solver that:
  - builds atomic terrain patches
  - merges them into a tree
  - evaluates region candidates at multiple bearings
  - returns a coarse-to-fine frontier of solutions
  - [backend/terrain_splitter/terrain_splitter/solver_frontier.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/solver_frontier.py)
- Region scoring already includes several pieces from the intended formulation:
  - sensor-aware quality terms
  - mission-time estimate
  - line-lift surrogate
  - convexity / compactness / fragmentation style regularization
  - [backend/terrain_splitter/terrain_splitter/costs.py](/Users/bharat/Documents/src/MapPolyAngle/backend/terrain_splitter/terrain_splitter/costs.py)
- When backend partitions are applied, child polygons now preserve the solver-selected `bearingDeg` and `baseAltitudeAGL` instead of reverting to local defaults:
  - [src/components/MapFlightDirection/index.tsx](/Users/bharat/Documents/src/MapPolyAngle/src/components/MapFlightDirection/index.tsx)
  - [src/components/MapFlightDirection/api.ts](/Users/bharat/Documents/src/MapPolyAngle/src/components/MapFlightDirection/api.ts)

### Partially implemented

- “Use terrain segmentation only to generate plausible regions; optimize at region level”:
  - implemented in spirit
  - but currently through a hierarchical frontier solver, not the full candidate-library master optimization described below
- Multi-objective quality/time tradeoff:
  - implemented as an alpha-swept frontier
  - not yet as an explicit epsilon-constraint budget sweep
- Line-lift:
  - implemented at region evaluation level
  - not yet as a full exact mission-simulator term inside candidate generation / assignment
- Tiny patch suppression and practical region filtering:
  - partially implemented with regularization penalties and practical split filters
  - not yet with a formal capture-efficiency constraint
- Debugging support:
  - basic backend JSON debug artifacts exist
  - not yet full raster/map debug outputs like line-lift maps or hole-risk maps

### Still pending

- The biggest missing piece is the **candidate-library + master optimizer** architecture proposed below.
- The backend does **not** yet:
  - build a general library of connected candidate regions with coverage masks and per-cell penalties
  - solve a set-cover / facility-location / MIP-style master problem
  - support overlapping selected regions as first-class optimization variables
  - support inner refinement patches chosen by the master optimizer
  - solve an explicit epsilon-constraint frontier of “minimize quality subject to cost budget”
  - optimize inter-region ordering as a GTSP/TSP-style subproblem
  - search a ladder of base heights around the nominal user target
  - use a fully explicit safety-inflated terrain model `z_safe = z + uncertainty + obstacle buffer`
  - run the local repair loop suggested below to add small local patches around the worst stripes / holes and re-solve

### Current interpretation

The backend architecture is now in place, but the currently implemented solver is still best understood as a **productionizable intermediate step**, not the final optimizer described below.

The most important remaining jump is:

- from a hierarchical region frontier solver
- to a candidate-region library plus budgeted master optimization

That is still the long-term target of this document.

### Logged bad example: token split from backend frontier

The current backend can still return a mathematically nondominated but operationally useless split. This is a concrete example that should be treated as a regression target.

#### Input

- Date captured: `2026-03-16`
- Source: live backend request from `POST /v1/partition/solve`
- Polygon id: `yGlMbJtnLBWvs2hnhNywtgQOcBpWQgNU`
- Payload kind: `lidar`
- Params:
  - `altitudeAGL = 100`
  - `sideOverlap = 70`
  - `speedMps = 16`
  - `lidarKey = WINGTRA_LIDAR_XT32M2X`
  - `lidarReturnMode = single`
  - `mappingFovDeg = 90`
  - `maxLidarRangeM = 200`
- Global settings:
  - `altitudeMode = legacy`
  - `minClearanceM = 60`
  - `turnExtendM = 96`
- Ring:

```json
[
  [8.485806284297212, 47.34161877987708],
  [8.494185594159859, 47.34721678954364],
  [8.508433777050897, 47.35091469788799],
  [8.514978693364924, 47.335092968319714],
  [8.504497803233193, 47.32382508106792],
  [8.493887972429633, 47.32161979799437],
  [8.491031388651152, 47.332763245233195],
  [8.485806284297212, 47.34161877987708]
]
```

#### Current backend output

The backend returned exactly one solution:

- `regionCount = 2`
- `tradeoff = 0.0`
- `totalMissionTimeSec = 10849.06`
- `normalizedQualityCost = 5.0729`
- `largestRegionFraction = 0.9987`
- `meanConvexity = 0.9677`
- `boundaryBreakAlignment = 44.69`
- `isFirstPracticalSplit = false`

Region areas:

- Region 1: `9,685,287 m²`
- Region 2: `12,800 m²`

This is a token split: one enormous region plus one tiny crumb.

#### Why this is a failure

This output should **not** be considered a meaningful Pareto-front solution under the intended formulation.

- It is dominated by the implicit unsplit baseline in operational usefulness, even if the current split-only frontier code cannot represent that.
- It violates the spirit of the minimum-useful-region / capture-efficiency requirement.
- It provides no meaningful coarse partition for the user.
- The frontend `Auto split` path still applied it because it was the only returned backend option, even though `isFirstPracticalSplit = false`.

#### What this example proves

This example is a concrete demonstration that the current backend frontier solver is still solving the wrong relaxed problem:

- it compares split solutions only, instead of comparing against the `1-region` baseline or “no useful split”
- it allows tiny regions to survive as frontier points
- it labels practicality after optimization, rather than enforcing it as part of the optimization

Any future backend formulation should reject this output class entirely.

Solution: The right model here is **not** a plain graph cut. It is a **multi-objective connected set-cover / set-partition problem with region-level costs**.

Why I’m saying that so strongly: Wingtra’s terrain-following rule is explicitly sweep-based. For each sweep, the altitude is set by the **highest terrain point on that sweep**, and altitude is **not adjusted along the same flight line**. Wingtra’s own guidance therefore says to fly **parallel to contour lines** and to **split the area into subareas** when contour orientation changes; for LiDAR they make the same point in the “perpendicular to the slope” wording. Wingtra also ties GSD directly to flight height, connects multiple areas directly from the last sweep of one to the first sweep of the next, and warns that elevation data can be uncertain and miss vegetation/buildings. Fixed-wing CPP literature separately shows that both **turn count** and **turn-path length** matter, and that sweep direction is coupled to strip width and turning-radius constraints. ([Wingtra Knowledge Base][1])

That immediately breaks a standard Potts-style graph cut: your true cost is **nonlocal**. One sharp peak changes the altitude of a whole sweep, which changes quality over many distant cells. A unary “aspect mismatch” plus a constant boundary penalty cannot represent that coupling. Your graph-cut idea is still useful, but as a **candidate generator / oversegmentation step**, not as the master optimizer.

## 1) Formal problem

Let

* (\Omega \subset \mathbb{R}^2): the user’s polygon, in a local ENU frame
* (z(x)): terrain height from DEM/DSM
* (z^{\text{safe}}(x)=z(x)+\Delta_{\text{safety}}(x)): safety-inflated terrain
* payload/sensor model (S): camera or lidar
* target quality (q^\star): desired GSD or desired point density
* feasible headings (\theta \in [0,\pi))
* feasible base heights (h \in H)

A solution is a set of mission regions
[
\mathcal{M}={m_k=(R_k,\theta_k,h_k)}_{k=1}^K
]
where each (R_k\subseteq \Omega) is a connected polygon, (\bigcup_k R_k \supseteq \Omega), and overlaps are allowed.

### Region flight model

For a region (m=(R,\theta,h)), let (d_\theta=(\cos\theta,\sin\theta)) be the line direction and (n_\theta=(-\sin\theta,\cos\theta)) the cross-track direction. Let the line spacing be (s(h)), from the sensor model and overlap settings.

For each flight line (j) in region (R), define the line segment (\ell_j(R,\theta,h)). The flown absolute altitude on that line is

[
A_j(R,\theta,h)=h+\max_{x\in \ell_j(R,\theta,h)} z^{\text{safe}}(x).
]

That is the Wingtra terrain-following rule in math form. ([Wingtra Knowledge Base][1])

If cell (i) is covered by line (j(i)), its actual AGL is

[
\delta_{im}=A_{j(i)}(R,\theta,h)-z(x_i).
]

### Quality model

For a **camera** mission, let (g(\delta)) be the GSD at AGL (\delta). A natural penalty is

[
p^{\text{cam}}_{im}
===================

\left[\max!\left(0,\frac{g(\delta_{im})}{g^\star}-1\right)\right]^r.
]

For a **LiDAR** mission, let (\rho(\delta)) be the predicted ground point density at AGL (\delta). A natural penalty is

[
p^{\text{lid}}_{im}
===================

\left[\max!\left(0,\frac{\rho^\star}{\rho(\delta_{im})}-1\right)\right]^r.
]

Use (r=1) or (2).
This gives zero penalty when quality is at least as good as target, and positive penalty only when it is worse.

A robust plan should not optimize only the mean penalty. Use a tail-aware metric, for example

[
Q(\mathcal{M})
==============

\sum_i w_i,p_i
+
\lambda_{\text{tail}},\mathrm{CVaR}_{\alpha}(p_i),
]

where (p_i) is the final penalty at cell (i), (w_i) is cell area, and (\alpha) might be (0.9) or (0.95).

That matters because the user cares about bad degraded stripes, not just average performance.

### Resource / efficiency model

For each region (m), define

[
c_m
===

T^{\text{capture}}_m
+
T^{\text{turn}}_m
+
T^{\text{climb}}_m
+
T^{\text{entry/exit}}_m.
]

If you already have a mission simulator that reproduces Wingtra behavior, use that as the source of truth for (c_m). If not, approximate:

[
T^{\text{capture}}*m \approx \frac{\sum_j |\ell_j|}{v*{\text{line}}},
]

[
T^{\text{turn}}*m \approx \sum*{j=1}^{N_m-1} \tau_{\text{turn}}(s(h),R_{\min},|A_{j+1}-A_j|),
]

with fixed-wing
[
R_{\min}=\frac{v_{\min}^2}{g\tan\phi_{\max}}.
]

That fixed-wing dependence on turning radius, strip width, and turn-path length is exactly what the fixed-wing CPP papers emphasize. ([MDPI][2])

Define region capture efficiency

[
\eta_m = \frac{T^{\text{capture}}_m}{c_m}.
]

Reject candidates with (\eta_m<\eta_{\min}). That is a clean way to kill tiny “speck” regions.

For multiple regions, total resource is

[
C(\mathcal{M},\pi)=\sum_{m\in\mathcal{M}} c_m + C^{\text{inter}}(\mathcal{M},\pi),
]

where (\pi) is the order of visiting regions. Wingtra explicitly flies between areas directly from the last sweep of one area to the first sweep of the next, with height based on the higher endpoint, so inter-region transitions are real cost and should be accounted for. ([Wingtra Knowledge Base][3])

### Multi-objective problem

The clean formulation is

[
\min_{\mathcal{M},\pi} \quad \big(C(\mathcal{M},\pi),; Q(\mathcal{M}),; K(\mathcal{M})\big)
]

where (K(\mathcal{M})) is a complexity term such as number of regions.

In practice, generate the frontier using the **(\varepsilon)-constraint method**:

[
\min_{\mathcal{M},\pi} Q(\mathcal{M})
\quad
\text{s.t. }
C(\mathcal{M},\pi)\le B,;
\eta_m\ge \eta_{\min}\ \forall m.
]

Sweep (B) over a range of budgets. This is better than a weighted sum here because the feasible set is discrete and nonconvex.

## 2) The implementable formulation

The raw continuous problem is too hard. The production version should be a **candidate mission library + MIP**.

### Step A: generate candidate regions

Use your graph-cut / segmentation instinct here, but only to produce **atomic patches**.

I would compute a smoothed contour-direction field

[
\tau(x)=\text{aspect}(x)+\frac{\pi}{2},
]

and encode it as ((\cos 2\tau,\sin 2\tau)) so that (\theta) and (\theta+\pi) are treated as identical. Weight it by slope magnitude (|\nabla z|), because heading barely matters on flat ground.

Then build atomic patches by oversegmenting the DEM using features like:

* ((\cos 2\tau,\sin 2\tau))
* slope magnitude
* curvature / ridge-valley cues

with a minimum physical size tied to stabilization and minimum useful line length.

From those atomic patches, build a candidate library of connected unions:

[
\mathcal{C}={(R,\theta,h)}.
]

For each candidate, precompute:

* coverage mask (a_{ic}\in{0,1})
* per-cell quality penalty (p_{ic})
* cost (c_c)
* efficiency (\eta_c)

Keep only candidates that are safe and efficient.

This is where your existing aspect-based graph cut helps: it creates sensible atoms. It should not decide the final partition.

## 3) Master optimization: camera and lidar variants

### Camera variant

For camera, multiple overlapping candidate regions are allowed, but a cell is effectively “credited” to the selected region that gives it the best GSD. Use binary variables:

* (x_c\in{0,1}): choose candidate (c)
* (z_{ic}\in{0,1}): cell (i) is assigned to candidate (c)

Solve

[
\min \sum_{c} c_c x_c
;+;
\lambda_Q \sum_i w_i \sum_c p_{ic} z_{ic}
;+;
\lambda_K \sum_c x_c
]

subject to

[
\sum_{c:,a_{ic}=1} z_{ic} = 1 \qquad \forall i,
]

[
z_{ic} \le x_c \qquad \forall i,c,
]

[
x_c,z_{ic}\in{0,1}.
]

For the Pareto front, replace the first term in the objective by a budget:

[
\sum_c c_c x_c \le B.
]

This is a set-cover / facility-location style model with overlap allowed.

### LiDAR variant

For LiDAR, if you want overlapping patches to **add** point density, use

[
\min \sum_c c_c x_c + \lambda_Q \sum_i w_i \xi_i + \lambda_K \sum_c x_c
]

subject to

[
\sum_c \rho_{ic} x_c + \xi_i \ge \rho^\star \qquad \forall i,
]

[
\xi_i \ge 0,\qquad x_c\in{0,1}.
]

That is even cleaner than the camera case.

## 4) Why this matches the manual heuristic

On a locally planar mountain face, write the terrain in coordinates aligned with heading as

[
z(u,v)=a u + b v + c,
]

where (u) is along flight direction.

Along one sweep, the altitude penalty is driven by the variation of (z) along (u), i.e. by (a). The mean excess AGL on that sweep is proportional to (|a|), and

[
a = \nabla z \cdot d_\theta.
]

So minimizing sweep-induced quality loss means minimizing (|\nabla z \cdot d_\theta|), i.e. choosing (d_\theta) **orthogonal to the gradient**. That is exactly “fly along the contour lines.”

Your heuristic “median aspect + 90°” falls directly out of the physics. The optimizer just adds the missing terms: turn cost, region-switch cost, minimum useful region size, and optional overlap patches.

## 5) Why the previous graph cut was unstable

A standard multi-label graph cut assumes a cost of the form

[
\sum_i D_i(\ell_i) + \sum_{(i,j)} \beta_{ij},[\ell_i\neq \ell_j].
]

Your real cost is not of that form, because

[
A_j = h + \max_{x\in \ell_j\cap R} z(x)
]

couples many distant cells on the same sweep through a **max** operator.

That means:

1. a single sharp peak changes the cost of many cells far away,
2. region size matters through turn count and turn-path length,
3. overlap patches can be beneficial,
4. a constant edge penalty is wrong because some cuts barely affect flight time, while others create major turn and transit penalties.

So the failure mode was structural, not just tuning.

## 6) Practical solver architecture

The first version I would actually build is:

1. Convert to local ENU and inflate the DEM for safety:
   [
   z^{\text{safe}} = z + \text{DEM uncertainty} + \text{obstacle buffer}.
   ]
   Wingtra notes that elevation data can be uncertain and may not include vegetation/buildings, so this inflation is not optional in mountain work. ([Wingtra Knowledge Base][1])

2. Fix (H={h^\star}) first, where (h^\star) is the nominal base height from the user’s target GSD/density. Only after that works, add a small ladder of heights around (h^\star) to widen the frontier. Wingtra explicitly links GSD and flight height. ([Wingtra Knowledge Base][3])

3. Generate atomic topographic patches from smoothed contour direction.

4. Build a candidate merge tree of connected unions.

5. For each candidate and each heading on a 5° grid, evaluate cost and quality using the same line generator / turn simulator used by your planner.

6. Solve the (\varepsilon)-constraint MIP for a sequence of budgets (B_1<\dots<B_L).

7. Post-process each selected solution with an exact inter-region ordering step. If sequencing matters a lot, solve a small GTSP/TSP over selected region entry/exit states.

8. Add a repair loop: from a coarse solution, detect the worst stripes, generate local inner patches there, and re-solve. That is how you get the “small area inside a bigger area” behavior without exploding the candidate count.

## 7) One very concrete way to code it

```text
build_atomic_patches(dem, polygon):
    smooth dem at scale ~ line spacing
    compute contour direction tau = aspect + 90 deg
    oversegment into connected patches with min useful size
    return patches

build_candidates(patches, headings, heights):
    generate connected unions from merge tree
    for each (region, heading, height):
        sim = simulate_region(region, heading, height)
        if sim.safe and sim.efficiency >= eta_min:
            store candidate cost, coverage mask, per-cell penalty
    return candidates

solve_frontier(candidates, budgets):
    for B in budgets:
        solve MIP:
            minimize total_quality_penalty
            subject to total_cost <= B
                      every cell covered/assigned
        store nondominated solution
```

## 8) The key design choice

The key design choice is this:

* **Use terrain segmentation only to generate plausible regions.**
* **Use a mission-level optimizer to choose which regions, headings, and heights survive.**

That separation is what makes the formulation both principled and implementable.

The cleanest production path is the candidate-library + (\varepsilon)-constraint MIP. It directly represents the Wingtra sweep rule, supports overlaps and inner refinement patches, and produces the exact spectrum you asked for: **fast but acceptable** (\rightarrow) **slower but high quality**.

[1]: https://knowledge.wingtra.com/en/terrain-following "https://knowledge.wingtra.com/en/terrain-following"
[2]: https://www.mdpi.com/2226-4310/9/9/521 "https://www.mdpi.com/2226-4310/9/9/521"
[3]: https://knowledge.wingtra.com/en/create-a-new-flight-plan "https://knowledge.wingtra.com/en/create-a-new-flight-plan"
