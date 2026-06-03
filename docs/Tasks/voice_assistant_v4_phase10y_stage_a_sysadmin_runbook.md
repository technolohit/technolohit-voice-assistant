# Phase 10Y Stage A — Sysadmin Runbook (Ownership Cleanup + Baseline Preflight)

Date: 2026-06-03  
Production state: **v3 / RAG-off (safe)**  
Image required: **`voice-bridge-v1.33.0`** or newer (includes `--baseline` preflight)

Do **not** run Gate 3 preflight (`--gate3`) until Gate 2 passes and you intentionally enable v4/RAG-on for a supervised canary window.

---

## Why Stage A Is Blocked

Two separate issues were found:

| Issue | Cause | Fix |
|-------|--------|-----|
| Wrong preflight mode | `--gate3` requires v4/RAG-on values | Use **`--baseline`** for Stage A while production stays v3/RAG-off |
| Dirty ownership | Runtime keys duplicated in `asterisk/.env` and/or raw Compose `environment:` | Move keys to `voice-bridge/.env` only; remove from other sources |

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

## Step 0 — Backup (mandatory)

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
cp /opt/technolohit-voice/voice-bridge/.env \
  "/opt/technolohit-voice/voice-bridge/.env.pre-stage-a-${STAMP}.bak"
cp /opt/technolohit-voice/asterisk/.env \
  "/opt/technolohit-voice/asterisk/.env.pre-stage-a-${STAMP}.bak"
cp /opt/technolohit-voice/asterisk/docker-compose.yml \
  "/opt/technolohit-voice/asterisk/docker-compose.yml.pre-stage-a-${STAMP}.bak"
```

---

## Step 1 — Audit forbidden keys (read-only)

```bash
cd /opt/technolohit-voice/asterisk

echo "=== Forbidden keys in asterisk/.env (must be none after cleanup) ==="
grep -E '^(VOICE_AGENT_|VOICE_ASR_|VOICE_ASSISTANT_|VOICE_BRIDGE_HOST|VOICE_BRIDGE_PORT|VOICE_CONTACT_|VOICE_CONVERSATION_|VOICE_DB_|VOICE_FRAME_|VOICE_GREETING_|VOICE_INBOUND_|VOICE_KNOWLEDGE_|VOICE_LEAD_|VOICE_LOG_|VOICE_POST_CALL_|VOICE_QA_|VOICE_RAG_|VOICE_RECORDING_|VOICE_RUNTIME_|VOICE_SAMPLE_|VOICE_SEMANTIC_|VOICE_TENANT_|VOICE_TONE_|VOICE_TRANSCRIPTION_|VOICE_TURN_|VOICE_V4_|VOICE_WEBSITE_)=' .env || echo "(none)"

echo "=== Forbidden keys in raw Compose voice-bridge environment: ==="
for f in docker-compose.yml docker-compose.prod.yml; do
  echo "--- $f ---"
  awk '/^  voice-bridge:/{v=1;next} v&&/^  [a-zA-Z0-9_.-]+:/{exit} v&&/^    environment:/{e=1;next} v&&e&&/^      [A-Z0-9_]+:/{print FILENAME":"$1}' "$f" 2>/dev/null \
    | sed 's/:$//' \
    | egrep 'VOICE_(AGENT|ASR|ASSISTANT|BRIDGE_HOST|BRIDGE_PORT|CONTACT|CONVERSATION|DB|FRAME|GREETING|INBOUND|KNOWLEDGE|LEAD|LOG|POST_CALL|QA|RAG|RECORDING|RUNTIME|SAMPLE|SEMANTIC|TENANT|TONE|TRANSCRIPTION|TURN|V4|WEBSITE)' || echo "(none)"
done
```

**Known forbidden keys currently reported on production:**

From **raw Compose** (`docker-compose.yml`):

- `VOICE_BRIDGE_HOST`
- `VOICE_BRIDGE_PORT`
- `VOICE_SEMANTIC_INTENT_ENABLED`
- `VOICE_CONVERSATION_REPAIR_ENABLED`
- `VOICE_SEMANTIC_INTENT_MODE`
- `VOICE_RAG_QA_MODE`
- `VOICE_LEAD_POLICY_STRICT_CALLBACK`
- `VOICE_LOG_TRANSCRIPT_PREVIEW`

From **`asterisk/.env`**:

- `VOICE_CONTACT_EMAIL`
- `VOICE_CONVERSATION_REPAIR_ENABLED`
- `VOICE_LEAD_POLICY_STRICT_CALLBACK`
- `VOICE_LOG_TRANSCRIPT_PREVIEW`
- `VOICE_POST_CALL_LEAD_EXTRACTION_ENABLED`
- `VOICE_POST_CALL_NOTIFY_ENABLED`
- `VOICE_POST_CALL_NOTIFY_TIMEOUT_MS`
- `VOICE_POST_CALL_NOTIFY_WEBHOOK_URL`
- `VOICE_POST_CALL_SUMMARY_ENABLED`
- `VOICE_RAG_MIN_SCORE`
- `VOICE_RAG_QA_MODE`
- `VOICE_RAG_TIMEOUT_MS`
- `VOICE_SEMANTIC_INTENT_ENABLED`
- `VOICE_SEMANTIC_INTENT_MODE`
- `VOICE_WEBSITE_URL`

Do **not** remove `EASYBELL_*`, `VOICE_BRIDGE_IMAGE`, `RAG_API_IMAGE`, `BUILD_VERSION`, or `IMAGE_TAG` from `asterisk/.env`.

---

## Step 2 — Move runtime keys to authoritative file

For **each** forbidden key listed in `asterisk/.env`:

1. If the key is **missing** from `/opt/technolohit-voice/voice-bridge/.env`, copy the line from `asterisk/.env` into `voice-bridge/.env`.
2. **Remove** the line from `asterisk/.env`.

Example (repeat per key — do not print secrets in tickets):

```bash
AUTH=/opt/technolohit-voice/voice-bridge/.env
AST=/opt/technolohit-voice/asterisk/.env
KEY=VOICE_LEAD_POLICY_STRICT_CALLBACK

