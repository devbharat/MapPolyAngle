from __future__ import annotations

import json
import logging
import math
import os
import time
from collections import defaultdict, deque
from dataclasses import dataclass, replace
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from typing import Any, Literal

import numpy as np
from shapely.geometry import Polygon
from shapely.wkt import loads as load_wkt

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
from .grid import GridCell, GridData, GridEdge
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


@dataclass(slots=True)
class SolverContext:
    grid: GridData
    feature_field: FeatureField
    params: FlightParamsModel
    root_area_m2: float
    feature_lookup: dict[int, CellFeatures]
    cell_lookup: dict[int, GridCell]
    neighbors: dict[int, list[int]]


@dataclass(slots=True)
class SolverCaches:
    best_bearing_cache: dict[tuple[int, ...], float]
    region_cache: dict[tuple[int, ...], EvaluatedRegion | None]
    region_static_cache: dict[tuple[int, ...], RegionStatic | None]
    region_bearing_core_cache: dict[tuple[tuple[int, ...], int], RegionBearingCore]
    heading_candidates_cache: dict[tuple[int, ...], list[float]]
    polygon_cache: dict[tuple[int, ...], Polygon | None]
    frontier_cache: dict[tuple[tuple[int, ...], int], list[PartitionPlan]]


@dataclass(slots=True)
class RootSplitTask:
    left_ids: tuple[int, ...]
    right_ids: tuple[int, ...]
    boundary: BoundaryStats
    depth: int


@dataclass(slots=True)
class SubtreeSolveTask:
    cell_ids: tuple[int, ...]
    depth: int


_PARALLEL_SOLVER_CONTEXT: SolverContext | None = None


def _make_solver_caches() -> SolverCaches:
    return SolverCaches(
        best_bearing_cache={},
        region_cache={},
        region_static_cache={},
        region_bearing_core_cache={},
        heading_candidates_cache={},
        polygon_cache={},
        frontier_cache={},
    )


def _make_perf() -> defaultdict[str, float]:
    return defaultdict(float)


def _merge_perf(target: dict[str, float], source: dict[str, float]) -> None:
    for key, value in source.items():
        target[key] += value


def _resolve_root_parallel_workers(requested: int | None) -> int:
    if requested is not None:
        return max(0, int(requested))
    raw = os.environ.get("TERRAIN_SPLITTER_ROOT_PARALLEL_WORKERS")
    if raw is None or raw.strip() == "":
        return 0
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning(
            "[terrain-split-backend] invalid TERRAIN_SPLITTER_ROOT_PARALLEL_WORKERS=%r; falling back to serial",
            raw,
        )
        return 0


def _resolve_root_parallel_mode(requested: Literal["process", "lambda"] | None) -> Literal["process", "lambda"]:
    if requested in {"process", "lambda"}:
        return requested
    raw = (os.environ.get("TERRAIN_SPLITTER_ROOT_PARALLEL_MODE") or "process").strip().lower()
    if raw == "lambda":
        return "lambda"
    return "process"


def _resolve_root_parallel_granularity(requested: Literal["branch", "subtree"] | None) -> Literal["branch", "subtree"]:
    if requested in {"branch", "subtree"}:
        return requested
    raw = (os.environ.get("TERRAIN_SPLITTER_ROOT_PARALLEL_GRANULARITY") or "branch").strip().lower()
    if raw == "subtree":
        return "subtree"
    return "branch"


def _init_parallel_solver_context(context: SolverContext) -> None:
    global _PARALLEL_SOLVER_CONTEXT
    _PARALLEL_SOLVER_CONTEXT = context


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


def _build_region_for_context(
    cell_ids: tuple[int, ...],
    boundary_alignment: float,
    context: SolverContext,
    caches: SolverCaches,
    perf: dict[str, float],
) -> EvaluatedRegion | None:
    return _build_region(
        cell_ids,
        boundary_alignment,
        context.grid,
        context.neighbors,
        context.feature_lookup,
        context.cell_lookup,
        context.feature_field,
        context.params,
        caches.best_bearing_cache,
        caches.region_cache,
        caches.region_static_cache,
        caches.region_bearing_core_cache,
        caches.heading_candidates_cache,
        caches.polygon_cache,
        perf,
    )


