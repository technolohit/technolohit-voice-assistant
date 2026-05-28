#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${VOICE_DOCKER_IMAGE:-thnhit/technhvoice}"

command -v docker >/dev/null 2>&1 || {
  echo "docker is required but was not found" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || {
  echo "git is required but was not found" >&2
  exit 1
}

docker info >/dev/null 2>&1 || {
  echo "docker is not running or the current user cannot access it" >&2
  exit 1
}

GIT_SHORT_SHA="${VOICE_BRIDGE_GIT_SHA:-$(git -C "$ROOT_DIR" rev-parse --short HEAD)}"
BUILD_VERSION="${BUILD_VERSION:-$GIT_SHORT_SHA}"
if [ -n "${VOICE_BRIDGE_VERSION_TAG:-}" ]; then
  TAGS=("voice-bridge-${VOICE_BRIDGE_VERSION_TAG}" "voice-bridge-${GIT_SHORT_SHA}" "voice-bridge-latest")
else
  TAGS=("voice-bridge-${GIT_SHORT_SHA}" "voice-bridge-latest")
fi

if [ "${VOICE_BRIDGE_PUSH_DEV:-false}" = "true" ]; then
  TAGS+=("voice-bridge-dev")
fi

VOICE_DOCKER_IMAGE="$IMAGE" BUILD_VERSION="$BUILD_VERSION" "$ROOT_DIR/scripts/docker/build-voice-bridge.sh" "${TAGS[@]}"
VOICE_DOCKER_IMAGE="$IMAGE" "$ROOT_DIR/scripts/docker/push-voice-bridge.sh" "${TAGS[@]}"
