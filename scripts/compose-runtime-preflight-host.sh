#!/usr/bin/env bash
# Host-side compose/runtime preflight (no repo checkout required).
# PREFLIGHT_MODE=baseline  -> Stage A: ownership + effective match while v3/RAG-off
# PREFLIGHT_MODE=gate3     -> Gate 3 only: requires v4/RAG-on values
set -euo pipefail

PREFLIGHT_MODE="${PREFLIGHT_MODE:-baseline}"
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

write_gate3_snapshot_from_env_file() {
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

write_runtime_snapshot_from_env_file() {
  local src="$1"
  local dst="$2"
  if grep -E '^VOICE_[A-Z0-9_]+=' "$src" >/dev/null 2>&1; then
    grep -E '^VOICE_[A-Z0-9_]+=' "$src" | sed 's/\r$//' >"$dst"
  else
    : >"$dst"
  fi
  chmod 600 "$dst"
}

lookup_compose_voice_bridge_value() {
  local src="$1"
  local key="$2"
  awk -v key="$key" '
    $0 ~ /^  voice-bridge:/ { in_voice = 1; next }
    in_voice && /^  [A-Za-z0-9_.-]+:/ && $0 !~ /^  voice-bridge:/ { exit }
    in_voice && index($0, "      " key ":") == 1 {
      sub(/^[^:]*:[[:space:]]*/, "", $0)
      gsub(/^["'\''"]|["'\''"]$/, "", $0)
      print $0
      exit
    }
  ' "$src"
}

write_snapshot_from_compose_config() {
  local src="$1"
  local keys_file="$2"
  local dst="$3"
  : >"$dst"
  local key value
  while IFS= read -r key || [ -n "$key" ]; do
    [ -z "$key" ] && continue
    value="$(lookup_compose_voice_bridge_value "$src" "$key")"
    if [ -n "$value" ]; then
      printf '%s=%s\n' "$key" "$value" >>"$dst"
    fi
  done < <(grep -E '^VOICE_[A-Z0-9_]+=' "$keys_file" | cut -d= -f1 | sort -u)
  chmod 600 "$dst"
}

write_gate3_snapshot_from_compose_config() {
  local src="$1"
  local dst="$2"
  : >"$dst"
  local key value
  for key in "${GATE3_KEYS[@]}"; do
    value="$(lookup_compose_voice_bridge_value "$src" "$key")"
    if [ -n "$value" ]; then
      printf '%s=%s\n' "$key" "$value" >>"$dst"
    fi
  done
  chmod 600 "$dst"
}

write_snapshot_from_container() {
  local keys_file="$1"
  local dst="$2"
  : >"$dst"
  local key
  while IFS= read -r key || [ -n "$key" ]; do
    [ -z "$key" ] && continue
    docker exec "$CONTAINER_NAME" sh -lc "printf '%s=%s\n' '$key' \"\${$key:-}\"" >>"$dst"
  done < <(grep -E '^VOICE_[A-Z0-9_]+=' "$keys_file" | cut -d= -f1 | sort -u)
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

if [ "$PREFLIGHT_MODE" != "baseline" ] && [ "$PREFLIGHT_MODE" != "gate3" ]; then
  fail "invalid_preflight_mode"
fi

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

if [ "$PREFLIGHT_MODE" = "gate3" ]; then
  write_gate3_snapshot_from_env_file "$AUTHORITATIVE_ENV" "$AUTHORITATIVE_SNAPSHOT"
  write_gate3_snapshot_from_compose_config "$COMPOSE_RENDERED" "$COMPOSE_SNAPSHOT"
  write_snapshot_from_container "$AUTHORITATIVE_SNAPSHOT" "$CONTAINER_SNAPSHOT"
  PREFLIGHT_FLAG="--gate3"
else
  write_runtime_snapshot_from_env_file "$AUTHORITATIVE_ENV" "$AUTHORITATIVE_SNAPSHOT"
  write_snapshot_from_compose_config "$COMPOSE_RENDERED" "$AUTHORITATIVE_SNAPSHOT" "$COMPOSE_SNAPSHOT"
  write_snapshot_from_container "$AUTHORITATIVE_SNAPSHOT" "$CONTAINER_SNAPSHOT"
  PREFLIGHT_FLAG="--baseline"
fi

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
    "$PREFLIGHT_FLAG" \
    --authoritative-file /authoritative.env \
    --compose-config-file /compose-config.env \
    --container-env-file /container-env.env \
    --raw-compose-file /raw/docker-compose.yml \
    --raw-compose-file /raw/docker-compose.prod.yml \
    --compose-project-env-keys-file /compose-project-env-keys.txt
