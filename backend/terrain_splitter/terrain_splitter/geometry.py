from __future__ import annotations

import hashlib
import math
from typing import Iterable

import numpy as np
from shapely.geometry import Polygon

try:
    from shapely import coverage_simplify as shapely_coverage_simplify
except ImportError:  # pragma: no cover - exercised only on older Shapely
    shapely_coverage_simplify = None


WEB_MERCATOR_R = 6378137.0
MAX_LAT = 85.05112878


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def deg_to_rad(value: float) -> float:
    return value * math.pi / 180.0


def rad_to_deg(value: float) -> float:
    return value * 180.0 / math.pi


def normalize_axial_bearing(value: float) -> float:
    return ((value % 180.0) + 180.0) % 180.0


def axial_angle_delta_deg(a: float, b: float) -> float:
    aa = normalize_axial_bearing(a)
    bb = normalize_axial_bearing(b)
    delta = abs(aa - bb)
    return min(delta, 180.0 - delta)


def lnglat_to_mercator(lng: float, lat: float) -> tuple[float, float]:
    phi = clamp(lat, -MAX_LAT, MAX_LAT) * math.pi / 180.0
    lam = lng * math.pi / 180.0
    return WEB_MERCATOR_R * lam, WEB_MERCATOR_R * math.log(math.tan(math.pi / 4.0 + phi / 2.0))


def mercator_to_lnglat(x: float, y: float) -> tuple[float, float]:
    lng = rad_to_deg(x / WEB_MERCATOR_R)
    lat = rad_to_deg(2.0 * math.atan(math.exp(y / WEB_MERCATOR_R)) - math.pi / 2.0)
    return lng, lat


def normalize_ring(ring: Iterable[tuple[float, float]]) -> list[tuple[float, float]]:
    cleaned = [
        (float(lng), float(lat))
        for lng, lat in ring
        if math.isfinite(lng) and math.isfinite(lat)
    ]
    if len(cleaned) < 3:
        raise ValueError("Polygon ring must contain at least three valid coordinates.")
    if cleaned[0] != cleaned[-1]:
        cleaned.append(cleaned[0])
    return cleaned


def ring_to_polygon_mercator(ring: Iterable[tuple[float, float]]) -> Polygon:
    normalized = normalize_ring(ring)
    coords = [lnglat_to_mercator(lng, lat) for lng, lat in normalized]
    polygon = Polygon(coords)
    if not polygon.is_valid:
        polygon = polygon.buffer(0)
    if polygon.is_empty:
        raise ValueError("Polygon ring produced an empty geometry.")
    return polygon


def weighted_axial_mean_deg(values: Iterable[tuple[float, float]]) -> float | None:
    sum_sin = 0.0
    sum_cos = 0.0
    total = 0.0
    for angle_deg, weight in values:
        if not math.isfinite(angle_deg) or not (weight > 0):
            continue
        doubled = deg_to_rad(normalize_axial_bearing(angle_deg) * 2.0)
        sum_sin += math.sin(doubled) * weight
        sum_cos += math.cos(doubled) * weight
        total += weight
    if total <= 0:
        return None
    mean_rad = 0.5 * math.atan2(sum_sin, sum_cos)
    return normalize_axial_bearing(rad_to_deg(mean_rad))


def weighted_quantile(values: Iterable[tuple[float, float]], q: float) -> float:
    filtered = sorted(
        [(float(value), float(weight)) for value, weight in values if math.isfinite(value) and weight > 0],
        key=lambda item: item[0],
    )
    if not filtered:
        return 0.0
    total_weight = sum(weight for _, weight in filtered)
    target = clamp(q, 0.0, 1.0) * total_weight
    acc = 0.0
    for value, weight in filtered:
        acc += weight
        if acc >= target:
            return value
    return filtered[-1][0]


def weighted_mean(values: Iterable[tuple[float, float]]) -> float:
    total_weight = 0.0
    total_value = 0.0
    for value, weight in values:
        if not math.isfinite(value) or not (weight > 0):
            continue
        total_weight += weight
        total_value += value * weight
    return total_value / total_weight if total_weight > 0 else 0.0


def hash_signature(payload: dict) -> str:
    encoded = repr(payload).encode("utf-8")
    return hashlib.sha1(encoded).hexdigest()[:16]


def polygon_convexity(polygon: Polygon) -> float:
    hull_area = polygon.convex_hull.area
    if hull_area <= 0:
        return 1.0
    return clamp(polygon.area / hull_area, 0.0, 1.0)


