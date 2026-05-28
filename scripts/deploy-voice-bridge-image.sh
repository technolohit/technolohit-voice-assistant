#!/usr/bin/env bash

set -euo pipefail

EXPECTED_IMAGE="${1:-}"
if [ -z "$EXPECTED_IMAGE" ]; then
  echo "Usage: $0 <expected-voice-bridge-image>" >&2
  exit 1
fi

if [ ! -f ".env" ]; then
  echo "ERROR: .env not found in current directory: $(pwd)" >&2
  exit 1
fi

if [ ! -f "docker-compose.yml" ] || [ ! -f "docker-compose.prod.yml" ] || [ ! -f "docker-compose.gate6-rollout.yml" ]; then
  echo "ERROR: required compose files are missing in current directory" >&2
  echo "Required: docker-compose.yml docker-compose.prod.yml docker-compose.gate6-rollout.yml" >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || {
  echo "ERROR: docker is required but not found" >&2
  exit 1
}

backup_env() {
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local backup_file=".env.backup.${ts}"
  cp .env "$backup_file"
  echo "Backup created: $backup_file"
}

set_env_var() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  if grep -qE "^${key}=" .env; then
    awk -v k="$key" -v v="$value" '
      BEGIN { replaced = 0 }
      $0 ~ ("^" k "=") {
        if (replaced == 0) {
          print k "=" v
          replaced = 1
        }
        next
      }
      { print }
      END {
        if (replaced == 0) {
          print k "=" v
        }
      }
    ' .env > "$tmp"
  else
    cp .env "$tmp"
    printf "%s=%s\n" "$key" "$value" >> "$tmp"
  fi
  mv "$tmp" .env
}

COMPOSE_ARGS=(
  -f docker-compose.yml
  -f docker-compose.prod.yml
  -f docker-compose.gate6-rollout.yml
)

run_compose() {
  env -u VOICE_BRIDGE_IMAGE -u RAG_API_IMAGE docker compose "${COMPOSE_ARGS[@]}" "$@"
}

backup_env
set_env_var "VOICE_BRIDGE_IMAGE" "$EXPECTED_IMAGE"

echo "Pulling expected image: $EXPECTED_IMAGE"
docker pull "$EXPECTED_IMAGE"

echo "Validating merged compose config image..."
CONFIG_OUTPUT="$(run_compose config)"
CONFIG_IMAGE="$(printf "%s\n" "$CONFIG_OUTPUT" | awk '
  $1 == "voice-bridge:" { in_voice = 1; next }
  in_voice && $1 == "image:" { print $2; exit }
  in_voice && /^[^[:space:]]/ { in_voice = 0 }
')"

if [ -z "$CONFIG_IMAGE" ]; then
  echo "ERROR: could not resolve voice-bridge image from merged compose config" >&2
  exit 1
fi

if [ "$CONFIG_IMAGE" != "$EXPECTED_IMAGE" ]; then
  echo "ERROR: compose config image mismatch" >&2
  echo "Expected: $EXPECTED_IMAGE" >&2
  echo "Actual:   $CONFIG_IMAGE" >&2
  exit 1
fi

echo "Recreating voice-bridge service..."
run_compose up -d --force-recreate voice-bridge

RUNNING_IMAGE="$(docker inspect technolohit-voice-bridge --format '{{.Config.Image}}' 2>/dev/null || true)"
if [ "$RUNNING_IMAGE" != "$EXPECTED_IMAGE" ]; then
  echo "ERROR: running container image mismatch for technolohit-voice-bridge" >&2
  echo "Expected: $EXPECTED_IMAGE" >&2
  echo "Actual:   ${RUNNING_IMAGE:-<missing container>}" >&2
  exit 1
fi

echo "Deployment valid. Running image: $RUNNING_IMAGE"
echo "Runtime env (technolohit-voice-bridge):"
docker exec technolohit-voice-bridge sh -lc '
  echo "VOICE_RAG_ENABLED=${VOICE_RAG_ENABLED:-unset}"
  echo "VOICE_RAG_API_URL=${VOICE_RAG_API_URL:-unset}"
  echo "VOICE_RAG_QA_MODE=${VOICE_RAG_QA_MODE:-unset}"
  echo "VOICE_LOG_TRANSCRIPT_PREVIEW=${VOICE_LOG_TRANSCRIPT_PREVIEW:-unset}"
  echo "VOICE_QA_LOG_TRANSCRIPT_PREVIEW=${VOICE_QA_LOG_TRANSCRIPT_PREVIEW:-unset}"
'
