#!/usr/bin/env bash

set -euo pipefail

IMAGE="${VOICE_DOCKER_IMAGE:-thnhit/technhvoice}"

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <tag> [tag ...]" >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || {
  echo "docker is required but was not found" >&2
  exit 1
}

for tag in "$@"; do
  docker push "${IMAGE}:${tag}"
done
