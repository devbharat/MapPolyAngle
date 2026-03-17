from __future__ import annotations

from shapely.geometry import box

from terrain_splitter.costs import RegionObjective
from terrain_splitter.features import CellFeatures, FeatureField
from terrain_splitter.grid import GridCell, GridData, GridEdge
from terrain_splitter.schemas import FlightParamsModel
from terrain_splitter.solver_graphcut import solve_partition_hierarchy
from terrain_splitter.solver_frontier import (
    BoundaryStats,
    EvaluatedRegion,
    RootSplitTask,
    SubtreeSolveTask,
    SolverContext,
    _deserialize_partition_plan,
    _feature_lookup,
    _neighbor_lookup,
    _pareto_frontier,
    _plan_from_regions,
    _serialize_partition_plan,
    _serialize_solver_context,
    _solve_root_split_branch_with_context,
    _solve_subtree_task_with_context,
    _cell_lookup,
    solve_root_split_branch_event,
    solve_subtree_task_event,
)


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


def test_solver_parallel_root_path_matches_serial_frontier() -> None:
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

    serial = solve_partition_hierarchy(grid, feature_field, params, root_parallel_workers=0)
    parallel = solve_partition_hierarchy(grid, feature_field, params, root_parallel_workers=2)
    subtree_parallel = solve_partition_hierarchy(
        grid,
        feature_field,
        params,
        root_parallel_workers=2,
        root_parallel_granularity="subtree",
    )

    def summarize(solution_list):
        return [
            (
                solution.regionCount,
                round(solution.totalMissionTimeSec, 6),
                round(solution.normalizedQualityCost, 6),
                tuple(
                    (
                        round(region.areaM2, 6),
                        round(region.bearingDeg, 6),
                        tuple((round(lng, 8), round(lat, 8)) for lng, lat in region.ring),
                    )
                    for region in solution.regions
                ),
            )
            for solution in solution_list
        ]

    assert summarize(serial) == summarize(parallel)
    assert summarize(serial) == summarize(subtree_parallel)


def test_lambda_root_split_worker_event_matches_direct_branch_solver() -> None:
    grid = _toy_grid()
    feature_field = FeatureField(
        cells=[
            CellFeatures(index=0, preferred_bearing_deg=0, slope_magnitude=0.3, break_strength=18, confidence=0.9, aspect_deg=270),
            CellFeatures(index=1, preferred_bearing_deg=0, slope_magnitude=0.25, break_strength=18, confidence=0.85, aspect_deg=270),
            CellFeatures(index=2, preferred_bearing_deg=90, slope_magnitude=0.28, break_strength=18, confidence=0.88, aspect_deg=0),
            CellFeatures(index=3, preferred_bearing_deg=90, slope_magnitude=0.26, break_strength=18, confidence=0.86, aspect_deg=0),
        ],
        dominant_preferred_bearing_deg=45,
        dominant_aspect_deg=315,
    )
    params = FlightParamsModel(payloadKind="camera", altitudeAGL=120, frontOverlap=70, sideOverlap=70, cameraKey="MAP61_17MM")
    context = SolverContext(
        grid=grid,
        feature_field=feature_field,
        params=params,
        root_area_m2=max(1.0, grid.area_m2),
        feature_lookup=_feature_lookup(feature_field),
        cell_lookup=_cell_lookup(grid),
        neighbors=_neighbor_lookup(grid),
    )
    task = RootSplitTask(
        left_ids=(0, 1),
        right_ids=(2, 3),
        boundary=BoundaryStats(shared_boundary_m=10.0, break_weight_sum=25.0),
        depth=1,
    )

    direct_frontier, _ = _solve_root_split_branch_with_context(task, context)
    worker_payload = {
        "context": _serialize_solver_context(context),
        "task": {
            "leftIds": list(task.left_ids),
            "rightIds": list(task.right_ids),
            "boundary": {"sharedBoundaryM": task.boundary.shared_boundary_m, "breakWeightSum": task.boundary.break_weight_sum},
            "depth": task.depth,
        },
    }
    worker_result = solve_root_split_branch_event(worker_payload)
    worker_frontier = [_deserialize_partition_plan(plan) for plan in worker_result["plans"]]

    assert [_serialize_partition_plan(plan) for plan in direct_frontier] == [
        _serialize_partition_plan(plan) for plan in worker_frontier
    ]


