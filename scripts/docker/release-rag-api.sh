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

GIT_SHORT_SHA="${RAG_API_GIT_SHA:-$(git -C "$ROOT_DIR" rev-parse --short HEAD)}"
BUILD_VERSION="${BUILD_VERSION:-$GIT_SHORT_SHA}"
if [ -n "${RAG_API_VERSION_TAG:-}" ]; then
  TAGS=("rag-api-${RAG_API_VERSION_TAG}" "rag-api-${GIT_SHORT_SHA}" "rag-api-latest")
else
  TAGS=("rag-api-${GIT_SHORT_SHA}" "rag-api-latest")
fi

if [ "${RAG_API_PUSH_DEV:-false}" = "true" ]; then
  TAGS+=("rag-api-dev")
fi

VOICE_DOCKER_IMAGE="$IMAGE" BUILD_VERSION="$BUILD_VERSION" "$ROOT_DIR/scripts/docker/build-rag-api.sh" "${TAGS[@]}"
VOICE_DOCKER_IMAGE="$IMAGE" "$ROOT_DIR/scripts/docker/push-rag-api.sh" "${TAGS[@]}"
