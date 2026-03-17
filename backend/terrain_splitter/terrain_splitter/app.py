from __future__ import annotations

import logging
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .debug import write_debug_artifacts
from .features import compute_feature_field
from .grid import build_grid
from .mapbox_tiles import fetch_dem_for_ring
from .schemas import DebugArtifacts, PartitionSolveRequest, PartitionSolveResponse
from .solver_graphcut import solve_partition_hierarchy


BASE_DIR = Path(__file__).resolve().parents[1]
CACHE_DIR = BASE_DIR / ".cache"
DEBUG_DIR = BASE_DIR / ".debug"
logger = logging.getLogger("uvicorn.error")

app = FastAPI(title="Terrain Splitter Backend", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/partition/solve", response_model=PartitionSolveResponse)
def solve_partition(request: PartitionSolveRequest) -> PartitionSolveResponse:
    request_id = uuid.uuid4().hex[:12]
    started_at = time.perf_counter()
    logger.info(
        "[terrain-split-backend][%s] solve request start polygonId=%s payload=%s ringPoints=%d tradeoff=%s debug=%s",
        request_id,
        request.polygonId or "<none>",
        request.payloadKind,
        len(request.ring),
        request.tradeoff,
        request.debug,
    )
    try:
        stage_started_at = time.perf_counter()
        dem, zoom = fetch_dem_for_ring(request.ring, CACHE_DIR)
        fetch_dem_ms = (time.perf_counter() - stage_started_at) * 1000.0

        stage_started_at = time.perf_counter()
        grid = build_grid(request.ring, dem)
        build_grid_ms = (time.perf_counter() - stage_started_at) * 1000.0

        stage_started_at = time.perf_counter()
        feature_field = compute_feature_field(grid, dem)
        compute_features_ms = (time.perf_counter() - stage_started_at) * 1000.0

        stage_started_at = time.perf_counter()
        solutions = solve_partition_hierarchy(
            grid,
            feature_field,
            request.params,
            request.tradeoff,
            request_id=request_id,
            polygon_id=request.polygonId,
        )
        solve_ms = (time.perf_counter() - stage_started_at) * 1000.0

        debug_payload = None
        if request.debug:
            stage_started_at = time.perf_counter()
            artifacts = write_debug_artifacts(
                DEBUG_DIR,
                request_id,
                {
                    "request": request.model_dump(mode="json"),
                    "grid": {
                        "zoom": zoom,
                        "gridStepM": grid.grid_step_m,
                        "cellCount": len(grid.cells),
                        "edgeCount": len(grid.edges),
                    },
                    "features": {
                        "dominantPreferredBearingDeg": feature_field.dominant_preferred_bearing_deg,
                        "cellCount": len(feature_field.cells),
                        "cells": [
                            {
                                "index": cell.index,
                                "preferredBearingDeg": cell.preferred_bearing_deg,
                                "slopeMagnitude": cell.slope_magnitude,
                                "breakStrength": cell.break_strength,
                                "confidence": cell.confidence,
                            }
                            for cell in feature_field.cells
                        ],
                    },
                    "solutions": [solution.model_dump(mode="json") for solution in solutions],
                    "timing": {
                        "fetchDemMs": round(fetch_dem_ms, 3),
                        "buildGridMs": round(build_grid_ms, 3),
                        "computeFeaturesMs": round(compute_features_ms, 3),
                        "solveMs": round(solve_ms, 3),
                        "totalMs": round((time.perf_counter() - started_at) * 1000.0, 3),
                    },
                },
            )
            debug_artifacts_ms = (time.perf_counter() - stage_started_at) * 1000.0
            debug_payload = DebugArtifacts(requestId=request_id, artifactPaths=artifacts)
            for solution in solutions:
                solution.debug = debug_payload
        else:
            debug_artifacts_ms = 0.0

        total_ms = (time.perf_counter() - started_at) * 1000.0
        logger.info(
            "[terrain-split-backend][%s] solve request finished polygonId=%s payload=%s solutions=%d fetchDemMs=%.1f buildGridMs=%.1f computeFeaturesMs=%.1f solveMs=%.1f debugArtifactsMs=%.1f totalMs=%.1f",
            request_id,
            request.polygonId or "<none>",
            request.payloadKind,
            len(solutions),
            fetch_dem_ms,
            build_grid_ms,
            compute_features_ms,
            solve_ms,
            debug_artifacts_ms,
            total_ms,
        )

        return PartitionSolveResponse(
            requestId=request_id,
            solutions=solutions,
            debug=debug_payload,
        )
    except Exception as exc:  # noqa: BLE001
        total_ms = (time.perf_counter() - started_at) * 1000.0
        logger.exception(
            "[terrain-split-backend][%s] solve request failed polygonId=%s payload=%s totalMs=%.1f error=%s",
            request_id,
            request.polygonId or "<none>",
            request.payloadKind,
            total_ms,
            exc,
        )
        raise HTTPException(status_code=500, detail=str(exc)) from exc
