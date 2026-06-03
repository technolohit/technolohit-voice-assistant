#!/usr/bin/env bash
# Stage A baseline preflight — safe v3/RAG-off ownership check.
exec env PREFLIGHT_MODE=baseline bash "$(dirname "$0")/compose-runtime-preflight-host.sh" "$@"
