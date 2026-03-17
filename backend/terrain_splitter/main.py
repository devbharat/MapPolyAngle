from __future__ import annotations

from mangum import Mangum

from terrain_splitter.app import app


# Lambda Function URL / API Gateway entrypoint for the terrain splitter backend.
lambda_handler = Mangum(app, lifespan="off")
