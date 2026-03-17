from __future__ import annotations

from shapely.geometry import box

from terrain_splitter.features import CellFeatures, FeatureField
from terrain_splitter.grid import GridCell, GridData, GridEdge
from terrain_splitter.schemas import FlightParamsModel
from terrain_splitter.solver_graphcut import solve_partition_hierarchy


def _toy_grid() -> GridData:
    cells = [
        GridCell(index=0, row=0, col=0, x=0, y=10, lng=0, lat=0, area_m2=100, terrain_z=100, polygon=box(0, 10, 10, 20)),
        GridCell(index=1, row=0, col=1, x=10, y=10, lng=0, lat=0, area_m2=100, terrain_z=105, polygon=box(10, 10, 20, 20)),
        GridCell(index=2, row=1, col=0, x=0, y=0, lng=0, lat=0, area_m2=100, terrain_z=120, polygon=box(0, 0, 10, 10)),
        GridCell(index=3, row=1, col=1, x=10, y=0, lng=0, lat=0, area_m2=100, terrain_z=125, polygon=box(10, 0, 20, 10)),
    ]
    edges = [
        GridEdge(a=0, b=1, shared_boundary_m=10),
        GridEdge(a=0, b=2, shared_boundary_m=10),
        GridEdge(a=1, b=3, shared_boundary_m=10),
        GridEdge(a=2, b=3, shared_boundary_m=10),
    ]
    return GridData(
        ring=[(0, 0), (0, 1), (1, 1), (1, 0), (0, 0)],
        polygon_mercator=box(0, 0, 20, 20),
        cells=cells,
        edges=edges,
        grid_step_m=10,
        area_m2=400,
    )


def test_solver_returns_coarse_to_fine_options_for_multimodal_grid() -> None:
    grid = _toy_grid()
    feature_field = FeatureField(
        cells=[
            CellFeatures(index=0, preferred_bearing_deg=0, slope_magnitude=0.3, break_strength=18, confidence=0.9, aspect_deg=270),
            CellFeatures(index=1, preferred_bearing_deg=0, slope_magnitude=0.25, break_strength=18, confidence=0.85, aspect_deg=270),
            CellFeatures(index=2, preferred_bearing_deg=90, slope_magnitude=0.28, break_strength=18, confidence=0.88, aspect_deg=0),
            CellFeatures(index=3, preferred_bearing_deg=90, slope_magnitude=0.26, break_strength=18, confidence=0.86, aspect_deg=0),
        ],
        dominant_preferred_bearing_deg=45,
    )
    params = FlightParamsModel(payloadKind="camera", altitudeAGL=120, frontOverlap=70, sideOverlap=70, cameraKey="MAP61_17MM")
    solutions = solve_partition_hierarchy(grid, feature_field, params)
    assert solutions
    assert solutions[0].regionCount >= 2
    assert any(solution.isFirstPracticalSplit for solution in solutions)


def test_solver_frontier_contains_face_aligned_quality_solution() -> None:
    grid = _toy_grid()
    feature_field = FeatureField(
        cells=[
            CellFeatures(index=0, preferred_bearing_deg=0, slope_magnitude=0.3, break_strength=18, confidence=0.9, aspect_deg=270),
            CellFeatures(index=1, preferred_bearing_deg=0, slope_magnitude=0.25, break_strength=18, confidence=0.85, aspect_deg=270),
            CellFeatures(index=2, preferred_bearing_deg=90, slope_magnitude=0.28, break_strength=18, confidence=0.88, aspect_deg=0),
            CellFeatures(index=3, preferred_bearing_deg=90, slope_magnitude=0.26, break_strength=18, confidence=0.86, aspect_deg=0),
        ],
        dominant_preferred_bearing_deg=45,
    )
    params = FlightParamsModel(payloadKind="camera", altitudeAGL=120, frontOverlap=70, sideOverlap=70, cameraKey="MAP61_17MM")
    solutions = solve_partition_hierarchy(grid, feature_field, params)
    assert any(solution.normalizedQualityCost < 0.1 for solution in solutions)
    assert any(
        sorted(round(region.bearingDeg) % 180 for region in solution.regions) == [0, 90]
        for solution in solutions
    )
