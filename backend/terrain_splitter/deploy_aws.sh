#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -z "${MAPBOX_TOKEN:-}" ]; then
  echo "MAPBOX_TOKEN must be set before deploying."
  exit 1
fi

DOCKER_SOCKET="${DOCKER_HOST:-unix://$HOME/.docker/run/docker.sock}"
export DOCKER_HOST="$DOCKER_SOCKET"

echo "Building terrain splitter Lambda with SAM..."
sam build --use-container

echo "Deploying terrain splitter Lambda..."
sam deploy --guided --parameter-overrides "MapboxToken=$MAPBOX_TOKEN"
