from __future__ import annotations

import math
from dataclasses import dataclass

from .geometry import (
    axial_angle_delta_deg,
    clamp,
    deg_to_rad,
    normalize_axial_bearing,
    weighted_axial_mean_deg,
)
from .grid import GridData
from .mapbox_tiles import TerrainDEM


@dataclass(slots=True)
class CellFeatures:
    index: int
    preferred_bearing_deg: float
    slope_magnitude: float
    break_strength: float
    confidence: float
    aspect_deg: float


@dataclass(slots=True)
class FeatureField:
    cells: list[CellFeatures]
    dominant_preferred_bearing_deg: float | None
    dominant_aspect_deg: float | None = None


def _destination_meters(x: float, y: float, bearing_deg: float, distance_m: float) -> tuple[float, float]:
    rad = deg_to_rad(bearing_deg)
    return x + math.sin(rad) * distance_m, y + math.cos(rad) * distance_m


def _finite(value: float) -> bool:
    return math.isfinite(value)


def _axis_gradient(
    center: float,
    positive: float,
    negative: float,
    step_m: float,
) -> float | None:
    if _finite(positive) and _finite(negative):
        return (positive - negative) / (2.0 * step_m)
    if _finite(positive):
        return (positive - center) / step_m
    if _finite(negative):
        return (center - negative) / step_m
    return None


def _circular_angle_delta_deg(a: float, b: float) -> float:
    aa = a % 360.0
    bb = b % 360.0
    delta = abs(aa - bb)
    return min(delta, 360.0 - delta)


def _weighted_circular_mean_deg(values: list[tuple[float, float]]) -> float | None:
    sum_sin = 0.0
    sum_cos = 0.0
    total = 0.0
    for angle_deg, weight in values:
        if not math.isfinite(angle_deg) or weight <= 0:
            continue
        rad = deg_to_rad(angle_deg)
        sum_sin += math.sin(rad) * weight
        sum_cos += math.cos(rad) * weight
        total += weight
    if total <= 0:
        return None
    return (math.degrees(math.atan2(sum_sin, sum_cos)) + 360.0) % 360.0