grep -q "^${KEY}=" "$AUTH" || grep "^${KEY}=" "$AST" >>"$AUTH"
sed -i "/^${KEY}=/d" "$AST"
```

After cleanup, `asterisk/.env` should contain **only**:

- Compose interpolation: `VOICE_BRIDGE_IMAGE`, `RAG_API_IMAGE`, `BUILD_VERSION`, `IMAGE_TAG`
- Asterisk/SIP keeper: `EASYBELL_*`
- RAG API tuning keys if used by `technolohit-rag-api` service (not voice-bridge runtime)

---

## Step 3 — Clean raw Compose `voice-bridge.environment:`

Edit `/opt/technolohit-voice/asterisk/docker-compose.yml` (and verify `docker-compose.prod.yml`).

**Preserve** all other service settings (volumes, network, depends_on, healthcheck, logging).

Under `services.voice-bridge`:

- **Keep** `env_file: ../voice-bridge/.env`
- **Remove** every `VOICE_*` runtime key from `environment:` except `BUILD_VERSION` and `IMAGE_TAG` if present

Reference patch (fragment only): `asterisk/docker-compose.voice-bridge.reference.yml` in the git repo.

Validate:

```bash
cd /opt/technolohit-voice/asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml config \
  | awk '/voice-bridge:/,/^[a-z]/ {print}' \
  | egrep 'env_file:|environment:|VOICE_'
```

Expected: `env_file` present; `environment` has **no** forbidden `VOICE_*` runtime keys.

---

## Step 4 — Recreate voice-bridge (same safe v3/RAG-off image)

```bash
cd /opt/technolohit-voice/asterisk
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.33.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
sleep 3
```

Confirm safe runtime (no secrets):

```bash
docker exec technolohit-voice-bridge sh -lc \
  'printf "VOICE_RUNTIME_VERSION=%s\nVOICE_RAG_ENABLED=%s\nVOICE_RAG_SALES_ANSWERER_ENABLED=%s\n" \
    "${VOICE_RUNTIME_VERSION:-unset}" "${VOICE_RAG_ENABLED:-unset}" "${VOICE_RAG_SALES_ANSWERER_ENABLED:-unset}"'
```

Expected: `v3`, `false`, `false`.

---

## Step 5 — Run Stage A baseline preflight (NOT --gate3)

Install wrapper once from repo release (optional):

```bash
install -m 755 /path/from/release/scripts/stage-a-compose-runtime-preflight.sh \
  /opt/technolohit-voice/bin/stage-a-compose-runtime-preflight.sh
install -m 755 /path/from/release/scripts/compose-runtime-preflight-host.sh \
  /opt/technolohit-voice/bin/compose-runtime-preflight-host.sh
```

Run:

```bash
cd /opt/technolohit-voice/asterisk
bash /opt/technolohit-voice/bin/stage-a-compose-runtime-preflight.sh
```

Or without install (from repo checkout):

```bash
cd /opt/technolohit-voice/asterisk
PREFLIGHT_MODE=baseline bash /path/to/repo/scripts/compose-runtime-preflight-host.sh
```

**Abort Stage A** if exit code is non-zero or any of these are not true:

- `ownership_pass=true`
- `compose_source_forbidden_by_file=none`
- `compose_project_env_forbidden_keys=none`
- `baseline_effective_pass=true`

---

## Step 6 — After Stage A passes

Only then proceed with the Phase 10H test plan:

| Gate | Preflight | Production flags |
|------|-----------|------------------|
| Stage A | `--baseline` | v3 / RAG-off |
| Gate 1 | v3 health checks | v3 / RAG-off |
| Gate 2 | v4/RAG-off canary window | v4 canary, RAG-off |
| Gate 3 | `--gate3` + `rag:canary-preflight` | v4 canary, RAG-on (supervised window only) |

Gate 3 command (only after Gate 2 passes and intentional RAG-on env edit):

```bash
bash /opt/technolohit-voice/bin/gate3-compose-runtime-preflight.sh
docker exec technolohit-voice-bridge npm run rag:canary-preflight
```

---

## Rollback

```bash
cp /opt/technolohit-voice/voice-bridge/.env.pre-stage-a-<STAMP>.bak \
  /opt/technolohit-voice/voice-bridge/.env
cp /opt/technolohit-voice/asterisk/.env.pre-stage-a-<STAMP>.bak \
  /opt/technolohit-voice/asterisk/.env
cp /opt/technolohit-voice/asterisk/docker-compose.yml.pre-stage-a-<STAMP>.bak \
  /opt/technolohit-voice/asterisk/docker-compose.yml
cd /opt/technolohit-voice/asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

---

## Report back

After Step 5, send (no secrets):

- Full baseline preflight output
- Confirmation `VOICE_RUNTIME_VERSION` / RAG flags from Step 4
- Whether Gate 1/2/3 scheduling can proceed