def test_lambda_subtree_worker_event_matches_direct_subtree_solver() -> None:
    grid = _toy_grid()
    feature_field = FeatureField(
        cells=[
            CellFeatures(index=0, preferred_bearing_deg=0, slope_magnitude=0.3, break_strength=18, confidence=0.9, aspect_deg=270),
            CellFeatures(index=1, preferred_bearing_deg=0, slope_magnitude=0.25, break_strength=18, confidence=0.85, aspect_deg=270),
            CellFeatures(index=2, preferred_bearing_deg=90, slope_magnitude=0.28, break_strength=18, confidence=0.88, aspect_deg=0),
            CellFeatures(index=3, preferred_bearing_deg=90, slope_magnitude=0.26, break_strength=18, confidence=0.86, aspect_deg=0),
        ],
        dominant_preferred_bearing_deg=45,
        dominant_aspect_deg=315,
    )
    params = FlightParamsModel(payloadKind="camera", altitudeAGL=120, frontOverlap=70, sideOverlap=70, cameraKey="MAP61_17MM")
    context = SolverContext(
        grid=grid,
        feature_field=feature_field,
        params=params,
        root_area_m2=max(1.0, grid.area_m2),
        feature_lookup=_feature_lookup(feature_field),
        cell_lookup=_cell_lookup(grid),
        neighbors=_neighbor_lookup(grid),
    )
    task = SubtreeSolveTask(cell_ids=(0, 1), depth=1)

    direct_frontier, _ = _solve_subtree_task_with_context(task, context)
    worker_payload = {
        "context": _serialize_solver_context(context),
        "task": {
            "cellIds": list(task.cell_ids),
            "depth": task.depth,
        },
    }
    worker_result = solve_subtree_task_event(worker_payload)
    worker_frontier = [_deserialize_partition_plan(plan) for plan in worker_result["plans"]]

    assert [_serialize_partition_plan(plan) for plan in direct_frontier] == [
        _serialize_partition_plan(plan) for plan in worker_frontier
    ]


def _mock_region(area_m2: float, mean_line_length_m: float, *, region_id: int, bearing_deg: float = 0.0) -> EvaluatedRegion:
    objective = RegionObjective(
        bearing_deg=bearing_deg,
        normalized_quality_cost=1.0,
        total_mission_time_sec=100.0,
        weighted_mean_mismatch_deg=5.0,
        area_m2=area_m2,
        convexity=0.92,
        compactness=1.4,
        boundary_break_alignment=0.0,
        flight_line_count=12,
        line_spacing_m=72.0,
        along_track_length_m=500.0,
        cross_track_width_m=300.0,
        fragmented_line_fraction=0.05,
        overflight_transit_fraction=0.0,
        short_line_fraction=0.1,
        mean_line_length_m=mean_line_length_m,
        median_line_length_m=max(mean_line_length_m, 260.0),
        mean_line_lift_m=40.0,
        p90_line_lift_m=80.0,
        max_line_lift_m=120.0,
        elevated_area_fraction=0.2,
        severe_lift_area_fraction=0.05,
    )
    return EvaluatedRegion(
        cell_ids=(region_id,),
        polygon=box(0, 0, 10, 10),
        ring=[(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)],
        objective=objective,
        score=objective.normalized_quality_cost,
        hard_invalid=False,
    )


def test_pareto_frontier_preserves_practical_plan_against_non_practical_dominator() -> None:
    root_area_m2 = 1_000.0
    baseline = _plan_from_regions((_mock_region(1_000.0, 600.0, region_id=1),), 0.0, 0.0)

    practical = _plan_from_regions(
        (
            _mock_region(500.0, 260.0, region_id=2, bearing_deg=0.0),
            _mock_region(500.0, 255.0, region_id=3, bearing_deg=90.0),
        ),
        0.0,
        0.0,
    )
    non_practical = _plan_from_regions(
        (
            _mock_region(500.0, 260.0, region_id=4, bearing_deg=0.0),
            _mock_region(500.0, 180.0, region_id=5, bearing_deg=90.0),
        ),
        0.0,
        0.0,
    )
    practical = practical.__class__(
        regions=practical.regions,
        quality_cost=5.0,
        mission_time_sec=1_000.0,
        weighted_mean_mismatch_deg=practical.weighted_mean_mismatch_deg,
        internal_boundary_m=practical.internal_boundary_m,
        break_weight_sum=practical.break_weight_sum,
        largest_region_fraction=practical.largest_region_fraction,
        mean_convexity=practical.mean_convexity,
        region_count=practical.region_count,
    )
    non_practical = non_practical.__class__(
        regions=non_practical.regions,
        quality_cost=4.0,
        mission_time_sec=900.0,
        weighted_mean_mismatch_deg=non_practical.weighted_mean_mismatch_deg,
        internal_boundary_m=non_practical.internal_boundary_m,
        break_weight_sum=non_practical.break_weight_sum,
        largest_region_fraction=non_practical.largest_region_fraction,
        mean_convexity=non_practical.mean_convexity,
        region_count=non_practical.region_count,
    )

    frontier = _pareto_frontier([baseline, practical, non_practical], root_area_m2)
    assert any(plan.region_count == 2 and abs(plan.quality_cost - 5.0) < 1e-6 for plan in frontier)
