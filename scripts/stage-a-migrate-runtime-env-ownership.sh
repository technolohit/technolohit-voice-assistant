#!/usr/bin/env bash
# Idempotent Stage A ownership migration for production (safe v3/RAG-off).
# Moves forbidden voice-bridge runtime keys from asterisk/.env -> voice-bridge/.env
# and strips them from raw Compose voice-bridge environment blocks.
#
# Usage:
#   DRY_RUN=true  bash stage-a-migrate-runtime-env-ownership.sh   # audit only
#   bash stage-a-migrate-runtime-env-ownership.sh                 # apply
set -eo pipefail

export TMPDIR="${TMPDIR:-/tmp}"

RELEASE_REF="${RELEASE_REF:-v1.34.0}"
GITHUB_RAW_BASE="${GITHUB_RAW_BASE:-https://raw.githubusercontent.com/technolohit/technolohit-voice-assistant/${RELEASE_REF}/scripts}"
DRY_RUN="${DRY_RUN:-false}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/technolohit-voice/asterisk}"
AUTH_ENV="${AUTH_ENV:-/opt/technolohit-voice/voice-bridge/.env}"
AST_ENV="${AST_ENV:-${DEPLOY_PATH}/.env}"
COMPOSE_BASE="${COMPOSE_BASE:-${DEPLOY_PATH}/docker-compose.yml}"
COMPOSE_PROD="${COMPOSE_PROD:-${DEPLOY_PATH}/docker-compose.prod.yml}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEYS_FILE="${KEYS_FILE:-${SCRIPT_DIR}/forbidden-voice-bridge-runtime-keys.txt}"
DOWNLOADED_KEYS=""

