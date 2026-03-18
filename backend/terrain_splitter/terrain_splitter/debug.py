from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def write_debug_artifacts(base_dir: Path, request_id: str, artifacts: dict[str, Any]) -> list[str]:
    output_dir = base_dir / request_id
    output_dir.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    for name, payload in artifacts.items():
        path = output_dir / f"{name}.json"
        with path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        paths.append(str(path))
    return paths
