from __future__ import annotations

from shapely.geometry import box

from terrain_splitter.costs import evaluate_region_objective, evaluate_sensor_node_cost
from terrain_splitter.features import CellFeatures
from terrain_splitter.grid import GridCell
from terrain_splitter.schemas import FlightParamsModel


def test_lidar_hole_risk_is_worse_than_low_density_only() -> None:
    params = FlightParamsModel(
        payloadKind="lidar",
        altitudeAGL=120,
        sideOverlap=35,
        speedMps=16,
        mappingFovDeg=90,
        maxLidarRangeM=120,
        lidarReturnMode="single",
    )
    weak = evaluate_sensor_node_cost(0, 0.18, 0.8, 25, params)
    hole = evaluate_sensor_node_cost(0, 0.65, 0.9, 85, params)
    assert hole.hole_risk > weak.hole_risk
    assert hole.quality_cost > weak.quality_cost


def test_line_lift_penalty_makes_peak_region_more_expensive() -> None:
    params = FlightParamsModel(payloadKind="lidar", altitudeAGL=100, sideOverlap=30, speedMps=16, mappingFovDeg=90, maxLidarRangeM=160)
    base_cells = [
        GridCell(index=0, row=0, col=0, x=0, y=0, lng=0, lat=0, area_m2=100, terrain_z=100, polygon=box(0, 0, 10, 10)),
        GridCell(index=1, row=0, col=1, x=10, y=0, lng=0, lat=0, area_m2=100, terrain_z=100, polygon=box(10, 0, 20, 10)),
        GridCell(index=2, row=0, col=2, x=20, y=0, lng=0, lat=0, area_m2=100, terrain_z=100, polygon=box(20, 0, 30, 10)),
    ]
    ridge_cells = [
        GridCell(index=0, row=0, col=0, x=0, y=0, lng=0, lat=0, area_m2=100, terrain_z=100, polygon=box(0, 0, 10, 10)),
        GridCell(index=1, row=0, col=1, x=10, y=0, lng=0, lat=0, area_m2=100, terrain_z=165, polygon=box(10, 0, 20, 10)),
        GridCell(index=2, row=0, col=2, x=20, y=0, lng=0, lat=0, area_m2=100, terrain_z=100, polygon=box(20, 0, 30, 10)),
    ]
    features = {
        idx: CellFeatures(index=idx, preferred_bearing_deg=0, slope_magnitude=0.25, break_strength=6, confidence=0.9, aspect_deg=270)
        for idx in range(3)
    }
    base = evaluate_region_objective(base_cells, features, 0, params, box(0, 0, 30, 10), 0.0)
    ridge = evaluate_region_objective(ridge_cells, features, 0, params, box(0, 0, 30, 10), 0.0)
    assert ridge.normalized_quality_cost > base.normalized_quality_cost