log() {
  printf '[stage-a-migrate] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

cleanup() {
  if [ -n "$DOWNLOADED_KEYS" ] && [ -f "$DOWNLOADED_KEYS" ]; then
    rm -f "$DOWNLOADED_KEYS"
  fi
}
trap cleanup EXIT

ensure_keys_file() {
  if [ -f "$KEYS_FILE" ]; then
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    fail "keys file missing at ${KEYS_FILE} and curl unavailable"
  fi
  DOWNLOADED_KEYS="$(mktemp "${TMPDIR}/forbidden-voice-bridge-runtime-keys.XXXXXX")"
  curl -fsSL "${GITHUB_RAW_BASE}/forbidden-voice-bridge-runtime-keys.txt" -o "$DOWNLOADED_KEYS"
  KEYS_FILE="$DOWNLOADED_KEYS"
  log "downloaded keys file from ${GITHUB_RAW_BASE}"
}

backup_files() {
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local auth_bak="${AUTH_ENV}.pre-stage-a-${stamp}.bak"
  local ast_bak="${AST_ENV}.pre-stage-a-${stamp}.bak"
  local compose_bak="${COMPOSE_BASE}.pre-stage-a-${stamp}.bak"

  if [ "$DRY_RUN" = true ]; then
    log "DRY_RUN: would backup to ${auth_bak}, ${ast_bak}, ${compose_bak}"
    return 0
  fi

  cp -a "$AUTH_ENV" "$auth_bak"
  cp -a "$AST_ENV" "$ast_bak"
  cp -a "$COMPOSE_BASE" "$compose_bak"
  if [ -f "$COMPOSE_PROD" ]; then
    cp -a "$COMPOSE_PROD" "${COMPOSE_PROD}.pre-stage-a-${stamp}.bak"
  fi
  log "backups created with stamp ${stamp}"
}

migrate_project_env_key() {
  local key="$1"
  local line

  line="$(grep -E "^${key}=" "$AST_ENV" 2>/dev/null | tail -n 1 || true)"
  [ -z "$line" ] && return 0

  if ! grep -qE "^${key}=" "$AUTH_ENV" 2>/dev/null; then
    if [ "$DRY_RUN" = true ]; then
      log "DRY_RUN: would append ${key} to ${AUTH_ENV}"
    else
      printf '%s\n' "$line" >>"$AUTH_ENV"
      log "appended ${key} to ${AUTH_ENV}"
    fi
  else
    log "kept existing ${key} in ${AUTH_ENV}; removing duplicate from ${AST_ENV}"
  fi

  if [ "$DRY_RUN" = true ]; then
    log "DRY_RUN: would remove ${key} from ${AST_ENV}"
  else
    sed -i "/^${key}=/d" "$AST_ENV"
    log "removed ${key} from ${AST_ENV}"
  fi
}

migrate_asterisk_env() {
  local key moved=0
  while IFS= read -r key || [ -n "$key" ]; do
    [ -z "$key" ] && continue
    case "$key" in \#*) continue ;; esac
    if grep -qE "^${key}=" "$AST_ENV" 2>/dev/null; then
      migrate_project_env_key "$key"
      moved=$((moved + 1))
    fi
  done <"$KEYS_FILE"
  log "asterisk/.env migration complete (touched ${moved} keys if present)"
}

strip_compose_environment() {
  local file="$1"
  local tmp out
  [ -f "$file" ] || return 0

  tmp="$(mktemp "${TMPDIR}/compose-strip.XXXXXX")"
  awk -v keysfile="$KEYS_FILE" '
    BEGIN {
      while ((getline line < keysfile) > 0) {
        if (line == "" || substr(line, 1, 1) == "#") continue
        forbidden[line] = 1
      }
      close(keysfile)
      approved["BUILD_VERSION"] = 1
      approved["IMAGE_TAG"] = 1
    }
    function env_key_from_map(line,   m) {
      if (match(line, /^      ([A-Z0-9_]+):[[:space:]]*/, m)) return m[1]
      return ""
    }
    function env_key_from_list(line,   m) {
      if (match(line, /^      - ([A-Z0-9_]+)=/, m)) return m[1]
      return ""
    }
    function should_drop(key) {
      return (key != "" && forbidden[key] && !approved[key])
    }
    {
      if ($0 ~ /^  voice-bridge:[[:space:]]*$/) {
        in_voice = 1
        in_env = 0
      } else if (in_voice && $0 ~ /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ && $0 !~ /^  voice-bridge:[[:space:]]*$/) {
        in_voice = 0
        in_env = 0
      } else if (in_voice && $0 ~ /^    environment:[[:space:]]*$/) {
        in_env = 1
        print
        next
      } else if (in_voice && in_env) {
        key = env_key_from_map($0)
        if (key == "") key = env_key_from_list($0)
        if (should_drop(key)) next
        if ($0 ~ /^    [A-Za-z0-9_.-]+:[[:space:]]/ && $0 !~ /^    environment:[[:space:]]*$/) {
          in_env = 0
        }
      }
      print
    }
  ' "$file" >"$tmp"

  if cmp -s "$file" "$tmp"; then
    rm -f "$tmp"
    log "no compose changes needed for $(basename "$file")"
    return 0
  fi

  if [ "$DRY_RUN" = true ]; then
    log "DRY_RUN: would update $(basename "$file")"
    rm -f "$tmp"
    return 0
  fi

  out="${file}.new"
  mv "$tmp" "$out"
  mv "$out" "$file"
  log "updated $(basename "$file")"
}

main() {
  [ -f "$AUTH_ENV" ] || fail "authoritative env missing: ${AUTH_ENV}"
  [ -f "$AST_ENV" ] || fail "compose project env missing: ${AST_ENV}"
  [ -f "$COMPOSE_BASE" ] || fail "compose file missing: ${COMPOSE_BASE}"

  ensure_keys_file
  log "mode=${DRY_RUN} release_ref=${RELEASE_REF}"
  backup_files
  migrate_asterisk_env
  strip_compose_environment "$COMPOSE_BASE"
  strip_compose_environment "$COMPOSE_PROD"
  log "done — recreate voice-bridge, then run stage-a-compose-runtime-preflight.sh"
}

main "$@"