def _generate_split_candidates_for_context(
    baseline_region: EvaluatedRegion,
    baseline_plan: PartitionPlan,
    cell_ids: tuple[int, ...],
    context: SolverContext,
    caches: SolverCaches,
    perf: dict[str, float],
) -> list[SplitCandidate]:
    return _generate_split_candidates(
        baseline_region,
        baseline_plan,
        cell_ids,
        context.root_area_m2,
        context.grid,
        context.feature_lookup,
        context.cell_lookup,
        context.feature_field,
        context.params,
        context.neighbors,
        caches.best_bearing_cache,
        caches.region_cache,
        caches.region_static_cache,
        caches.region_bearing_core_cache,
        caches.heading_candidates_cache,
        caches.polygon_cache,
        perf,
    )


def _solve_region_recursive(
    cell_ids: tuple[int, ...],
    depth: int,
    context: SolverContext,
    caches: SolverCaches,
    perf: dict[str, float],
) -> list[PartitionPlan]:
    perf["solve_region_calls"] += 1
    key = (cell_ids, depth)
    cached = caches.frontier_cache.get(key)
    if cached is not None:
        perf["solve_region_cache_hits"] += 1
        return cached

    baseline_region = _build_region_for_context(cell_ids, 0.0, context, caches, perf)
    if baseline_region is None:
        caches.frontier_cache[key] = []
        return []

    baseline_plan = _plan_from_regions((baseline_region,), 0.0, 0.0)
    if depth <= 0 or len(cell_ids) < 4 or baseline_region.objective.flight_line_count < 1:
        caches.frontier_cache[key] = [baseline_plan]
        perf["baseline_leaf_plans"] += 1
        return [baseline_plan]

    candidates = [baseline_plan]
    split_gen_started_at = time.perf_counter()
    for split in _generate_split_candidates_for_context(
        baseline_region,
        baseline_plan,
        cell_ids,
        context,
        caches,
        perf,
    ):
        left_frontier = _solve_region_recursive(split.left_ids, depth - 1, context, caches, perf) or []
        right_frontier = _solve_region_recursive(split.right_ids, depth - 1, context, caches, perf) or []
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

    frontier = _pareto_frontier(candidates, context.root_area_m2)
    perf["frontier_plan_count"] += len(frontier)
    caches.frontier_cache[key] = frontier
    return frontier


def _solve_root_split_branch(task: RootSplitTask) -> tuple[list[PartitionPlan], dict[str, float]]:
    if _PARALLEL_SOLVER_CONTEXT is None:
        raise RuntimeError("Parallel solver context is not initialized.")
    context = _PARALLEL_SOLVER_CONTEXT
    return _solve_root_split_branch_with_context(task, context)


def _solve_root_split_branch_with_context(
    task: RootSplitTask,
    context: SolverContext,
) -> tuple[list[PartitionPlan], dict[str, float]]:
    caches = _make_solver_caches()
    perf = _make_perf()
    left_frontier = _solve_region_recursive(task.left_ids, task.depth, context, caches, perf) or []
    right_frontier = _solve_region_recursive(task.right_ids, task.depth, context, caches, perf) or []
    if not left_frontier or not right_frontier:
        return [], dict(perf)
    combined_candidates: list[PartitionPlan] = []
    for left_plan in left_frontier:
        for right_plan in right_frontier:
            combined = _combine_plans(left_plan, right_plan, task.boundary)
            if combined.region_count > MAX_REGIONS:
                perf["combine_region_limit_rejections"] += 1
                continue
            combined_candidates.append(combined)
            perf["combined_plan_candidates"] += 1
    branch_frontier = _pareto_frontier(combined_candidates, context.root_area_m2)
    perf["frontier_plan_count"] += len(branch_frontier)
    return branch_frontier, dict(perf)


def _solve_subtree_task(task: SubtreeSolveTask) -> tuple[list[PartitionPlan], dict[str, float]]:
    if _PARALLEL_SOLVER_CONTEXT is None:
        raise RuntimeError("Parallel solver context is not initialized.")
    return _solve_subtree_task_with_context(task, _PARALLEL_SOLVER_CONTEXT)


def _solve_subtree_task_with_context(
    task: SubtreeSolveTask,
    context: SolverContext,
) -> tuple[list[PartitionPlan], dict[str, float]]:
    caches = _make_solver_caches()
    perf = _make_perf()
    frontier = _solve_region_recursive(task.cell_ids, task.depth, context, caches, perf) or []
    return frontier, dict(perf)


def _serialize_polygon(polygon: Polygon) -> str:
    return polygon.wkt


