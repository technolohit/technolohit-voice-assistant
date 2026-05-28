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
  TAGS=("voice-bridge-${GIT_SHORT_SHA}")
fi

IMAGE_TAG="${IMAGE_TAG:-${TAGS[0]}}"
BUILD_VERSION="${BUILD_VERSION:-$IMAGE_TAG}"

docker info >/dev/null 2>&1 || {
  echo "docker is not running or the current user cannot access it" >&2
  exit 1
}

DOCKER_TAG_ARGS=()
for tag in "${TAGS[@]}"; do
  DOCKER_TAG_ARGS+=("-t" "${IMAGE}:${tag}")
done

docker build \
  --build-arg "BUILD_VERSION=${BUILD_VERSION}" \
  --build-arg "IMAGE_TAG=${IMAGE_TAG}" \
  --build-arg "GIT_SHA=${GIT_SHORT_SHA}" \
  "${DOCKER_TAG_ARGS[@]}" \
  "$ROOT_DIR/voice-bridge"

echo
echo "Built:"
for tag in "${TAGS[@]}"; do
  echo "${IMAGE}:${tag}"
done
echo "Build metadata:"
echo "  BUILD_VERSION=${BUILD_VERSION}"
echo "  IMAGE_TAG=${IMAGE_TAG}"
echo "  GIT_SHA=${GIT_SHORT_SHA}"
