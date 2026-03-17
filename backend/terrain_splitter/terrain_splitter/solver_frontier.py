from __future__ import annotations

import logging
import math
import time
from collections import defaultdict, deque
from dataclasses import dataclass, replace

import numpy as np
from shapely.geometry import Polygon

from .costs import RegionObjective, RegionStaticInputs, evaluate_region_objective
from .features import CellFeatures, FeatureField
from .geometry import (
    axial_angle_delta_deg,
    clamp,
    hash_signature,
    normalize_axial_bearing,
    polygon_compactness,
    polygon_convexity,
    polygon_to_lnglat_ring,
    weighted_axial_mean_deg,
    weighted_mean,
    weighted_quantile,
)
from .grid import GridCell, GridData
from .postprocess import region_polygon_from_cells
from .schemas import FlightParamsModel, PartitionSolutionPreviewModel, RegionPreview


MAX_REGIONS = 8
MAX_SPLIT_OPTIONS = 6
MAX_FRONTIER_STATES = 14
MIN_CHILD_AREA_FRACTION = 0.14
COARSE_NON_LARGEST_FRACTION_MIN = 0.22
INTER_REGION_TRANSITION_SEC = 35.0
REGION_COUNT_PENALTY = 0.012
DOMINANCE_EPS = 1e-6
DEFAULT_DEPTH_SMALL = 3
DEFAULT_DEPTH_LARGE = 2
SPLIT_QUANTILES = (0.20, 0.25, 0.33, 0.40, 0.50, 0.60, 0.67, 0.75, 0.80)
logger = logging.getLogger("uvicorn.error")


@dataclass(slots=True)
class BoundaryStats:
    shared_boundary_m: float
    break_weight_sum: float


@dataclass(slots=True)
class EvaluatedRegion:
    cell_ids: tuple[int, ...]
    polygon: Polygon
    ring: list[tuple[float, float]]
    objective: RegionObjective
    score: float
    hard_invalid: bool


@dataclass(slots=True)
class RegionStatic:
    cell_ids: tuple[int, ...]
    polygon: Polygon
    ring: list[tuple[float, float]]
    cells: tuple[GridCell, ...]
    area_m2: float
    convexity: float
    compactness: float
    static_inputs: RegionStaticInputs


@dataclass(slots=True)
class RegionBearingCore:
    objective: RegionObjective
    score: float


@dataclass(slots=True)
class SplitCandidate:
    left_ids: tuple[int, ...]
    right_ids: tuple[int, ...]
    boundary: BoundaryStats
    rank_score: float


@dataclass(slots=True)
class PartitionPlan:
    regions: tuple[EvaluatedRegion, ...]
    quality_cost: float
    mission_time_sec: float
    weighted_mean_mismatch_deg: float
    internal_boundary_m: float
    break_weight_sum: float
    largest_region_fraction: float
    mean_convexity: float
    region_count: int


def _feature_lookup(feature_field: FeatureField) -> dict[int, CellFeatures]:
    return {cell.index: cell for cell in feature_field.cells}


def _cell_lookup(grid: GridData) -> dict[int, GridCell]:
    return {cell.index: cell for cell in grid.cells}


def _neighbor_lookup(grid: GridData) -> dict[int, list[int]]:
    neighbors: dict[int, list[int]] = defaultdict(list)
    for edge in grid.edges:
        neighbors[edge.a].append(edge.b)
        neighbors[edge.b].append(edge.a)
    return neighbors


def _weighted_circular_mean_deg(values: list[tuple[float, float]]) -> float | None:
    sum_sin = 0.0
    sum_cos = 0.0
    total = 0.0
    for angle_deg, weight in values:
        if not math.isfinite(angle_deg) or weight <= 0:
            continue
        rad = math.radians(angle_deg % 360.0)
        sum_sin += math.sin(rad) * weight
        sum_cos += math.cos(rad) * weight
        total += weight
    if total <= 0:
        return None
    return (math.degrees(math.atan2(sum_sin, sum_cos)) + 360.0) % 360.0


def _region_signature(region: EvaluatedRegion) -> tuple[tuple[int, ...], int]:
    return region.cell_ids, int(round(region.objective.bearing_deg * 1000.0))


def _plan_signature(plan: PartitionPlan) -> tuple[tuple[tuple[int, ...], int], ...]:
    return tuple(sorted((_region_signature(region) for region in plan.regions), key=lambda item: (len(item[0]), item[1])))


def _boundary_alignment(boundary: BoundaryStats) -> float:
    if boundary.shared_boundary_m <= 0:
        return 0.0
    return boundary.break_weight_sum / boundary.shared_boundary_m


def _bearing_cache_key(bearing_deg: float) -> int:
    return int(round(normalize_axial_bearing(bearing_deg) * 1000.0))


def _region_score(objective: RegionObjective) -> float:
    compactness_penalty = max(0.0, objective.compactness - 3.4) * 0.06
    convexity_penalty = max(0.0, 0.75 - objective.convexity) * 0.35
    fragmentation_penalty = 0.18 * objective.fragmented_line_fraction + 0.28 * objective.overflight_transit_fraction
    short_line_penalty = 0.12 * objective.short_line_fraction
    time_penalty = objective.total_mission_time_sec / 55_000.0
    return (
        objective.normalized_quality_cost
        + compactness_penalty
        + convexity_penalty
        + fragmentation_penalty
        + short_line_penalty
        + time_penalty
    )


def _capture_efficiency(objective: RegionObjective) -> float:
    return clamp(
        1.0
        - 0.65 * objective.fragmented_line_fraction
        - 0.85 * objective.overflight_transit_fraction
        - 0.45 * objective.short_line_fraction,
        0.0,
        1.0,
    )


def _region_basic_validity(
    region: EvaluatedRegion,
    parent_area_m2: float,
) -> bool:
    fraction = region.objective.area_m2 / max(1.0, parent_area_m2)
    min_line_length = max(
        8.0,
        0.35 * max(1.0, region.objective.along_track_length_m, region.objective.cross_track_width_m),
    )
    return (
        not region.hard_invalid
        and fraction >= MIN_CHILD_AREA_FRACTION
        and region.objective.flight_line_count >= 1
        and region.objective.mean_line_length_m >= min_line_length
        and region.objective.convexity >= 0.56
        and region.objective.compactness <= 8.5
        and _capture_efficiency(region.objective) >= 0.12
    )