def _serialize_grid(grid: GridData) -> dict[str, Any]:
    return {
        "ring": grid.ring,
        "polygonWkt": _serialize_polygon(grid.polygon_mercator),
        "cells": [
            {
                "index": cell.index,
                "row": cell.row,
                "col": cell.col,
                "x": cell.x,
                "y": cell.y,
                "lng": cell.lng,
                "lat": cell.lat,
                "areaM2": cell.area_m2,
                "terrainZ": cell.terrain_z,
                "polygonWkt": _serialize_polygon(cell.polygon),
            }
            for cell in grid.cells
        ],
        "edges": [
            {
                "a": edge.a,
                "b": edge.b,
                "sharedBoundaryM": edge.shared_boundary_m,
            }
            for edge in grid.edges
        ],
        "gridStepM": grid.grid_step_m,
        "areaM2": grid.area_m2,
    }


def _deserialize_grid(payload: dict[str, Any]) -> GridData:
    return GridData(
        ring=[tuple(coord) for coord in payload["ring"]],
        polygon_mercator=load_wkt(payload["polygonWkt"]),
        cells=[
            GridCell(
                index=cell["index"],
                row=cell["row"],
                col=cell["col"],
                x=cell["x"],
                y=cell["y"],
                lng=cell["lng"],
                lat=cell["lat"],
                area_m2=cell["areaM2"],
                terrain_z=cell["terrainZ"],
                polygon=load_wkt(cell["polygonWkt"]),
            )
            for cell in payload["cells"]
        ],
        edges=[
            GridEdge(
                a=edge["a"],
                b=edge["b"],
                shared_boundary_m=edge["sharedBoundaryM"],
            )
            for edge in payload["edges"]
        ],
        grid_step_m=payload["gridStepM"],
        area_m2=payload["areaM2"],
    )


def _serialize_feature_field(feature_field: FeatureField) -> dict[str, Any]:
    return {
        "cells": [
            {
                "index": cell.index,
                "preferredBearingDeg": cell.preferred_bearing_deg,
                "slopeMagnitude": cell.slope_magnitude,
                "breakStrength": cell.break_strength,
                "confidence": cell.confidence,
                "aspectDeg": cell.aspect_deg,
            }
            for cell in feature_field.cells
        ],
        "dominantPreferredBearingDeg": feature_field.dominant_preferred_bearing_deg,
        "dominantAspectDeg": feature_field.dominant_aspect_deg,
    }


def _deserialize_feature_field(payload: dict[str, Any]) -> FeatureField:
    return FeatureField(
        cells=[
            CellFeatures(
                index=cell["index"],
                preferred_bearing_deg=cell["preferredBearingDeg"],
                slope_magnitude=cell["slopeMagnitude"],
                break_strength=cell["breakStrength"],
                confidence=cell["confidence"],
                aspect_deg=cell["aspectDeg"],
            )
            for cell in payload["cells"]
        ],
        dominant_preferred_bearing_deg=payload.get("dominantPreferredBearingDeg"),
        dominant_aspect_deg=payload.get("dominantAspectDeg"),
    )


def _serialize_solver_context(context: SolverContext) -> dict[str, Any]:
    return {
        "grid": _serialize_grid(context.grid),
        "featureField": _serialize_feature_field(context.feature_field),
        "params": context.params.model_dump(mode="json"),
    }


def _deserialize_solver_context(payload: dict[str, Any]) -> SolverContext:
    grid = _deserialize_grid(payload["grid"])
    feature_field = _deserialize_feature_field(payload["featureField"])
    return SolverContext(
        grid=grid,
        feature_field=feature_field,
        params=FlightParamsModel.model_validate(payload["params"]),
        root_area_m2=max(1.0, grid.area_m2),
        feature_lookup=_feature_lookup(feature_field),
        cell_lookup=_cell_lookup(grid),
        neighbors=_neighbor_lookup(grid),
    )


def _serialize_boundary(boundary: BoundaryStats) -> dict[str, float]:
    return {
        "sharedBoundaryM": boundary.shared_boundary_m,
        "breakWeightSum": boundary.break_weight_sum,
    }


def _deserialize_boundary(payload: dict[str, Any]) -> BoundaryStats:
    return BoundaryStats(
        shared_boundary_m=payload["sharedBoundaryM"],
        break_weight_sum=payload["breakWeightSum"],
    )


def _serialize_root_split_task(task: RootSplitTask) -> dict[str, Any]:
    return {
        "leftIds": list(task.left_ids),
        "rightIds": list(task.right_ids),
        "boundary": _serialize_boundary(task.boundary),
        "depth": task.depth,
    }


