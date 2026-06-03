#!/usr/bin/env bash
# Install Stage A / Gate 3 host preflight tools and ownership migration script.
#
# Usage:
#   bash install-voice-preflight-host-tools.sh
#   bash install-voice-preflight-host-tools.sh v1.34.0
set -eo pipefail

export TMPDIR="${TMPDIR:-/tmp}"

RELEASE_REF="${1:-v1.34.0}"
INSTALL_DIR="${INSTALL_DIR:-/opt/technolohit-voice/bin}"
GITHUB_RAW_BASE="https://raw.githubusercontent.com/technolohit/technolohit-voice-assistant/${RELEASE_REF}/scripts"

FILES=(
  compose-runtime-preflight-host.sh
  stage-a-compose-runtime-preflight.sh
  gate3-compose-runtime-preflight.sh
  stage-a-migrate-runtime-env-ownership.sh
  forbidden-voice-bridge-runtime-keys.txt
)

mkdir -p "$INSTALL_DIR"

for file in "${FILES[@]}"; do
  tmp="$(mktemp "${TMPDIR}/install-${file}.XXXXXX")"
  curl -fsSL "${GITHUB_RAW_BASE}/${file}" -o "$tmp"
  if [ "$file" = "forbidden-voice-bridge-runtime-keys.txt" ]; then
    install -m 644 "$tmp" "${INSTALL_DIR}/${file}"
  else
    install -m 755 "$tmp" "${INSTALL_DIR}/${file}"
  fi
  rm -f "$tmp"
  echo "installed ${INSTALL_DIR}/${file}"
done

echo
echo "Verify image baseline support (requires voice-bridge-${RELEASE_REF} or newer):"
echo "  docker run --rm thnhit/technhvoice:voice-bridge-${RELEASE_REF} node scripts/compose-runtime-preflight.js 2>&1 | head -n 3"
echo
echo "Stage A sequence:"
echo "  1. DRY_RUN=true ${INSTALL_DIR}/stage-a-migrate-runtime-env-ownership.sh"
echo "  2. ${INSTALL_DIR}/stage-a-migrate-runtime-env-ownership.sh"
echo "  3. cd /opt/technolohit-voice/asterisk && docker compose ... up -d voice-bridge"
echo "  4. ${INSTALL_DIR}/stage-a-compose-runtime-preflight.sh"
