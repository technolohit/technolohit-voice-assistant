# Phase 10Y Stage A — Sysadmin Runbook (Ownership Cleanup + Baseline Preflight)

Date: 2026-06-03 (updated)  
Production state: **v3 / RAG-off (safe)**  
Image required: **`thnhit/technhvoice:voice-bridge-v1.34.0`** (v1.33.0 does **not** include `--baseline`)

Do **not** run Gate 3 preflight (`--gate3`) until Gate 2 passes and you intentionally enable v4/RAG-on for a supervised canary window.

---

## Root cause summary

| Blocker | Detail | Fix |
|---------|--------|-----|
| Wrong image tag | `v1.33.0` only ships `--gate3` preflight | Deploy **`voice-bridge-v1.34.0`** |
| Host tools missing | Wrappers live on host, not inside old images | Run `install-voice-preflight-host-tools.sh` |
| Dirty ownership | Runtime keys still in `asterisk/.env` / Compose | Run `stage-a-migrate-runtime-env-ownership.sh` |
| `TMPDIR: unbound variable` | Old scripts used `set -u` without defaulting `TMPDIR` | Fixed in v1.34.0 host scripts |

Stage A passes only when output includes:

```text
compose_runtime_preflight=pass
mode=baseline
ownership_pass=true
compose_source_forbidden_by_file=none
compose_project_env_forbidden_keys=none
baseline_effective_pass=true
```

---

## Step 0 — Install host tools (one time)

From the production host (requires `curl`):

```bash
curl -fsSL https://raw.githubusercontent.com/technolohit/technolohit-voice-assistant/v1.34.0/scripts/install-voice-preflight-host-tools.sh \
  | bash
```

This installs to `/opt/technolohit-voice/bin/`:

- `compose-runtime-preflight-host.sh`
- `stage-a-compose-runtime-preflight.sh`
- `gate3-compose-runtime-preflight.sh`
- `stage-a-migrate-runtime-env-ownership.sh`
- `forbidden-voice-bridge-runtime-keys.txt`

Verify the **new image** exposes baseline mode:

```bash
docker run --rm thnhit/technhvoice:voice-bridge-v1.34.0 \
  node scripts/compose-runtime-preflight.js 2>&1 | head -n 5
```

Expected: usage text mentions **`--baseline`** and **`--gate3`**.

---

## Step 1 — Deploy v1.34.0 (same safe v3/RAG-off flags)

Edit `/opt/technolohit-voice/asterisk/.env`:

```bash
VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.34.0
```

Recreate after ownership cleanup (Step 3) or now if you need the new preflight binary first:

```bash
cd /opt/technolohit-voice/asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
sleep 3
docker exec technolohit-voice-bridge sh -lc \
  'printf "VOICE_RUNTIME_VERSION=%s\nVOICE_RAG_ENABLED=%s\n" "${VOICE_RUNTIME_VERSION:-unset}" "${VOICE_RAG_ENABLED:-unset}"'
```

Expected: `v3`, `false`.

---

## Step 2 — Migrate ownership (idempotent)

Audit first (no writes):

```bash
DRY_RUN=true /opt/technolohit-voice/bin/stage-a-migrate-runtime-env-ownership.sh
```

Apply migration (creates timestamped backups automatically):

```bash
/opt/technolohit-voice/bin/stage-a-migrate-runtime-env-ownership.sh
```

The script:

1. Copies any forbidden `VOICE_*` runtime keys from `asterisk/.env` → `voice-bridge/.env` (only if missing in authoritative file)
2. Removes those keys from `asterisk/.env`
3. Strips forbidden `VOICE_*` keys from `docker-compose.yml` and `docker-compose.prod.yml` `voice-bridge.environment:` (keeps `BUILD_VERSION`, `IMAGE_TAG`)
4. Does **not** touch `EASYBELL_*`, `VOICE_BRIDGE_IMAGE`, `RAG_API_IMAGE`

**Remaining forbidden keys reported on production (2026-06-03):**

`VOICE_POST_CALL_SUMMARY_ENABLED`, `VOICE_POST_CALL_LEAD_EXTRACTION_ENABLED`, `VOICE_POST_CALL_NOTIFY_*`, `VOICE_SEMANTIC_INTENT_*`, `VOICE_CONVERSATION_REPAIR_ENABLED`, `VOICE_RAG_QA_MODE`, `VOICE_LEAD_POLICY_STRICT_CALLBACK`, `VOICE_RAG_TIMEOUT_MS`, `VOICE_RAG_MIN_SCORE`, `VOICE_LOG_TRANSCRIPT_PREVIEW`, `VOICE_CONTACT_EMAIL`, `VOICE_WEBSITE_URL`

Re-run migration safely — it is idempotent.

Recreate voice-bridge after migration:

```bash
cd /opt/technolohit-voice/asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
sleep 3
```

---

## Step 3 — Run Stage A baseline preflight

```bash
cd /opt/technolohit-voice/asterisk
/opt/technolohit-voice/bin/stage-a-compose-runtime-preflight.sh
```

**Do not use `--gate3` or `gate3-compose-runtime-preflight.sh` for Stage A.**

Abort if exit code ≠ 0 or any pass marker is missing (see top of this doc).

---

## Step 4 — After Stage A passes

| Gate | Preflight | Production flags |
|------|-----------|------------------|
| Stage A | `--baseline` | v3 / RAG-off |
| Gate 1 | v3 health checks | v3 / RAG-off |
| Gate 2 | v4/RAG-off canary | v4 canary, RAG-off |
| Gate 3 | `--gate3` + `rag:canary-preflight` | v4 canary, RAG-on (supervised window only) |

Gate 3 only:

```bash
/opt/technolohit-voice/bin/gate3-compose-runtime-preflight.sh
docker exec technolohit-voice-bridge npm run rag:canary-preflight
```

---

## Rollback

Restore backups created by the migration script (`*.pre-stage-a-<STAMP>.bak`), revert `VOICE_BRIDGE_IMAGE` if needed, recreate container.

---

## Report back (no secrets)

Send:

1. Output of `docker run ... compose-runtime-preflight.js` help check (shows `--baseline`)
2. Full `stage-a-compose-runtime-preflight.sh` output
3. Confirmation `VOICE_RUNTIME_VERSION=v3`, `VOICE_RAG_ENABLED=false`, `VOICE_RAG_SALES_ANSWERER_ENABLED=false`