def _deserialize_root_split_task(payload: dict[str, Any]) -> RootSplitTask:
    return RootSplitTask(
        left_ids=tuple(payload["leftIds"]),
        right_ids=tuple(payload["rightIds"]),
        boundary=_deserialize_boundary(payload["boundary"]),
        depth=payload["depth"],
    )


def _serialize_subtree_task(task: SubtreeSolveTask) -> dict[str, Any]:
    return {
        "cellIds": list(task.cell_ids),
        "depth": task.depth,
    }


def _deserialize_subtree_task(payload: dict[str, Any]) -> SubtreeSolveTask:
    return SubtreeSolveTask(
        cell_ids=tuple(payload["cellIds"]),
        depth=payload["depth"],
    )


def _serialize_region_objective(objective: RegionObjective) -> dict[str, Any]:
    return {
        "bearingDeg": objective.bearing_deg,
        "normalizedQualityCost": objective.normalized_quality_cost,
        "totalMissionTimeSec": objective.total_mission_time_sec,
        "weightedMeanMismatchDeg": objective.weighted_mean_mismatch_deg,
        "areaM2": objective.area_m2,
        "convexity": objective.convexity,
        "compactness": objective.compactness,
        "boundaryBreakAlignment": objective.boundary_break_alignment,
        "flightLineCount": objective.flight_line_count,
        "lineSpacingM": objective.line_spacing_m,
        "alongTrackLengthM": objective.along_track_length_m,
        "crossTrackWidthM": objective.cross_track_width_m,
        "fragmentedLineFraction": objective.fragmented_line_fraction,
        "overflightTransitFraction": objective.overflight_transit_fraction,
        "shortLineFraction": objective.short_line_fraction,
        "meanLineLengthM": objective.mean_line_length_m,
        "medianLineLengthM": objective.median_line_length_m,
        "meanLineLiftM": objective.mean_line_lift_m,
        "p90LineLiftM": objective.p90_line_lift_m,
        "maxLineLiftM": objective.max_line_lift_m,
        "elevatedAreaFraction": objective.elevated_area_fraction,
        "severeLiftAreaFraction": objective.severe_lift_area_fraction,
    }


def _deserialize_region_objective(payload: dict[str, Any]) -> RegionObjective:
    return RegionObjective(
        bearing_deg=payload["bearingDeg"],
        normalized_quality_cost=payload["normalizedQualityCost"],
        total_mission_time_sec=payload["totalMissionTimeSec"],
        weighted_mean_mismatch_deg=payload["weightedMeanMismatchDeg"],
        area_m2=payload["areaM2"],
        convexity=payload["convexity"],
        compactness=payload["compactness"],
        boundary_break_alignment=payload["boundaryBreakAlignment"],
        flight_line_count=payload["flightLineCount"],
        line_spacing_m=payload["lineSpacingM"],
        along_track_length_m=payload["alongTrackLengthM"],
        cross_track_width_m=payload["crossTrackWidthM"],
        fragmented_line_fraction=payload["fragmentedLineFraction"],
        overflight_transit_fraction=payload["overflightTransitFraction"],
        short_line_fraction=payload["shortLineFraction"],
        mean_line_length_m=payload["meanLineLengthM"],
        median_line_length_m=payload["medianLineLengthM"],
        mean_line_lift_m=payload["meanLineLiftM"],
        p90_line_lift_m=payload["p90LineLiftM"],
        max_line_lift_m=payload["maxLineLiftM"],
        elevated_area_fraction=payload["elevatedAreaFraction"],
        severe_lift_area_fraction=payload["severeLiftAreaFraction"],
    )


def _serialize_evaluated_region(region: EvaluatedRegion) -> dict[str, Any]:
    return {
        "cellIds": list(region.cell_ids),
        "ring": region.ring,
        "objective": _serialize_region_objective(region.objective),
        "score": region.score,
        "hardInvalid": region.hard_invalid,
    }


def _deserialize_evaluated_region(payload: dict[str, Any]) -> EvaluatedRegion:
    return EvaluatedRegion(
        cell_ids=tuple(payload["cellIds"]),
        polygon=Polygon(),
        ring=[tuple(coord) for coord in payload["ring"]],
        objective=_deserialize_region_objective(payload["objective"]),
        score=payload["score"],
        hard_invalid=payload["hardInvalid"],
    )


