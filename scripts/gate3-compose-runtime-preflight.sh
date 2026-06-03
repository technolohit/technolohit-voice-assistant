#!/usr/bin/env bash
# Gate 3 preflight — requires v4/RAG-on values. Do not use for Stage A baseline.
exec env PREFLIGHT_MODE=gate3 bash "$(dirname "$0")/compose-runtime-preflight-host.sh" "$@"
