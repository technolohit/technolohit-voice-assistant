#!/usr/bin/env bash
# Self-contained Gate 3 compose/runtime preflight for the production host.
# Does not require a repository checkout. Uses the deployed voice-bridge image only.
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/opt/technolohit-voice/asterisk}"
AUTHORITATIVE_ENV="${AUTHORITATIVE_ENV:-/opt/technolohit-voice/voice-bridge/.env}"
COMPOSE_PROJECT_ENV="${COMPOSE_PROJECT_ENV:-${DEPLOY_PATH}/.env}"
RAW_COMPOSE_BASE="${RAW_COMPOSE_BASE:-${DEPLOY_PATH}/docker-compose.yml}"
RAW_COMPOSE_PROD="${RAW_COMPOSE_PROD:-${DEPLOY_PATH}/docker-compose.prod.yml}"
CONTAINER_NAME="${CONTAINER_NAME:-technolohit-voice-bridge}"
COMPOSE_FILES="${COMPOSE_FILES:--f docker-compose.yml -f docker-compose.prod.yml}"
TMP_DIR="${TMP_DIR:-$(mktemp -d)}"

GATE3_KEYS=(
  VOICE_RUNTIME_VERSION
  VOICE_V4_REALTIME_ENABLED
  VOICE_V4_CANARY_ENABLED
  VOICE_V4_LIVE_AUDIOSOCKET_ENABLED
  VOICE_RAG_ENABLED
  VOICE_RAG_SALES_ANSWERER_ENABLED
  VOICE_RAG_API_URL
)

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "compose_runtime_preflight=fail" >&2
  echo "failure_count=1" >&2
  echo "failures=$1" >&2
  exit 1
}

write_snapshot_from_env_file() {
  local src="$1"
  local dst="$2"
  : >"$dst"
  local key line
  for key in "${GATE3_KEYS[@]}"; do
    line="$(grep -E "^${key}=" "$src" 2>/dev/null | tail -n 1 || true)"
    if [ -n "$line" ]; then
      printf '%s\n' "$line" >>"$dst"
    fi
  done
  chmod 600 "$dst"
}

write_snapshot_from_compose_config() {
  local src="$1"
  local dst="$2"
  : >"$dst"
  local key value
  for key in "${GATE3_KEYS[@]}"; do
    value="$(awk -v key="$key" '
      $0 ~ /^  voice-bridge:/ { in_voice = 1; next }
      in_voice && /^  [A-Za-z0-9_.-]+:/ && $0 !~ /^  voice-bridge:/ { exit }
      in_voice && index($0, "      " key ":") == 1 {
        sub(/^[^:]*:[[:space:]]*/, "", $0)
        gsub(/^["'\''"]|["'\''"]$/, "", $0)
        print $0
        exit
      }
    ' "$src")"
    if [ -n "$value" ]; then
      printf '%s=%s\n' "$key" "$value" >>"$dst"
    fi
  done
  chmod 600 "$dst"
}

write_snapshot_from_container() {
  local dst="$1"
  : >"$dst"
  local key
  for key in "${GATE3_KEYS[@]}"; do
    docker exec "$CONTAINER_NAME" sh -lc "printf '%s=%s\n' '$key' \"\${$key:-}\"" >>"$dst"
  done
  chmod 600 "$dst"
}

write_compose_project_env_keys() {
  local src="$1"
  local dst="$2"
  if [ ! -f "$src" ]; then
    : >"$dst"
  else
    awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ { print $1 }' "$src" >"$dst"
  fi
  chmod 600 "$dst"
}

[ -f "$AUTHORITATIVE_ENV" ] || fail "authoritative_env_missing"
[ -f "$RAW_COMPOSE_BASE" ] || fail "raw_compose_missing:docker-compose.yml"
[ -f "$RAW_COMPOSE_PROD" ] || fail "raw_compose_missing:docker-compose.prod.yml"
docker inspect "$CONTAINER_NAME" >/dev/null 2>&1 || fail "container_missing"

RUNNING_IMAGE="$(docker inspect "$CONTAINER_NAME" --format '{{.Config.Image}}')"
AUTHORITATIVE_SNAPSHOT="${TMP_DIR}/authoritative-snapshot.env"
COMPOSE_RENDERED="${TMP_DIR}/compose-rendered.yml"
COMPOSE_SNAPSHOT="${TMP_DIR}/compose-snapshot.env"
CONTAINER_SNAPSHOT="${TMP_DIR}/container-snapshot.env"
PROJECT_ENV_KEYS="${TMP_DIR}/compose-project-env-keys.txt"

(
  cd "$DEPLOY_PATH"
  # shellcheck disable=SC2086
  docker compose $COMPOSE_FILES config >"$COMPOSE_RENDERED"
)

write_snapshot_from_env_file "$AUTHORITATIVE_ENV" "$AUTHORITATIVE_SNAPSHOT"
write_snapshot_from_compose_config "$COMPOSE_RENDERED" "$COMPOSE_SNAPSHOT"
write_snapshot_from_container "$CONTAINER_SNAPSHOT"
write_compose_project_env_keys "$COMPOSE_PROJECT_ENV" "$PROJECT_ENV_KEYS"

docker run --rm --user 0:0 \
  -v "${AUTHORITATIVE_SNAPSHOT}:/authoritative.env:ro" \
  -v "${COMPOSE_SNAPSHOT}:/compose-config.env:ro" \
  -v "${CONTAINER_SNAPSHOT}:/container-env.env:ro" \
  -v "${RAW_COMPOSE_BASE}:/raw/docker-compose.yml:ro" \
  -v "${RAW_COMPOSE_PROD}:/raw/docker-compose.prod.yml:ro" \
  -v "${PROJECT_ENV_KEYS}:/compose-project-env-keys.txt:ro" \
  "$RUNNING_IMAGE" \
  node scripts/compose-runtime-preflight.js \
    --gate3 \
    --authoritative-file /authoritative.env \
    --compose-config-file /compose-config.env \
    --container-env-file /container-env.env \
    --raw-compose-file /raw/docker-compose.yml \
    --raw-compose-file /raw/docker-compose.prod.yml \
    --compose-project-env-keys-file /compose-project-env-keys.txt