def _serialize_partition_plan(plan: PartitionPlan) -> dict[str, Any]:
    return {
        "regions": [_serialize_evaluated_region(region) for region in plan.regions],
        "qualityCost": plan.quality_cost,
        "missionTimeSec": plan.mission_time_sec,
        "weightedMeanMismatchDeg": plan.weighted_mean_mismatch_deg,
        "internalBoundaryM": plan.internal_boundary_m,
        "breakWeightSum": plan.break_weight_sum,
        "largestRegionFraction": plan.largest_region_fraction,
        "meanConvexity": plan.mean_convexity,
        "regionCount": plan.region_count,
    }


def _deserialize_partition_plan(payload: dict[str, Any]) -> PartitionPlan:
    return PartitionPlan(
        regions=tuple(_deserialize_evaluated_region(region) for region in payload["regions"]),
        quality_cost=payload["qualityCost"],
        mission_time_sec=payload["missionTimeSec"],
        weighted_mean_mismatch_deg=payload["weightedMeanMismatchDeg"],
        internal_boundary_m=payload["internalBoundaryM"],
        break_weight_sum=payload["breakWeightSum"],
        largest_region_fraction=payload["largestRegionFraction"],
        mean_convexity=payload["meanConvexity"],
        region_count=payload["regionCount"],
    )


def solve_root_split_branch_event(payload: dict[str, Any]) -> dict[str, Any]:
    context = _deserialize_solver_context(payload["context"])
    task = _deserialize_root_split_task(payload["task"])
    frontier, perf = _solve_root_split_branch_with_context(task, context)
    return {
        "plans": [_serialize_partition_plan(plan) for plan in frontier],
        "perf": perf,
    }


def solve_subtree_task_event(payload: dict[str, Any]) -> dict[str, Any]:
    context = _deserialize_solver_context(payload["context"])
    task = _deserialize_subtree_task(payload["task"])
    frontier, perf = _solve_subtree_task_with_context(task, context)
    return {
        "plans": [_serialize_partition_plan(plan) for plan in frontier],
        "perf": perf,
    }


def _invoke_root_split_branch_lambda(
    function_name: str,
    context: SolverContext,
    task: RootSplitTask,
) -> tuple[list[PartitionPlan], dict[str, float]]:
    try:
        import boto3
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("boto3 is required for Lambda root fan-out mode.") from exc

    client = boto3.client("lambda")
    payload = {
        "terrainSplitterInternal": "root-split",
        "payload": {
            "context": _serialize_solver_context(context),
            "task": _serialize_root_split_task(task),
        },
    }
    response = client.invoke(
        FunctionName=function_name,
        InvocationType="RequestResponse",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    if "FunctionError" in response:
        error_payload = response["Payload"].read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Lambda root split invocation failed: {error_payload}")
    raw_payload = response["Payload"].read()
    decoded = json.loads(raw_payload.decode("utf-8"))
    return (
        [_deserialize_partition_plan(plan) for plan in decoded["plans"]],
        {key: float(value) for key, value in decoded.get("perf", {}).items()},
    )


def _invoke_subtree_lambda(
    function_name: str,
    context: SolverContext,
    task: SubtreeSolveTask,
) -> tuple[list[PartitionPlan], dict[str, float]]:
    try:
        import boto3
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("boto3 is required for Lambda subtree fan-out mode.") from exc

    client = boto3.client("lambda")
    payload = {
        "terrainSplitterInternal": "subtree",
        "payload": {
            "context": _serialize_solver_context(context),
            "task": _serialize_subtree_task(task),
        },
    }
    response = client.invoke(
        FunctionName=function_name,
        InvocationType="RequestResponse",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    if "FunctionError" in response:
        error_payload = response["Payload"].read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Lambda subtree invocation failed: {error_payload}")
    raw_payload = response["Payload"].read()
    decoded = json.loads(raw_payload.decode("utf-8"))
    return (
        [_deserialize_partition_plan(plan) for plan in decoded["plans"]],
        {key: float(value) for key, value in decoded.get("perf", {}).items()},
    )


def _solve_root_splits_via_lambda(
    tasks: list[RootSplitTask],
    context: SolverContext,
    max_workers: int,
) -> tuple[list[PartitionPlan], dict[str, float]]:
    function_name = os.environ.get("AWS_LAMBDA_FUNCTION_NAME")
    if not function_name:
        raise RuntimeError("AWS_LAMBDA_FUNCTION_NAME is required for Lambda root fan-out mode.")
    perf = _make_perf()
    plans: list[PartitionPlan] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            executor.submit(_invoke_root_split_branch_lambda, function_name, context, task)
            for task in tasks
        ]
        for future in futures:
            branch_frontier, branch_perf = future.result()
            plans.extend(branch_frontier)
            _merge_perf(perf, branch_perf)
    return plans, perf


def _solve_subtrees_via_lambda(
    tasks: list[tuple[int, str, SubtreeSolveTask]],
    context: SolverContext,
    max_workers: int,
) -> tuple[dict[int, dict[str, list[PartitionPlan]]], dict[str, float]]:
    function_name = os.environ.get("AWS_LAMBDA_FUNCTION_NAME")
    if not function_name:
        raise RuntimeError("AWS_LAMBDA_FUNCTION_NAME is required for Lambda subtree fan-out mode.")
    perf = _make_perf()
    subtree_results: dict[int, dict[str, list[PartitionPlan]]] = defaultdict(dict)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            (index, side, executor.submit(_invoke_subtree_lambda, function_name, context, task))
            for index, side, task in tasks
        ]
        for index, side, future in futures:
            frontier, subtree_perf = future.result()
            subtree_results[index][side] = frontier
            _merge_perf(perf, subtree_perf)
    return subtree_results, perf


