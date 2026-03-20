#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CONFIG_ENV="${1:-${SAM_CONFIG_ENV:-default}}"

if [ -z "${MAPBOX_TOKEN:-}" ]; then
  echo "MAPBOX_TOKEN must be set before deploying."
  exit 1
fi

DOCKER_SOCKET="${DOCKER_HOST:-unix://$HOME/.docker/run/docker.sock}"
export DOCKER_HOST="$DOCKER_SOCKET"

echo "Building terrain splitter Lambda with SAM (config env: $CONFIG_ENV)..."
sam build --config-env "$CONFIG_ENV" --use-container

echo "Deploying terrain splitter Lambda (config env: $CONFIG_ENV)..."
sam deploy --config-env "$CONFIG_ENV" --parameter-overrides "MapboxToken=$MAPBOX_TOKEN"
