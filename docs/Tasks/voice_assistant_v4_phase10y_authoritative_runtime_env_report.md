# Voice Assistant v4 Phase 10Y — Authoritative Runtime Env Report

Date: 2026-06-03  
Status: **Final ownership closure complete; no deploy, no Gate 3 live QA**  
Target release: **`voice-bridge-v1.33.0`**

## Incident

Phase 10X Gate 3 was correctly aborted. The operator edited
`/opt/technolohit-voice/voice-bridge/.env` for RAG-on, but the running container
kept both RAG flags `false` because Compose project env and service
`environment:` overrode `env_file`.

Production remains **v3 / RAG-off**. No production env files were changed. No
deploy or live QA was performed. `docs/Tasks/logs.txt` was not modified.

## Root Cause

Docker Compose precedence: **service `environment:` overrides `env_file`**. The
server interpolated forbidden `VOICE_*` runtime keys from `asterisk/.env` into
`docker-compose.yml`. Editing only `voice-bridge/.env` could not enable RAG.

Initial Phase 10Y preflight compared effective values only. Review fixes added
raw ownership checks, but still inspected only `docker-compose.yml`. A forbidden
override in tracked `docker-compose.prod.yml` could still pass.

## Final Ownership Closure (Codex Review Round 2)

### Blocker 1 — inspect every raw Compose file in the render stack

Production renders with:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config
```

Preflight now mounts and inspects **both**:

- `/opt/technolohit-voice/asterisk/docker-compose.yml`
- `/opt/technolohit-voice/asterisk/docker-compose.prod.yml`

CLI accepts repeated `--raw-compose-file` arguments. Output includes safe
file:key evidence, for example:

```text
compose_source_forbidden_by_file=docker-compose.prod.yml:VOICE_RUNTIME_VERSION
```

Missing either file fails with `raw_compose_missing:…`.

### Blocker 2 — full forbidden runtime key coverage

`VOICE_BRIDGE_RUNTIME_ENV_KEYS` now covers all voice-bridge runtime keys from
`voice-bridge/.env.example` and `config.js`, including at minimum:

- `VOICE_V4_INTERRUPT_FOLLOWUP_WAIT_MS`
- `VOICE_V4_INTERRUPT_FOLLOWUP_MAX_MS`
- `VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED`
- `VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED`

Policy:

| Location | Rule |
|----------|------|
| `voice-bridge` service `environment:` | No forbidden runtime keys (BUILD_VERSION/IMAGE_TAG only) |
| `asterisk/.env` | No voice-bridge runtime keys |
| Approved interpolation | `VOICE_BRIDGE_IMAGE`, `RAG_API_IMAGE`, `BUILD_VERSION`, `IMAGE_TAG` |
| Authoritative runtime | `/opt/technolohit-voice/voice-bridge/.env` only |

Asterisk/SIP keys such as `EASYBELL_*` are not rejected.

### Prior review fixes retained

- Sanitized Gate 3 snapshots only (no full `.env` / `printenv` mounts)
- `docker run --user 0:0` for read-only preflight against `USER node` image
- Self-contained host wrapper + inline runbook fallback (no repo checkout)
- Compose patch fragment (not full service replacement)

## Proof Both Raw Compose Files Are Inspected

| Layer | Evidence |
|-------|----------|
| Host wrapper | Mounts `/raw/docker-compose.yml` and `/raw/docker-compose.prod.yml`; passes both `--raw-compose-file` flags |
| GitHub Actions | Inline SSH block mirrors wrapper (dual mount + dual CLI args) |
| Runbook D.1 | Inline heredoc mirrors wrapper |
| Unit tests | Fail when `docker-compose.yml` has `VOICE_RAG_ENABLED`; fail when `docker-compose.prod.yml` has `VOICE_RUNTIME_VERSION` |

## Files Changed (Final Closure)

| Area | Files |
|------|-------|
| Ownership logic | `voice-bridge/src/v4/compose-runtime-preflight.js` |
| CLI | `voice-bridge/scripts/compose-runtime-preflight.js` |
| Host wrapper (Stage A) | `scripts/stage-a-compose-runtime-preflight.sh` |
| Host wrapper (Gate 3) | `scripts/gate3-compose-runtime-preflight.sh` |
| Shared host logic | `scripts/compose-runtime-preflight-host.sh` |
| Deploy verifier | `.github/workflows/deploy.yml` |
| Tests | `voice-bridge/tests/v4-phase10y-compose-runtime-preflight.test.js` |
| Docs | runtime env, release/CICD, 10H runbook, blueprint, this report |

## Self-Contained Sysadmin Commands

**Stage A (baseline, v3/RAG-off):**

```bash
cd /opt/technolohit-voice/asterisk
bash /opt/technolohit-voice/bin/stage-a-compose-runtime-preflight.sh
```

See [Stage A sysadmin runbook](./voice_assistant_v4_phase10y_stage_a_sysadmin_runbook.md) for ownership cleanup on the server.

**Gate 3 (v4/RAG-on canary only):**

```bash
cd /opt/technolohit-voice/asterisk
bash /opt/technolohit-voice/bin/gate3-compose-runtime-preflight.sh
docker exec technolohit-voice-bridge npm run rag:canary-preflight
```

Abort Stage A unless output includes:

```text
compose_runtime_preflight=pass
mode=baseline
ownership_pass=true
compose_source_forbidden_by_file=none
compose_project_env_forbidden_keys=none
baseline_effective_pass=true
```

Abort Gate 3 unless output includes:

```text
compose_runtime_preflight=pass
ownership_pass=true
compose_source_forbidden_by_file=none
compose_project_env_forbidden_keys=none
rag_canary_preflight=pass
```

## Verification

| Check | Result |
|-------|--------|
| `cd voice-bridge && npm test` | **418/418** passed |
| `python -m pytest rag-api/tests` | **7/7** passed |
| `voice-bridge/scripts/run-ci-dialogue-scenarios.ps1` | **26/26** passed |
| `node --check` on changed JS | passed |
| `bash -n scripts/gate3-compose-runtime-preflight.sh` | passed |
| `git diff --check` | clean |

## Safety Confirmations

- Production remains **v3 / RAG-off**
- No production env files modified
- No deploy performed
- No Gate 3 live QA performed
- `docs/Tasks/logs.txt` untouched

## Release Recommendation

Ship **`voice-bridge-v1.33.0`**. Do **not** commit or tag until Codex review.

After release: apply compose patch fragment on server, install optional wrapper
to `/opt/technolohit-voice/bin/`, rerun Gate 2 before Gate 3.