def _region_practical(
    region: EvaluatedRegion,
    root_area_m2: float,
) -> bool:
    fraction = region.objective.area_m2 / max(1.0, root_area_m2)
    min_line_length = max(
        10.0,
        0.45 * max(1.0, region.objective.along_track_length_m, region.objective.cross_track_width_m),
    )
    return (
        not region.hard_invalid
        and fraction >= MIN_CHILD_AREA_FRACTION
        and region.objective.flight_line_count >= 1
        and region.objective.mean_line_length_m >= min_line_length
        and region.objective.convexity >= 0.64
        and region.objective.compactness <= 6.25
        and region.objective.overflight_transit_fraction <= 0.55
        and _capture_efficiency(region.objective) >= 0.22
    )


def _plan_boundary_alignment(plan: PartitionPlan) -> float:
    if plan.internal_boundary_m <= 0:
        return 0.0
    return plan.break_weight_sum / plan.internal_boundary_m


def _plan_is_practical(plan: PartitionPlan, root_area_m2: float) -> bool:
    if plan.region_count <= 1:
        return False
    fractions = sorted((region.objective.area_m2 / max(1.0, root_area_m2) for region in plan.regions), reverse=True)
    if not fractions:
        return False
    if 1.0 - fractions[0] < COARSE_NON_LARGEST_FRACTION_MIN:
        return False
    if fractions[-1] < MIN_CHILD_AREA_FRACTION:
        return False
    if plan.mean_convexity < 0.65:
        return False
    if not all(_region_practical(region, root_area_m2) for region in plan.regions):
        return False
    if plan.region_count == 2 and plan.largest_region_fraction > 0.88:
        return False
    return True


def _dominates(
    a: PartitionPlan,
    b: PartitionPlan,
    root_area_m2: float,
    status_cache: dict[tuple[tuple[tuple[int, ...], int], ...], int],
) -> bool:
    status_a = status_cache.get(_plan_signature(a))
    if status_a is None:
        status_a = 2 if a.region_count <= 1 else (1 if _plan_is_practical(a, root_area_m2) else 0)
        status_cache[_plan_signature(a)] = status_a
    status_b = status_cache.get(_plan_signature(b))
    if status_b is None:
        status_b = 2 if b.region_count <= 1 else (1 if _plan_is_practical(b, root_area_m2) else 0)
        status_cache[_plan_signature(b)] = status_b

    # Keep "don't split" baselines as first-class options for parent composition.
    if status_a == 2 or status_b == 2:
        return False

    # Non-practical plans are useful for search, but they should not suppress
    # practical plans from the frontier because they can never be returned.
    if status_a == 0 and status_b == 1:
        return False

    better_or_equal = (
        a.quality_cost <= b.quality_cost + DOMINANCE_EPS
        and a.mission_time_sec <= b.mission_time_sec + DOMINANCE_EPS
    )
    strictly_better = (
        a.quality_cost < b.quality_cost - DOMINANCE_EPS
        or a.mission_time_sec < b.mission_time_sec - DOMINANCE_EPS
    )
    return better_or_equal and strictly_better


def _thin_frontier(plans: list[PartitionPlan], root_area_m2: float) -> list[PartitionPlan]:
    baseline_bucket: list[PartitionPlan] = []
    practical_buckets: dict[int, list[PartitionPlan]] = defaultdict(list)
    non_practical_buckets: dict[int, list[PartitionPlan]] = defaultdict(list)
    for plan in plans:
        if plan.region_count <= 1:
            baseline_bucket.append(plan)
        elif _plan_is_practical(plan, root_area_m2):
            practical_buckets[plan.region_count].append(plan)
        else:
            non_practical_buckets[plan.region_count].append(plan)

    retained: list[PartitionPlan] = []
    if baseline_bucket:
        baseline_bucket.sort(key=lambda plan: (plan.mission_time_sec, plan.quality_cost))
        retained.extend(baseline_bucket[:1])

    for region_count, bucket in practical_buckets.items():
        bucket.sort(key=lambda plan: (plan.quality_cost, plan.mission_time_sec))
        retained.extend(bucket[:4])

    remaining = max(0, MAX_FRONTIER_STATES - len(retained))
    if remaining > 0:
        for region_count, bucket in non_practical_buckets.items():
            bucket.sort(key=lambda plan: (plan.quality_cost, plan.mission_time_sec))
            retained.extend(bucket[: min(2, remaining)])
            remaining = max(0, MAX_FRONTIER_STATES - len(retained))
            if remaining <= 0:
                break

    retained.sort(key=lambda plan: (plan.region_count, plan.mission_time_sec, plan.quality_cost))
    return retained[:MAX_FRONTIER_STATES]


def _pareto_frontier(plans: list[PartitionPlan], root_area_m2: float) -> list[PartitionPlan]:
    unique: dict[tuple[tuple[tuple[int, ...], int], ...], PartitionPlan] = {}
    for plan in plans:
        signature = _plan_signature(plan)
        existing = unique.get(signature)
        if existing is None or plan.quality_cost < existing.quality_cost - DOMINANCE_EPS:
            unique[signature] = plan
    status_cache: dict[tuple[tuple[tuple[int, ...], int], ...], int] = {}
    nondominated: list[PartitionPlan] = []
    for plan in sorted(unique.values(), key=lambda item: (item.mission_time_sec, item.quality_cost, item.region_count)):
        if any(_dominates(existing, plan, root_area_m2, status_cache) for existing in nondominated):
            continue
        nondominated = [
            existing
            for existing in nondominated
            if not _dominates(plan, existing, root_area_m2, status_cache)
        ]
        nondominated.append(plan)
    return _thin_frontier(nondominated, root_area_m2)


