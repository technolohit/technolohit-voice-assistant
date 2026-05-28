#!/usr/bin/env bash

set -euo pipefail

IMAGE="${VOICE_DOCKER_IMAGE:-thnhit/technhvoice}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

command -v docker >/dev/null 2>&1 || {
  echo "docker is required but was not found" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || {
  echo "git is required but was not found" >&2
  exit 1
}

GIT_SHORT_SHA="${VOICE_BRIDGE_GIT_SHA:-$(git -C "$ROOT_DIR" rev-parse --short HEAD)}"

TAGS=()
if [ "$#" -gt 0 ]; then
  TAGS=("$@")
else
  TAGS=("voice-bridge-${GIT_SHORT_SHA}" "voice-bridge-latest")
fi

docker info >/dev/null 2>&1 || {
  echo "docker is not running or the current user cannot access it" >&2
  exit 1
}

for tag in "${TAGS[@]}"; do
  docker push "${IMAGE}:${tag}"
done

echo
echo "Pushed:"
for tag in "${TAGS[@]}"; do
  echo "${IMAGE}:${tag}"
done
