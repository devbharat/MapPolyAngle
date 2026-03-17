# Terrain Splitter Backend

Local FastAPI service for terrain-aware polygon partitioning.

## Local setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e "backend/terrain_splitter[test]"
export MAPBOX_TOKEN=...
npm run backend:terrain-splitter
```

The frontend will call this service when:

```bash
export VITE_TERRAIN_PARTITION_BACKEND_URL=http://127.0.0.1:8090
```

## Debug artifacts

When `debug=true` in the solve request, artifacts are written under:

- `backend/terrain_splitter/.debug/`

Fetched terrain tiles are cached under:

- `backend/terrain_splitter/.cache/`