def compute_feature_field(grid: GridData, dem: TerrainDEM) -> FeatureField:
    sample_step = clamp(grid.grid_step_m * 0.8, 18.0, 90.0)
    cells: list[CellFeatures] = []
    by_index: dict[int, CellFeatures] = {}

    for cell in grid.cells:
        ex, ey = _destination_meters(cell.x, cell.y, 90.0, sample_step)
        wx, wy = _destination_meters(cell.x, cell.y, 270.0, sample_step)
        nx, ny = _destination_meters(cell.x, cell.y, 0.0, sample_step)
        sx, sy = _destination_meters(cell.x, cell.y, 180.0, sample_step)
        ze = dem.sample_mercator(ex, ey)
        zw = dem.sample_mercator(wx, wy)
        zn = dem.sample_mercator(nx, ny)
        zs = dem.sample_mercator(sx, sy)
        if not _finite(cell.terrain_z):
            continue
        grad_x = _axis_gradient(cell.terrain_z, ze, zw, sample_step)
        grad_y = _axis_gradient(cell.terrain_z, zn, zs, sample_step)
        if grad_x is None or grad_y is None:
            continue
        slope = math.sqrt(grad_x * grad_x + grad_y * grad_y)
        if slope <= 1e-6:
            aspect_deg = 0.0
            preferred_bearing_deg = 0.0
        else:
            # Aspect is kept as a full 0..360 direction so opposite faces remain distinct.
            aspect_rad = (math.atan2(grad_x, grad_y) + 2.0 * math.pi) % (2.0 * math.pi)
            aspect_deg = (math.degrees(aspect_rad) + 360.0) % 360.0
            preferred_bearing_deg = normalize_axial_bearing(aspect_deg + 90.0)
        features = CellFeatures(
            index=cell.index,
            preferred_bearing_deg=preferred_bearing_deg,
            slope_magnitude=slope,
            break_strength=0.0,
            confidence=0.0,
            aspect_deg=aspect_deg,
        )
        by_index[cell.index] = features
        cells.append(features)

    neighbors: dict[int, list[int]] = {cell.index: [] for cell in grid.cells}
    for edge in grid.edges:
        neighbors.setdefault(edge.a, []).append(edge.b)
        neighbors.setdefault(edge.b, []).append(edge.a)

    grid_cell_lookup = {cell.index: cell for cell in grid.cells}
    for features in cells:
        adjacent = neighbors.get(features.index, [])
        if not adjacent:
            continue
        signed_aspect_disagreement = 0.0
        axial_bearing_disagreement = 0.0
        slope_contrast = 0.0
        total_weight = 0.0
        current_cell = grid_cell_lookup[features.index]
        for neighbor_index in adjacent:
            neighbor = by_index.get(neighbor_index)
            if neighbor is None:
                continue
            neighbor_cell = grid_cell_lookup[neighbor_index]
            dx = neighbor_cell.x - current_cell.x
            dy = neighbor_cell.y - current_cell.y
            dist = math.sqrt(dx * dx + dy * dy)
            if dist <= 0:
                continue
            weight = max(0.05, 1.0 - dist / (grid.grid_step_m * 2.6))
            signed_aspect_disagreement += _circular_angle_delta_deg(features.aspect_deg, neighbor.aspect_deg) * weight
            axial_bearing_disagreement += axial_angle_delta_deg(
                features.preferred_bearing_deg,
                neighbor.preferred_bearing_deg,
            ) * weight
            slope_contrast += abs(features.slope_magnitude - neighbor.slope_magnitude) * weight
            total_weight += weight
        if total_weight <= 0:
            continue
        mean_aspect_delta = signed_aspect_disagreement / total_weight
        mean_bearing_delta = axial_bearing_disagreement / total_weight
        mean_slope_contrast = slope_contrast / total_weight
        slope_scale = clamp(features.slope_magnitude / 0.18, 0.3, 1.8)
        features.break_strength = (
            0.65 * mean_aspect_delta
            + 0.35 * mean_bearing_delta
            + 70.0 * mean_slope_contrast
        ) * slope_scale

    for features in cells:
        slope_term = clamp(features.slope_magnitude / 0.12, 0.0, 1.0)
        stability_term = clamp(1.0 - features.break_strength / 65.0, 0.15, 1.0)
        features.confidence = slope_term * stability_term

    dominant_bearing = weighted_axial_mean_deg(
        (
            features.preferred_bearing_deg,
            max(1e-6, grid_cell_lookup[features.index].area_m2 * (0.2 + 0.8 * features.confidence)),
        )
        for features in cells
    )
    dominant_aspect = _weighted_circular_mean_deg(
        [
            (
                features.aspect_deg,
                max(1e-6, grid_cell_lookup[features.index].area_m2 * (0.2 + 0.8 * features.confidence)),
            )
            for features in cells
        ]
    )
    return FeatureField(
        cells=cells,
        dominant_preferred_bearing_deg=dominant_bearing,
        dominant_aspect_deg=dominant_aspect,
    )


def detect_heading_peaks(feature_field: FeatureField, max_peaks: int = 6) -> list[float]:
    if not feature_field.cells:
        return [0.0]
    bin_step = 15.0
    bin_count = int(180.0 / bin_step)
    weights = [0.0] * bin_count
    for cell in feature_field.cells:
        value = normalize_axial_bearing(cell.preferred_bearing_deg)
        idx = int(value // bin_step) % bin_count
        weights[idx] += max(1e-6, cell.confidence)

    peaks: list[tuple[float, float]] = []
    for idx, weight in enumerate(weights):
        prev_weight = weights[(idx - 1) % bin_count]
        next_weight = weights[(idx + 1) % bin_count]
        if weight >= prev_weight and weight >= next_weight and weight > 0:
            angle = idx * bin_step + bin_step * 0.5
            peaks.append((angle, weight))
    peaks.sort(key=lambda item: item[1], reverse=True)

    selected: list[float] = []
    for angle, _ in peaks:
        if any(axial_angle_delta_deg(angle, chosen) < 18.0 for chosen in selected):
            continue
        selected.append(normalize_axial_bearing(angle))
        if len(selected) >= max_peaks:
            break
    dominant = feature_field.dominant_preferred_bearing_deg
    if dominant is not None and not any(axial_angle_delta_deg(dominant, chosen) < 12.0 for chosen in selected):
        selected.insert(0, dominant)
    return selected[:max_peaks] or [dominant or 0.0]