def solve_partition_hierarchy(
    grid: GridData,
    feature_field: FeatureField,
    params: FlightParamsModel,
    requested_tradeoff: float | None = None,
    *,
    request_id: str | None = None,
    polygon_id: str | None = None,
    root_parallel_workers: int | None = None,
    root_parallel_mode: Literal["process", "lambda"] | None = None,
    root_parallel_granularity: Literal["branch", "subtree"] | None = None,
) -> list[PartitionSolutionPreviewModel]:
    solve_started_at = time.perf_counter()
    if not grid.cells:
        return []

    feature_lookup = _feature_lookup(feature_field)
    cell_lookup = _cell_lookup(grid)
    neighbors = _neighbor_lookup(grid)
    perf = _make_perf()
    caches = _make_solver_caches()
    root_area_m2 = max(1.0, grid.area_m2)
    context = SolverContext(
        grid=grid,
        feature_field=feature_field,
        params=params,
        root_area_m2=root_area_m2,
        feature_lookup=feature_lookup,
        cell_lookup=cell_lookup,
        neighbors=neighbors,
    )
    max_depth = DEFAULT_DEPTH_SMALL if len(grid.cells) <= 140 else DEFAULT_DEPTH_LARGE

    root_cell_ids = tuple(sorted(cell_lookup))
    requested_workers = _resolve_root_parallel_workers(root_parallel_workers)
    parallel_mode = _resolve_root_parallel_mode(root_parallel_mode)
    parallel_granularity = _resolve_root_parallel_granularity(root_parallel_granularity)
    all_plans: list[PartitionPlan]
    if requested_workers <= 1:
        all_plans = _solve_region_recursive(root_cell_ids, max_depth, context, caches, perf)
    else:
        baseline_region = _build_region_for_context(root_cell_ids, 0.0, context, caches, perf)
        if baseline_region is None:
            all_plans = []
        else:
            baseline_plan = _plan_from_regions((baseline_region,), 0.0, 0.0)
            if max_depth <= 0 or len(root_cell_ids) < 4 or baseline_region.objective.flight_line_count < 1:
                perf["baseline_leaf_plans"] += 1
                all_plans = [baseline_plan]
            else:
                root_splits = _generate_split_candidates_for_context(
                    baseline_region,
                    baseline_plan,
                    root_cell_ids,
                    context,
                    caches,
                    perf,
                )
                usable_workers = min(requested_workers, len(root_splits))
                if usable_workers <= 1 or not root_splits:
                    all_plans = _solve_region_recursive(root_cell_ids, max_depth, context, caches, perf)
                else:
                    perf["root_parallel_requested_workers"] = requested_workers
                    perf["root_parallel_workers_used"] = usable_workers
                    perf["root_parallel_split_count"] = len(root_splits)
                    branch_started_at = time.perf_counter()
                    branch_candidates: list[PartitionPlan] = []
                    tasks = [
                        RootSplitTask(
                            left_ids=split.left_ids,
                            right_ids=split.right_ids,
                            boundary=split.boundary,
                            depth=max_depth - 1,
                        )
                        for split in root_splits
                    ]
                    try:
                        if parallel_mode == "lambda":
                            if parallel_granularity == "subtree":
                                subtree_tasks: list[tuple[int, str, SubtreeSolveTask]] = []
                                for index, split in enumerate(root_splits):
                                    subtree_tasks.append((index, "left", SubtreeSolveTask(cell_ids=split.left_ids, depth=max_depth - 1)))
                                    subtree_tasks.append((index, "right", SubtreeSolveTask(cell_ids=split.right_ids, depth=max_depth - 1)))
                                subtree_workers = min(max(requested_workers, len(tasks)), len(subtree_tasks))
                                perf["root_parallel_subtree_tasks"] = len(subtree_tasks)
                                perf["root_parallel_workers_used"] = subtree_workers
                                subtree_results, lambda_perf = _solve_subtrees_via_lambda(
                                    subtree_tasks,
                                    context,
                                    subtree_workers,
                                )
                                _merge_perf(perf, lambda_perf)
                                for index, split in enumerate(root_splits):
                                    left_frontier = subtree_results.get(index, {}).get("left", [])
                                    right_frontier = subtree_results.get(index, {}).get("right", [])
                                    if not left_frontier or not right_frontier:
                                        continue
                                    for left_plan in left_frontier:
                                        for right_plan in right_frontier:
                                            combined = _combine_plans(left_plan, right_plan, split.boundary)
                                            if combined.region_count > MAX_REGIONS:
                                                perf["combine_region_limit_rejections"] += 1
                                                continue
                                            branch_candidates.append(combined)
                                            perf["combined_plan_candidates"] += 1
                            else:
                                lambda_plans, lambda_perf = _solve_root_splits_via_lambda(tasks, context, usable_workers)
                                branch_candidates.extend(lambda_plans)
                                _merge_perf(perf, lambda_perf)
                        else:
                            if parallel_granularity == "subtree":
                                subtree_tasks: list[tuple[int, str, SubtreeSolveTask]] = []
                                for index, split in enumerate(root_splits):
                                    subtree_tasks.append((index, "left", SubtreeSolveTask(cell_ids=split.left_ids, depth=max_depth - 1)))
                                    subtree_tasks.append((index, "right", SubtreeSolveTask(cell_ids=split.right_ids, depth=max_depth - 1)))
                                subtree_workers = min(max(requested_workers, len(tasks)), len(subtree_tasks))
                                perf["root_parallel_subtree_tasks"] = len(subtree_tasks)
                                perf["root_parallel_workers_used"] = subtree_workers
                                subtree_results: dict[int, dict[str, list[PartitionPlan]]] = defaultdict(dict)
                                with ProcessPoolExecutor(
                                    max_workers=subtree_workers,
                                    initializer=_init_parallel_solver_context,
                                    initargs=(context,),
                                ) as executor:
                                    for (index, side, _), (subtree_frontier, subtree_perf) in zip(
                                        subtree_tasks,
                                        executor.map(_solve_subtree_task, [task for _, _, task in subtree_tasks]),
                                        strict=True,
                                    ):
                                        subtree_results[index][side] = subtree_frontier
                                        _merge_perf(perf, subtree_perf)
                                for index, split in enumerate(root_splits):
                                    left_frontier = subtree_results.get(index, {}).get("left", [])
                                    right_frontier = subtree_results.get(index, {}).get("right", [])
                                    if not left_frontier or not right_frontier:
                                        continue
                                    for left_plan in left_frontier:
                                        for right_plan in right_frontier:
                                            combined = _combine_plans(left_plan, right_plan, split.boundary)
                                            if combined.region_count > MAX_REGIONS:
                                                perf["combine_region_limit_rejections"] += 1
                                                continue
                                            branch_candidates.append(combined)
                                            perf["combined_plan_candidates"] += 1
                            else:
                                with ProcessPoolExecutor(
                                    max_workers=usable_workers,
                                    initializer=_init_parallel_solver_context,
                                    initargs=(context,),
                                ) as executor:
                                    for branch_frontier, branch_perf in executor.map(_solve_root_split_branch, tasks):
                                        branch_candidates.extend(branch_frontier)
                                        _merge_perf(perf, branch_perf)
                    except Exception:  # noqa: BLE001
                        logger.exception(
                            "[terrain-split-backend][%s] root-parallel solve failed polygonId=%s mode=%s granularity=%s; falling back to serial",
                            request_id or "<none>",
                            polygon_id or "<none>",
                            parallel_mode,
                            parallel_granularity,
                        )
                        perf["root_parallel_failures"] += 1
                        all_plans = _solve_region_recursive(root_cell_ids, max_depth, context, caches, perf)
                    else:
                        perf["root_parallel_ms"] += (time.perf_counter() - branch_started_at) * 1000.0
                        all_plans = _pareto_frontier([baseline_plan] + branch_candidates, root_area_m2)
                        perf["frontier_plan_count"] += len(all_plans)
    if not all_plans:
        total_ms = (time.perf_counter() - solve_started_at) * 1000.0
        logger.info(
            "[terrain-split-backend][%s] solver finished polygonId=%s cells=%d maxDepth=%d totalMs=%.1f allPlans=0 rootParallelMode=%s rootParallelGranularity=%s rootParallelRequested=%d rootParallelUsed=%d rootParallelSplits=%d solveRegionCalls=%d cacheHits=%d regionCacheHits=%d regionCacheMisses=%d regionStaticHits=%d regionStaticMisses=%d regionBearingHits=%d regionBearingMisses=%d buildRegionCalls=%d objectiveCalls=%d splitAttempts=%d kept=%d",
            request_id or "<none>",
            polygon_id or "<none>",
            len(grid.cells),
            max_depth,
            total_ms,
            parallel_mode,
            parallel_granularity,
            requested_workers,
            int(perf["root_parallel_workers_used"]),
            int(perf["root_parallel_split_count"]),
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
            "[terrain-split-backend][%s] solver finished polygonId=%s cells=%d maxDepth=%d totalMs=%.1f allPlans=%d practicalPlans=0 rootParallelMode=%s rootParallelGranularity=%s rootParallelRequested=%d rootParallelUsed=%d rootParallelSplits=%d rootParallelSubtreeTasks=%d rootParallelMs=%.1f solveRegionCalls=%d cacheHits=%d regionCacheHits=%d regionCacheMisses=%d regionStaticHits=%d regionStaticMisses=%d regionBearingHits=%d regionBearingMisses=%d buildRegionCalls=%d buildRegionMs=%.1f regionStaticBuildMs=%.1f polygonMs=%.1f objectiveCalls=%d objectiveMs=%.1f regionBearingCoreMs=%.1f nodeCostMs=%.1f lineLiftMs=%.1f flightTimeMs=%.1f shapeMetricMs=%.1f splitGenMs=%.1f splitAttempts=%d kept=%d returned=%d",
            request_id or "<none>",
            polygon_id or "<none>",
            len(grid.cells),
            max_depth,
            total_ms,
            len(all_plans),
            parallel_mode,
            parallel_granularity,
            requested_workers,
            int(perf["root_parallel_workers_used"]),
            int(perf["root_parallel_split_count"]),
            int(perf["root_parallel_subtree_tasks"]),
            perf["root_parallel_ms"],
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
        "[terrain-split-backend][%s] solver finished polygonId=%s cells=%d maxDepth=%d totalMs=%.1f allPlans=%d practicalPlans=%d returnedSolutions=%d rootParallelMode=%s rootParallelGranularity=%s rootParallelRequested=%d rootParallelUsed=%d rootParallelSplits=%d rootParallelSubtreeTasks=%d rootParallelMs=%.1f rootParallelFailures=%d solveRegionCalls=%d cacheHits=%d regionCacheHits=%d regionCacheMisses=%d regionCacheHitRate=%.3f regionStaticHits=%d regionStaticMisses=%d regionStaticHitRate=%.3f regionStaticNullHits=%d regionBearingHits=%d regionBearingMisses=%d regionBearingHitRate=%.3f regionBearingRewraps=%d buildRegionCalls=%d buildRegionMs=%.1f regionStaticBuildMs=%.1f polygonMs=%.1f polygonFailures=%d objectiveCalls=%d objectiveMs=%.1f regionBearingCoreMs=%.1f nodeCostMs=%.1f lineLiftMs=%.1f flightTimeMs=%.1f shapeMetricMs=%.1f splitGenMs=%.1f splitDirections=%d splitAttempts=%d kept=%d returned=%d smallChildRejects=%d duplicateRejects=%d disconnectedRejects=%d boundaryRejects=%d regionBuildRejects=%d validityRejects=%d nonImprovingRejects=%d combinedCandidates=%d frontierStates=%d",
        request_id or "<none>",
        polygon_id or "<none>",
        len(grid.cells),
        max_depth,
        total_ms,
        len(all_plans),
        len(practical),
        len(previews),
        parallel_mode,
        parallel_granularity,
        requested_workers,
        int(perf["root_parallel_workers_used"]),
        int(perf["root_parallel_split_count"]),
        int(perf["root_parallel_subtree_tasks"]),
        perf["root_parallel_ms"],
        int(perf["root_parallel_failures"]),
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