def _principal_axis_bearing(cell_ids: tuple[int, ...], cell_lookup: dict[int, GridCell]) -> float | None:
    if len(cell_ids) < 2:
        return None
    weights = np.asarray([max(1e-6, cell_lookup[cell_id].area_m2) for cell_id in cell_ids], dtype=np.float64)
    points = np.asarray([[cell_lookup[cell_id].x, cell_lookup[cell_id].y] for cell_id in cell_ids], dtype=np.float64)
    centroid = np.average(points, axis=0, weights=weights)
    centered = points - centroid
    covariance = np.cov(centered.T, aweights=weights)
    eigenvalues, eigenvectors = np.linalg.eigh(covariance)
    axis = eigenvectors[:, int(np.argmax(eigenvalues))]
    bearing_deg = math.degrees(math.atan2(axis[0], axis[1]))
    return normalize_axial_bearing(bearing_deg)


def _region_heading_candidates(
    cell_ids: tuple[int, ...],
    feature_lookup: dict[int, CellFeatures],
    cell_lookup: dict[int, GridCell],
    feature_field: FeatureField,
) -> list[float]:
    weighted_bearings: list[tuple[float, float]] = []
    weighted_aspects: list[tuple[float, float]] = []
    histogram_bins = [0.0] * 12
    for cell_id in cell_ids:
        feature = feature_lookup.get(cell_id)
        cell = cell_lookup.get(cell_id)
        if feature is None or cell is None:
            continue
        weight = max(1e-6, cell.area_m2 * (0.2 + 0.8 * feature.confidence))
        weighted_bearings.append((feature.preferred_bearing_deg, weight))
        weighted_aspects.append((feature.aspect_deg, weight))
        idx = int(normalize_axial_bearing(feature.preferred_bearing_deg) // 15.0) % len(histogram_bins)
        histogram_bins[idx] += weight

    candidates: list[float] = []

    def add(angle_deg: float | None) -> None:
        if angle_deg is None or not math.isfinite(angle_deg):
            return
        normalized = normalize_axial_bearing(angle_deg)
        if any(axial_angle_delta_deg(normalized, existing) < 9.0 for existing in candidates):
            return
        candidates.append(normalized)

    add(weighted_axial_mean_deg(weighted_bearings))
    mean_aspect = _weighted_circular_mean_deg(weighted_aspects)
    add(mean_aspect)
    add(None if mean_aspect is None else mean_aspect + 90.0)
    add(feature_field.dominant_preferred_bearing_deg)
    add(feature_field.dominant_aspect_deg)
    add(None if feature_field.dominant_aspect_deg is None else feature_field.dominant_aspect_deg + 90.0)
    principal_axis = _principal_axis_bearing(cell_ids, cell_lookup)
    add(principal_axis)
    add(None if principal_axis is None else principal_axis + 90.0)

    for idx, weight in sorted(enumerate(histogram_bins), key=lambda item: item[1], reverse=True):
        if weight <= 0:
            continue
        center_angle = idx * 15.0 + 7.5
        add(center_angle)
        if len(candidates) >= 8:
            break

    if not candidates:
        candidates = [feature_field.dominant_preferred_bearing_deg or 0.0]
    return candidates[:8]


def _cut_direction_candidates(
    baseline_region: EvaluatedRegion,
    cell_ids: tuple[int, ...],
    feature_lookup: dict[int, CellFeatures],
    cell_lookup: dict[int, GridCell],
    feature_field: FeatureField,
) -> list[float]:
    candidates: list[float] = []

    def add(angle_deg: float | None) -> None:
        if angle_deg is None or not math.isfinite(angle_deg):
            return
        normalized = normalize_axial_bearing(angle_deg)
        if any(axial_angle_delta_deg(normalized, existing) < 8.0 for existing in candidates):
            return
        candidates.append(normalized)

    add(baseline_region.objective.bearing_deg + 90.0)
    add(baseline_region.objective.bearing_deg)
    for bearing in _region_heading_candidates(cell_ids, feature_lookup, cell_lookup, feature_field):
        add(bearing)
        add(bearing + 90.0)

    principal_axis = _principal_axis_bearing(cell_ids, cell_lookup)
    add(principal_axis)
    add(None if principal_axis is None else principal_axis + 90.0)

    for fallback in (0.0, 30.0, 45.0, 60.0, 90.0, 120.0, 135.0, 150.0):
        add(fallback)
    return candidates[:10]


def _boundary_stats_for_split(
    left_ids: set[int],
    right_ids: set[int],
    grid: GridData,
    feature_lookup: dict[int, CellFeatures],
) -> BoundaryStats:
    shared_boundary_m = 0.0
    break_weight_sum = 0.0
    for edge in grid.edges:
        if (edge.a in left_ids and edge.b in right_ids) or (edge.a in right_ids and edge.b in left_ids):
            shared_boundary_m += edge.shared_boundary_m
            feature_a = feature_lookup.get(edge.a)
            feature_b = feature_lookup.get(edge.b)
            if feature_a is None or feature_b is None:
                continue
            aspect_delta = abs(((feature_a.aspect_deg - feature_b.aspect_deg + 180.0) % 360.0) - 180.0)
            bearing_delta = axial_angle_delta_deg(feature_a.preferred_bearing_deg, feature_b.preferred_bearing_deg)
            break_strength = 0.5 * (feature_a.break_strength + feature_b.break_strength)
            break_weight_sum += edge.shared_boundary_m * (
                0.55 * break_strength
                + 0.30 * aspect_delta
                + 0.15 * bearing_delta
            )
    return BoundaryStats(shared_boundary_m=shared_boundary_m, break_weight_sum=break_weight_sum)


def _connected_components_for_subset(
    cell_ids: tuple[int, ...],
    neighbors: dict[int, list[int]],
) -> list[list[int]]:
    remaining = set(cell_ids)
    components: list[list[int]] = []
    while remaining:
        seed = next(iter(remaining))
        queue = deque([seed])
        remaining.remove(seed)
        component: list[int] = []
        while queue:
            current = queue.popleft()
            component.append(current)
            for neighbor in neighbors.get(current, []):
                if neighbor not in remaining:
                    continue
                remaining.remove(neighbor)
                queue.append(neighbor)
        components.append(sorted(component))
    return components


def _build_region_polygon(
    cell_ids: tuple[int, ...],
    grid: GridData,
    neighbors: dict[int, list[int]],
    polygon_cache: dict[tuple[int, ...], Polygon | None],
) -> Polygon | None:
    cached = polygon_cache.get(cell_ids)
    if cached is not None or cell_ids in polygon_cache:
        return cached
    if not cell_ids:
        polygon_cache[cell_ids] = None
        return None
    components = _connected_components_for_subset(cell_ids, neighbors)
    if len(components) != 1:
        polygon_cache[cell_ids] = None
        return None
    try:
        polygon = region_polygon_from_cells(grid, list(cell_ids))
    except Exception:  # noqa: BLE001
        polygon_cache[cell_ids] = None
        return None
    if polygon.is_empty or not polygon.is_valid:
        polygon = polygon.buffer(0)
    if polygon.is_empty:
        polygon_cache[cell_ids] = None
        return None
    polygon_cache[cell_ids] = polygon
    return polygon


def _build_region(
    cell_ids: tuple[int, ...],
    boundary_alignment: float,
    grid: GridData,
    neighbors: dict[int, list[int]],
    feature_lookup: dict[int, CellFeatures],
    cell_lookup: dict[int, GridCell],
    feature_field: FeatureField,
    params: FlightParamsModel,
    best_bearing_cache: dict[tuple[int, ...], float],
    region_cache: dict[tuple[int, ...], EvaluatedRegion | None],
    region_static_cache: dict[tuple[int, ...], RegionStatic | None],
    region_bearing_core_cache: dict[tuple[tuple[int, ...], int], RegionBearingCore],
    heading_candidates_cache: dict[tuple[int, ...], list[float]],
    polygon_cache: dict[tuple[int, ...], Polygon | None],
    perf: dict[str, float],
) -> EvaluatedRegion | None:
    cached_region = region_cache.get(cell_ids)
    if cached_region is not None or cell_ids in region_cache:
        perf["region_cache_hits"] += 1
        if cached_region is None:
            return None
        if abs(cached_region.objective.boundary_break_alignment - boundary_alignment) <= 1e-9:
            return cached_region
        return replace(
            cached_region,
            objective=replace(cached_region.objective, boundary_break_alignment=boundary_alignment),
        )

    perf["region_cache_misses"] += 1
    perf["build_region_calls"] += 1
    build_started_at = time.perf_counter()
    static_region = region_static_cache.get(cell_ids)
    if static_region is not None or cell_ids in region_static_cache:
        perf["region_static_hits"] += 1
        if static_region is None:
            perf["region_static_null_hits"] += 1
            perf["build_region_ms"] += (time.perf_counter() - build_started_at) * 1000.0
            region_cache[cell_ids] = None
            return None
    else:
        perf["region_static_misses"] += 1
        static_started_at = time.perf_counter()
        polygon_started_at = time.perf_counter()
        polygon = _build_region_polygon(cell_ids, grid, neighbors, polygon_cache)
        perf["build_region_polygon_ms"] += (time.perf_counter() - polygon_started_at) * 1000.0
        if polygon is None:
            perf["build_region_polygon_failures"] += 1
            perf["region_static_build_ms"] += (time.perf_counter() - static_started_at) * 1000.0
            perf["build_region_ms"] += (time.perf_counter() - build_started_at) * 1000.0
            region_static_cache[cell_ids] = None
            region_cache[cell_ids] = None
            return None
        static_region = RegionStatic(
            cell_ids=cell_ids,
            polygon=polygon,
            ring=polygon_to_lnglat_ring(polygon),
            cells=tuple(cell_lookup[cell_id] for cell_id in cell_ids),
            area_m2=float(polygon.area),
            convexity=polygon_convexity(polygon),
            compactness=polygon_compactness(polygon),
            static_inputs=RegionStaticInputs(
                x=np.asarray([cell_lookup[cell_id].x for cell_id in cell_ids], dtype=np.float64),
                y=np.asarray([cell_lookup[cell_id].y for cell_id in cell_ids], dtype=np.float64),
                area_m2=np.asarray([max(1e-6, cell_lookup[cell_id].area_m2) for cell_id in cell_ids], dtype=np.float64),
                terrain_z=np.asarray([cell_lookup[cell_id].terrain_z for cell_id in cell_ids], dtype=np.float64),
                preferred_bearing_deg=np.asarray(
                    [feature_lookup[cell_id].preferred_bearing_deg for cell_id in cell_ids],
                    dtype=np.float64,
                ),
                confidence=np.asarray([feature_lookup[cell_id].confidence for cell_id in cell_ids], dtype=np.float64),
                slope_magnitude=np.asarray([feature_lookup[cell_id].slope_magnitude for cell_id in cell_ids], dtype=np.float64),
                grid_step_m=grid.grid_step_m,
            ),
        )
        region_static_cache[cell_ids] = static_region
        perf["region_static_build_ms"] += (time.perf_counter() - static_started_at) * 1000.0
    if static_region is None:
        perf["build_region_ms"] += (time.perf_counter() - build_started_at) * 1000.0
        region_cache[cell_ids] = None
        return None
    polygon = static_region.polygon
    ring = static_region.ring
    cells = static_region.cells
    candidate_bearings = heading_candidates_cache.get(cell_ids)
    if candidate_bearings is None:
        candidate_bearings = _region_heading_candidates(cell_ids, feature_lookup, cell_lookup, feature_field)
        heading_candidates_cache[cell_ids] = candidate_bearings
    if cell_ids in best_bearing_cache:
        cached = best_bearing_cache[cell_ids]
        candidate_bearings = [cached] + [bearing for bearing in candidate_bearings if axial_angle_delta_deg(bearing, cached) > 1e-6]

    best_objective: RegionObjective | None = None
    best_score = float("inf")
    for bearing_deg in candidate_bearings:
        bearing_key = (cell_ids, _bearing_cache_key(bearing_deg))
        cached_core = region_bearing_core_cache.get(bearing_key)
        if cached_core is not None:
            perf["region_bearing_hits"] += 1
            if abs(boundary_alignment) > 1e-9:
                perf["region_bearing_rewraps"] += 1
                objective = replace(cached_core.objective, boundary_break_alignment=boundary_alignment)
            else:
                objective = cached_core.objective
            score = cached_core.score
        else:
            perf["region_bearing_misses"] += 1
            perf["objective_calls"] += 1
            objective_started_at = time.perf_counter()
            objective = evaluate_region_objective(
                cells,
                feature_lookup,
                bearing_deg,
                params,
                polygon,
                0.0,
                perf=perf,
                precomputed_area_m2=static_region.area_m2,
                precomputed_convexity=static_region.convexity,
                precomputed_compactness=static_region.compactness,
                precomputed_static_inputs=static_region.static_inputs,
            )
            objective_elapsed_ms = (time.perf_counter() - objective_started_at) * 1000.0
            perf["objective_ms"] += objective_elapsed_ms
            perf["region_bearing_core_ms"] += objective_elapsed_ms
            score = _region_score(objective)
            region_bearing_core_cache[bearing_key] = RegionBearingCore(objective=objective, score=score)
            if abs(boundary_alignment) > 1e-9:
                perf["region_bearing_rewraps"] += 1
                objective = replace(objective, boundary_break_alignment=boundary_alignment)
        if score < best_score:
            best_score = score
            best_objective = objective

    if best_objective is None:
        perf["build_region_ms"] += (time.perf_counter() - build_started_at) * 1000.0
        region_cache[cell_ids] = None
        return None
    best_bearing_cache[cell_ids] = best_objective.bearing_deg
    region = EvaluatedRegion(
        cell_ids=cell_ids,
        polygon=polygon,
        ring=ring,
        objective=best_objective,
        score=best_score,
        hard_invalid=False,
    )
    perf["build_region_ms"] += (time.perf_counter() - build_started_at) * 1000.0
    region_cache[cell_ids] = region
    return region


def _plan_from_regions(
    regions: tuple[EvaluatedRegion, ...],
    internal_boundary_m: float,
    break_weight_sum: float,
) -> PartitionPlan:
    total_area = sum(region.objective.area_m2 for region in regions)
    quality_terms = []
    mismatch_terms = []
    convexity_terms = []
    for region in regions:
        weight = max(1e-6, region.objective.area_m2)
        shape_penalty = (
            0.22 * max(0.0, 0.74 - region.objective.convexity)
            + 0.05 * max(0.0, region.objective.compactness - 3.0)
            + 0.22 * region.objective.fragmented_line_fraction
            + 0.28 * region.objective.overflight_transit_fraction
            + 0.02 * region.objective.short_line_fraction
        )
        quality_terms.append((region.objective.normalized_quality_cost + shape_penalty, weight))
        mismatch_terms.append((region.objective.weighted_mean_mismatch_deg, weight))
        convexity_terms.append((region.objective.convexity, weight))

    mission_time_sec = sum(region.objective.total_mission_time_sec for region in regions)
    if len(regions) > 1:
        mission_time_sec += INTER_REGION_TRANSITION_SEC * (len(regions) - 1)

    return PartitionPlan(
        regions=tuple(sorted(regions, key=lambda region: region.objective.area_m2, reverse=True)),
        quality_cost=weighted_mean(quality_terms) + REGION_COUNT_PENALTY * max(0, len(regions) - 1),
        mission_time_sec=mission_time_sec,
        weighted_mean_mismatch_deg=weighted_mean(mismatch_terms),
        internal_boundary_m=internal_boundary_m,
        break_weight_sum=break_weight_sum,
        largest_region_fraction=max((region.objective.area_m2 / max(1.0, total_area) for region in regions), default=1.0),
        mean_convexity=weighted_mean(convexity_terms),
        region_count=len(regions),
    )


def _combine_plans(left: PartitionPlan, right: PartitionPlan, boundary: BoundaryStats) -> PartitionPlan:
    return _plan_from_regions(
        left.regions + right.regions,
        internal_boundary_m=left.internal_boundary_m + right.internal_boundary_m + boundary.shared_boundary_m,
        break_weight_sum=left.break_weight_sum + right.break_weight_sum + boundary.break_weight_sum,
    )


def _projection_values(
    cell_ids: tuple[int, ...],
    cell_lookup: dict[int, GridCell],
    direction_deg: float,
) -> list[tuple[int, float, float]]:
    rad = math.radians(direction_deg)
    ux = math.sin(rad)
    uy = math.cos(rad)
    return [
        (
            cell_id,
            cell_lookup[cell_id].x * ux + cell_lookup[cell_id].y * uy,
            max(1e-6, cell_lookup[cell_id].area_m2),
        )
        for cell_id in cell_ids
    ]


def _split_cell_ids_by_projection_values(
    projected: list[tuple[int, float, float]],
    quantile: float,
) -> tuple[tuple[int, ...], tuple[int, ...]] | None:
    if len(projected) < 4:
        return None
    min_projection = min(value for _, value, _ in projected)
    max_projection = max(value for _, value, _ in projected)
    if max_projection - min_projection < 1e-6:
        return None
    threshold = weighted_quantile(((value, weight) for _, value, weight in projected), quantile)
    left = tuple(sorted(cell_id for cell_id, value, _ in projected if value <= threshold))
    right = tuple(sorted(cell_id for cell_id, value, _ in projected if value > threshold))
    if not left or not right:
        return None
    return left, right


def _generate_split_candidates(
    baseline_region: EvaluatedRegion,
    baseline_plan: PartitionPlan,
    cell_ids: tuple[int, ...],
    root_area_m2: float,
    grid: GridData,
    feature_lookup: dict[int, CellFeatures],
    cell_lookup: dict[int, GridCell],
    feature_field: FeatureField,
    params: FlightParamsModel,
    neighbors: dict[int, list[int]],
    best_bearing_cache: dict[tuple[int, ...], float],
    region_cache: dict[tuple[int, ...], EvaluatedRegion | None],
    region_static_cache: dict[tuple[int, ...], RegionStatic | None],
    region_bearing_core_cache: dict[tuple[tuple[int, ...], int], RegionBearingCore],
    heading_candidates_cache: dict[tuple[int, ...], list[float]],
    polygon_cache: dict[tuple[int, ...], Polygon | None],
    perf: dict[str, float],
) -> list[SplitCandidate]:
    parent_area = max(1.0, baseline_region.objective.area_m2)
    seen: set[tuple[tuple[int, ...], tuple[int, ...]]] = set()
    candidates: list[SplitCandidate] = []
    directions = _cut_direction_candidates(baseline_region, cell_ids, feature_lookup, cell_lookup, feature_field)
    perf["split_direction_count"] += len(directions)
    for direction_deg in directions:
        projected = _projection_values(cell_ids, cell_lookup, direction_deg)
        for quantile in SPLIT_QUANTILES:
            perf["split_attempts"] += 1
            split = _split_cell_ids_by_projection_values(projected, quantile)
            if split is None:
                perf["split_projection_failures"] += 1
                continue
            left_ids, right_ids = split
            left_area = sum(cell_lookup[cell_id].area_m2 for cell_id in left_ids)
            right_area = sum(cell_lookup[cell_id].area_m2 for cell_id in right_ids)
            left_fraction = left_area / parent_area
            right_fraction = right_area / parent_area
            if min(left_fraction, right_fraction) < MIN_CHILD_AREA_FRACTION:
                perf["split_small_child_rejections"] += 1
                continue
            signature = (left_ids, right_ids) if left_ids < right_ids else (right_ids, left_ids)
            if signature in seen:
                perf["split_duplicate_rejections"] += 1
                continue
            seen.add(signature)

            if len(_connected_components_for_subset(left_ids, neighbors)) != 1:
                perf["split_disconnected_rejections"] += 1
                continue
            if len(_connected_components_for_subset(right_ids, neighbors)) != 1:
                perf["split_disconnected_rejections"] += 1
                continue

            boundary = _boundary_stats_for_split(set(left_ids), set(right_ids), grid, feature_lookup)
            if boundary.shared_boundary_m <= grid.grid_step_m * 0.8:
                perf["split_boundary_rejections"] += 1
                continue
            boundary_alignment = _boundary_alignment(boundary)
            left_region = _build_region(
                left_ids,
                boundary_alignment,
                grid,
                neighbors,
                feature_lookup,
                cell_lookup,
                feature_field,
                params,
                best_bearing_cache,
                region_cache,
                region_static_cache,
                region_bearing_core_cache,
                heading_candidates_cache,
                polygon_cache,
                perf,
            )
            right_region = _build_region(
                right_ids,
                boundary_alignment,
                grid,
                neighbors,
                feature_lookup,
                cell_lookup,
                feature_field,
                params,
                best_bearing_cache,
                region_cache,
                region_static_cache,
                region_bearing_core_cache,
                heading_candidates_cache,
                polygon_cache,
                perf,
            )
            if left_region is None or right_region is None:
                perf["split_region_build_rejections"] += 1
                continue
            if not _region_basic_validity(left_region, parent_area) or not _region_basic_validity(right_region, parent_area):
                perf["split_basic_validity_rejections"] += 1
                continue
            immediate_plan = _plan_from_regions((left_region, right_region), boundary.shared_boundary_m, boundary.break_weight_sum)
            quality_gain = baseline_plan.quality_cost - immediate_plan.quality_cost
            time_delta = immediate_plan.mission_time_sec - baseline_plan.mission_time_sec
            rank_score = quality_gain - max(0.0, time_delta) / 7_500.0 + boundary_alignment / 28.0 - abs(left_fraction - right_fraction) * 0.2
            if quality_gain <= 0.0 and rank_score <= 0.05:
                perf["split_non_improving_rejections"] += 1
                continue
            candidates.append(
                SplitCandidate(
                    left_ids=left_ids,
                    right_ids=right_ids,
                    boundary=boundary,
                    rank_score=rank_score,
                )
            )
            perf["split_candidates_kept"] += 1
    candidates.sort(key=lambda candidate: candidate.rank_score, reverse=True)
    perf["split_candidates_returned"] += min(len(candidates), MAX_SPLIT_OPTIONS)
    return candidates[:MAX_SPLIT_OPTIONS]


def solve_partition_hierarchy(
    grid: GridData,
    feature_field: FeatureField,
    params: FlightParamsModel,
    requested_tradeoff: float | None = None,
    *,
    request_id: str | None = None,
    polygon_id: str | None = None,
) -> list[PartitionSolutionPreviewModel]:
    solve_started_at = time.perf_counter()
    if not grid.cells:
        return []

    feature_lookup = _feature_lookup(feature_field)
    cell_lookup = _cell_lookup(grid)
    neighbors = _neighbor_lookup(grid)
    perf: defaultdict[str, float] = defaultdict(float)
    best_bearing_cache: dict[tuple[int, ...], float] = {}
    region_cache: dict[tuple[int, ...], EvaluatedRegion | None] = {}
    region_static_cache: dict[tuple[int, ...], RegionStatic | None] = {}
    region_bearing_core_cache: dict[tuple[tuple[int, ...], int], RegionBearingCore] = {}
    heading_candidates_cache: dict[tuple[int, ...], list[float]] = {}
    polygon_cache: dict[tuple[int, ...], Polygon | None] = {}
    frontier_cache: dict[tuple[tuple[int, ...], int], list[PartitionPlan]] = {}
    root_area_m2 = max(1.0, grid.area_m2)
    max_depth = DEFAULT_DEPTH_SMALL if len(grid.cells) <= 140 else DEFAULT_DEPTH_LARGE

    def solve_region(cell_ids: tuple[int, ...], depth: int) -> list[PartitionPlan]:
        perf["solve_region_calls"] += 1
        key = (cell_ids, depth)
        cached = frontier_cache.get(key)
        if cached is not None:
            perf["solve_region_cache_hits"] += 1
            return cached

        baseline_region = _build_region(
            cell_ids,
            0.0,
            grid,
            neighbors,
            feature_lookup,
            cell_lookup,
            feature_field,
            params,
            best_bearing_cache,
            region_cache,
            region_static_cache,
            region_bearing_core_cache,
            heading_candidates_cache,
            polygon_cache,
            perf,
        )
        if baseline_region is None:
            frontier_cache[key] = []
            return []

        baseline_plan = _plan_from_regions((baseline_region,), 0.0, 0.0)
        if depth <= 0 or len(cell_ids) < 4 or baseline_region.objective.flight_line_count < 1:
            frontier_cache[key] = [baseline_plan]
            perf["baseline_leaf_plans"] += 1
            return [baseline_plan]

        candidates = [baseline_plan]
        split_gen_started_at = time.perf_counter()
        for split in _generate_split_candidates(
            baseline_region,
            baseline_plan,
            cell_ids,
            root_area_m2,
            grid,
            feature_lookup,
            cell_lookup,
            feature_field,
            params,
            neighbors,
            best_bearing_cache,
            region_cache,
            region_static_cache,
            region_bearing_core_cache,
            heading_candidates_cache,
            polygon_cache,
            perf,
        ):
            left_frontier = solve_region(split.left_ids, depth - 1) or []
            right_frontier = solve_region(split.right_ids, depth - 1) or []
            if not left_frontier or not right_frontier:
                continue
            for left_plan in left_frontier:
                for right_plan in right_frontier:
                    combined = _combine_plans(left_plan, right_plan, split.boundary)
                    if combined.region_count > MAX_REGIONS:
                        perf["combine_region_limit_rejections"] += 1
                        continue
                    candidates.append(combined)
                    perf["combined_plan_candidates"] += 1
        perf["split_generation_ms"] += (time.perf_counter() - split_gen_started_at) * 1000.0

        frontier = _pareto_frontier(candidates, root_area_m2)
        perf["frontier_plan_count"] += len(frontier)
        frontier_cache[key] = frontier
        return frontier

    root_cell_ids = tuple(sorted(cell_lookup))
    all_plans = solve_region(root_cell_ids, max_depth)
    if not all_plans:
        total_ms = (time.perf_counter() - solve_started_at) * 1000.0
        logger.info(
            "[terrain-split-backend][%s] solver finished polygonId=%s cells=%d maxDepth=%d totalMs=%.1f allPlans=0 solveRegionCalls=%d cacheHits=%d regionCacheHits=%d regionCacheMisses=%d regionStaticHits=%d regionStaticMisses=%d regionBearingHits=%d regionBearingMisses=%d buildRegionCalls=%d objectiveCalls=%d splitAttempts=%d kept=%d",
            request_id or "<none>",
            polygon_id or "<none>",
            len(grid.cells),
            max_depth,
            total_ms,
            int(perf["solve_region_calls"]),
            int(perf["solve_region_cache_hits"]),
            int(perf["region_cache_hits"]),
            int(perf["region_cache_misses"]),
            int(perf["region_static_hits"]),
            int(perf["region_static_misses"]),
            int(perf["region_bearing_hits"]),
            int(perf["region_bearing_misses"]),
            int(perf["build_region_calls"]),
            int(perf["objective_calls"]),
            int(perf["split_attempts"]),
            int(perf["split_candidates_kept"]),
        )
        return []

    baseline = min(
        (plan for plan in all_plans if plan.region_count == 1),
        key=lambda plan: (plan.quality_cost, plan.mission_time_sec),
        default=None,
    )
    practical = [plan for plan in all_plans if _plan_is_practical(plan, root_area_m2)]
    if not practical:
        total_ms = (time.perf_counter() - solve_started_at) * 1000.0
        logger.info(
            "[terrain-split-backend][%s] solver finished polygonId=%s cells=%d maxDepth=%d totalMs=%.1f allPlans=%d practicalPlans=0 solveRegionCalls=%d cacheHits=%d regionCacheHits=%d regionCacheMisses=%d regionStaticHits=%d regionStaticMisses=%d regionBearingHits=%d regionBearingMisses=%d buildRegionCalls=%d buildRegionMs=%.1f regionStaticBuildMs=%.1f polygonMs=%.1f objectiveCalls=%d objectiveMs=%.1f regionBearingCoreMs=%.1f nodeCostMs=%.1f lineLiftMs=%.1f flightTimeMs=%.1f shapeMetricMs=%.1f splitGenMs=%.1f splitAttempts=%d kept=%d returned=%d",
            request_id or "<none>",
            polygon_id or "<none>",
            len(grid.cells),
            max_depth,
            total_ms,
            len(all_plans),
            int(perf["solve_region_calls"]),
            int(perf["solve_region_cache_hits"]),
            int(perf["region_cache_hits"]),
            int(perf["region_cache_misses"]),
            int(perf["region_static_hits"]),
            int(perf["region_static_misses"]),
            int(perf["region_bearing_hits"]),
            int(perf["region_bearing_misses"]),
            int(perf["build_region_calls"]),
            perf["build_region_ms"],
            perf["region_static_build_ms"],
            perf["build_region_polygon_ms"],
            int(perf["objective_calls"]),
            perf["objective_ms"],
            perf["region_bearing_core_ms"],
            perf["node_cost_ms"],
            perf["line_lift_ms"],
            perf["flight_time_ms"],
            perf["shape_metric_ms"],
            perf["split_generation_ms"],
            int(perf["split_attempts"]),
            int(perf["split_candidates_kept"]),
            int(perf["split_candidates_returned"]),
        )
        return []

    comparison_pool = practical[:]
    if baseline is not None:
        comparison_pool.append(baseline)
    filtered = _pareto_frontier(comparison_pool, root_area_m2)
    practical_filtered = [plan for plan in filtered if plan.region_count > 1 and _plan_is_practical(plan, root_area_m2)]
    if not practical_filtered:
        return []

    best_two_region = min(
        (plan for plan in practical if plan.region_count == 2),
        key=lambda plan: (plan.quality_cost, plan.mission_time_sec),
        default=None,
    )
    if best_two_region is not None and not any(_plan_signature(plan) == _plan_signature(best_two_region) for plan in practical_filtered):
        practical_filtered.append(best_two_region)

    practical_filtered.sort(key=lambda plan: (plan.region_count, plan.mission_time_sec, plan.quality_cost))
    time_min = min(plan.mission_time_sec for plan in practical_filtered)
    time_max = max(plan.mission_time_sec for plan in practical_filtered)
    first_practical_signature = _plan_signature(practical_filtered[0]) if practical_filtered else None

    previews: list[PartitionSolutionPreviewModel] = []
    for index, plan in enumerate(practical_filtered):
        boundary_break_alignment = _plan_boundary_alignment(plan)
        if time_max - time_min <= 1e-6:
            tradeoff = requested_tradeoff if requested_tradeoff is not None else 0.5
        else:
            tradeoff = clamp((plan.mission_time_sec - time_min) / (time_max - time_min), 0.0, 1.0)
        preview = PartitionSolutionPreviewModel(
            signature=hash_signature(
                {
                    "regions": [
                        {
                            "ring": region.ring,
                            "bearingDeg": round(region.objective.bearing_deg, 4),
                            "areaM2": round(region.objective.area_m2, 3),
                        }
                        for region in plan.regions
                    ]
                }
            ),
            tradeoff=float(tradeoff),
            regionCount=plan.region_count,
            totalMissionTimeSec=plan.mission_time_sec,
            normalizedQualityCost=plan.quality_cost,
            weightedMeanMismatchDeg=plan.weighted_mean_mismatch_deg,
            hierarchyLevel=index + 1,
            largestRegionFraction=plan.largest_region_fraction,
            meanConvexity=plan.mean_convexity,
            boundaryBreakAlignment=boundary_break_alignment,
            isFirstPracticalSplit=first_practical_signature is not None and _plan_signature(plan) == first_practical_signature,
            regions=[
                RegionPreview(
                    areaM2=region.objective.area_m2,
                    bearingDeg=region.objective.bearing_deg,
                    atomCount=len(region.cell_ids),
                    ring=region.ring,
                    convexity=region.objective.convexity,
                    compactness=region.objective.compactness,
                    baseAltitudeAGL=params.altitudeAGL,
                )
                for region in plan.regions
            ],
        )
        previews.append(preview)
    total_ms = (time.perf_counter() - solve_started_at) * 1000.0
    region_cache_attempts = perf["region_cache_hits"] + perf["region_cache_misses"]
    region_static_attempts = perf["region_static_hits"] + perf["region_static_misses"]
    region_bearing_attempts = perf["region_bearing_hits"] + perf["region_bearing_misses"]
    logger.info(
        "[terrain-split-backend][%s] solver finished polygonId=%s cells=%d maxDepth=%d totalMs=%.1f allPlans=%d practicalPlans=%d returnedSolutions=%d solveRegionCalls=%d cacheHits=%d regionCacheHits=%d regionCacheMisses=%d regionCacheHitRate=%.3f regionStaticHits=%d regionStaticMisses=%d regionStaticHitRate=%.3f regionStaticNullHits=%d regionBearingHits=%d regionBearingMisses=%d regionBearingHitRate=%.3f regionBearingRewraps=%d buildRegionCalls=%d buildRegionMs=%.1f regionStaticBuildMs=%.1f polygonMs=%.1f polygonFailures=%d objectiveCalls=%d objectiveMs=%.1f regionBearingCoreMs=%.1f nodeCostMs=%.1f lineLiftMs=%.1f flightTimeMs=%.1f shapeMetricMs=%.1f splitGenMs=%.1f splitDirections=%d splitAttempts=%d kept=%d returned=%d smallChildRejects=%d duplicateRejects=%d disconnectedRejects=%d boundaryRejects=%d regionBuildRejects=%d validityRejects=%d nonImprovingRejects=%d combinedCandidates=%d frontierStates=%d",
        request_id or "<none>",
        polygon_id or "<none>",
        len(grid.cells),
        max_depth,
        total_ms,
        len(all_plans),
        len(practical),
        len(previews),
        int(perf["solve_region_calls"]),
        int(perf["solve_region_cache_hits"]),
        int(perf["region_cache_hits"]),
        int(perf["region_cache_misses"]),
        (perf["region_cache_hits"] / region_cache_attempts) if region_cache_attempts > 0 else 0.0,
        int(perf["region_static_hits"]),
        int(perf["region_static_misses"]),
        (perf["region_static_hits"] / region_static_attempts) if region_static_attempts > 0 else 0.0,
        int(perf["region_static_null_hits"]),
        int(perf["region_bearing_hits"]),
        int(perf["region_bearing_misses"]),
        (perf["region_bearing_hits"] / region_bearing_attempts) if region_bearing_attempts > 0 else 0.0,
        int(perf["region_bearing_rewraps"]),
        int(perf["build_region_calls"]),
        perf["build_region_ms"],
        perf["region_static_build_ms"],
        perf["build_region_polygon_ms"],
        int(perf["build_region_polygon_failures"]),
        int(perf["objective_calls"]),
        perf["objective_ms"],
        perf["region_bearing_core_ms"],
        perf["node_cost_ms"],
        perf["line_lift_ms"],
        perf["flight_time_ms"],
        perf["shape_metric_ms"],
        perf["split_generation_ms"],
        int(perf["split_direction_count"]),
        int(perf["split_attempts"]),
        int(perf["split_candidates_kept"]),
        int(perf["split_candidates_returned"]),
        int(perf["split_small_child_rejections"]),
        int(perf["split_duplicate_rejections"]),
        int(perf["split_disconnected_rejections"]),
        int(perf["split_boundary_rejections"]),
        int(perf["split_region_build_rejections"]),
        int(perf["split_basic_validity_rejections"]),
        int(perf["split_non_improving_rejections"]),
        int(perf["combined_plan_candidates"]),
        int(perf["frontier_plan_count"]),
    )
    return previews