def polygon_compactness(polygon: Polygon) -> float:
    if polygon.area <= 0 or polygon.length <= 0:
        return 1.0
    return (polygon.length * polygon.length) / (4.0 * math.pi * polygon.area)


def polygon_to_lnglat_ring(polygon: Polygon) -> list[tuple[float, float]]:
    coords = list(polygon.exterior.coords)
    return [mercator_to_lnglat(x, y) for x, y in coords]


def simplify_polygon_coverage(
    polygons: Iterable[Polygon],
    tolerance_m: float,
    *,
    simplify_boundary: bool = True,
) -> list[Polygon]:
    polygon_list = [polygon for polygon in polygons]
    if tolerance_m <= 0 or len(polygon_list) <= 1:
        return polygon_list

    simplified: list[Polygon]
    if shapely_coverage_simplify is not None:
        result = shapely_coverage_simplify(
            polygon_list,
            tolerance_m,
            simplify_boundary=simplify_boundary,
        )
        simplified = [polygon for polygon in result]
    else:
        simplified = [polygon.simplify(tolerance_m, preserve_topology=True) for polygon in polygon_list]

    if len(simplified) != len(polygon_list):
        return polygon_list

    cleaned: list[Polygon] = []
    for original, polygon in zip(polygon_list, simplified):
        if polygon.is_empty:
            cleaned.append(original)
            continue
        candidate = polygon if polygon.is_valid else polygon.buffer(0)
        if candidate.is_empty or candidate.area <= 0:
            cleaned.append(original)
            continue
        cleaned.append(candidate)
    return cleaned


def line_spacing_camera(
    altitude_agl: float,
    side_overlap: float,
    f_m: float,
    sx_m: float,
    sy_m: float,
    w_px: int,
    h_px: int,
    rotate_90: bool = False,
) -> float:
    gsd_x = (sx_m * altitude_agl) / f_m
    gsd_y = (sy_m * altitude_agl) / f_m
    across_px = h_px if rotate_90 else w_px
    across_gsd = gsd_y if rotate_90 else gsd_x
    return across_px * across_gsd * (1.0 - side_overlap / 100.0)


def forward_spacing_camera(
    altitude_agl: float,
    front_overlap: float,
    f_m: float,
    sx_m: float,
    sy_m: float,
    w_px: int,
    h_px: int,
    rotate_90: bool = False,
) -> float:
    gsd_x = (sx_m * altitude_agl) / f_m
    gsd_y = (sy_m * altitude_agl) / f_m
    along_px = w_px if rotate_90 else h_px
    along_gsd = gsd_x if rotate_90 else gsd_y
    return along_px * along_gsd * (1.0 - front_overlap / 100.0)


def calculate_gsd(altitude_agl: float, f_m: float, sx_m: float, sy_m: float) -> float:
    pixel_size = max(sx_m, sy_m)
    return (pixel_size * altitude_agl) / f_m


def lidar_swath_width(altitude_agl: float, mapping_fov_deg: float) -> float:
    half_angle_rad = deg_to_rad(mapping_fov_deg) / 2.0
    return 2.0 * altitude_agl * math.tan(half_angle_rad)


def lidar_line_spacing(altitude_agl: float, side_overlap: float, mapping_fov_deg: float) -> float:
    return lidar_swath_width(altitude_agl, mapping_fov_deg) * (1.0 - side_overlap / 100.0)


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6_371_000.0
    phi1 = deg_to_rad(a[1])
    phi2 = deg_to_rad(b[1])
    dphi = deg_to_rad(b[1] - a[1])
    dlambda = deg_to_rad(b[0] - a[0])
    sin_phi = math.sin(dphi / 2.0)
    sin_lam = math.sin(dlambda / 2.0)
    h = sin_phi * sin_phi + math.cos(phi1) * math.cos(phi2) * sin_lam * sin_lam
    return 2.0 * r * math.atan2(math.sqrt(h), math.sqrt(1.0 - h))


def project_extents(polygon: Polygon, bearing_deg: float) -> tuple[float, float]:
    coords = np.asarray(polygon.exterior.coords[:-1], dtype=np.float64)
    center = coords.mean(axis=0)
    bearing_rad = deg_to_rad(bearing_deg)
    ux = math.sin(bearing_rad)
    uy = math.cos(bearing_rad)
    px = math.sin(bearing_rad + math.pi / 2.0)
    py = math.cos(bearing_rad + math.pi / 2.0)
    offsets = coords - center
    along = offsets[:, 0] * ux + offsets[:, 1] * uy
    cross = offsets[:, 0] * px + offsets[:, 1] * py
    return max(1.0, along.max() - along.min()), max(1.0, cross.max() - cross.min())
