from __future__ import annotations

from mangum import Mangum

from terrain_splitter.app import app
from terrain_splitter.solver_frontier import solve_root_split_branch_event


# Lambda Function URL / API Gateway entrypoint for the terrain splitter backend.
_http_handler = Mangum(app, lifespan="off")


def lambda_handler(event, context):  # noqa: ANN001
    if isinstance(event, dict) and event.get("terrainSplitterInternal") == "root-split":
        return solve_root_split_branch_event(event["payload"])
    return _http_handler(event, context)
