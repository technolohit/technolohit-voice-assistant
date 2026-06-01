# v4 Phase 9b — Sysadmin Supervised Canary Runbook

Date: 2026-06-01  
Blueprint: [voice_assistant_v4_phase9b_supervised_canary_blueprint.md](./voice_assistant_v4_phase9b_supervised_canary_blueprint.md)  
Phase 9 baseline: [voice_assistant_v4_phase9_sysadmin_runbook.md](./voice_assistant_v4_phase9_sysadmin_runbook.md)

**Do not execute this runbook without written team approval.** Production v4 is **not** enabled by completing Phase 9b documentation.

**Current safe production state (post–Phase 9 dry run):**

```text
voice-bridge: thnhit/technhvoice:voice-bridge-v1.11.0
VOICE_RUNTIME_VERSION=v3
All VOICE_V4_* = false
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
VOICE_RAG_API_URL=http://127.0.0.1:8080
Rollback image recorded: thnhit/technhvoice:voice-bridge-v1.3.4
```

Paths:

```text
Compose dir:  /opt/technolohit-voice/asterisk
Runtime env:  /opt/technolohit-voice/voice-bridge/.env
Postgres:     container central_postgres, DB technolohit_growth
```

---

## 0. Before you start — precondition gate

Complete [blueprint section B](./voice_assistant_v4_phase9b_supervised_canary_blueprint.md#b-preconditions-before-phase-9b-canary). Abort if written approval is missing.

Record in your ticket:

- [ ] Retention approval status (pending / approved — attach reference, not secrets)
- [ ] Pre-canary DB backup path
- [ ] QA route or maintenance window time (UTC)
- [ ] Rollback tag: `voice-bridge-v1.3.4`
- [ ] Sysadmin + log observer present

**v1.11.0 note:** Live PSTN calls may still use v3 `turn-assistant` even when v4 env flags are temporarily enabled. Tier 9b-A validates env and safety; Tier 9b-B dialogue scenarios require live v4 wiring or test-host harness.

---

## 1. Record baseline (no env changes)

### 1.1 Running images

```bash
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
docker inspect technolohit-rag-api --format 'running_image={{.Config.Image}}' 2>/dev/null || true
```

### 1.2 Env flags (flag names only — do not paste full `.env`)

```bash
grep -E '^(VOICE_RUNTIME_VERSION|VOICE_V4_|VOICE_RAG_|VOICE_TENANT_ID|VOICE_AGENT_ID|VOICE_RAG_API_URL)=' \
  /opt/technolohit-voice/voice-bridge/.env | sort
```

### 1.3 Quality events baseline

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c \
  "SELECT count(*) AS total FROM voice.call_quality_events;"

docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c \
  "SELECT count(*) AS last_30m FROM voice.call_quality_events WHERE created_at >= now() - interval '30 minutes';"
```

### 1.4 Backup env before any canary change

```bash
CANARY_STAMP="$(date -u +%Y%m%dT%H%MZ)"
cp /opt/technolohit-voice/voice-bridge/.env \
  "/opt/technolohit-voice/voice-bridge/.env.pre-9b-${CANARY_STAMP}.bak"
ls -l "/opt/technolohit-voice/voice-bridge/.env.pre-9b-${CANARY_STAMP}.bak"
```

Optional DB snapshot:

```bash
docker exec central_postgres pg_dump -U postgres -d technolohit_growth -Fc \
  -f "/tmp/technolohit_growth_pre_9b_${CANARY_STAMP}.dump"
```

---

## 2. Scenario S1 — v3 baseline call (before canary flags)

1. Note `quality_events` count from §1.3.
2. Place **one** normal test call on approved QA route or maintenance window line.
3. Record `call_session_id` from logs or DB — **not** full phone number:

```bash
docker logs --tail=100 technolohit-voice-bridge 2>&1 \
  | grep -vEi 'api[_-]?key|password|secret|Bearer ' \
  | grep -vE '\+?[0-9]{8,}' \
  | tail -30
```

4. Re-run quality count — **expected:** no increase while `VOICE_RUNTIME_VERSION=v3`.

---

## 3. Optional — co-deploy rag-api-v1.11.0 (before RAG scenarios only)

Skip if Tier 9b-A only or RAG tests not in scope.

```bash
cd /opt/technolohit-voice/asterisk
export RAG_API_IMAGE=thnhit/technhvoice:rag-api-v1.11.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull technolohit-rag-api
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d technolohit-rag-api
docker inspect technolohit-rag-api --format 'running_image={{.Config.Image}}'
curl -fsS http://127.0.0.1:8080/healthz
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://127.0.0.1:8080/healthz || curl -fsS http://127.0.0.1:8080/healthz'
```

---

## 4. Tier 9b-A — supervised flag verification (maintenance window)

**Only with approval.** Edit `/opt/technolohit-voice/voice-bridge/.env` — use values from [blueprint §D.3 minimal set](./voice_assistant_v4_phase9b_supervised_canary_blueprint.md#3-production-maintenance-window-supervised-canary--only-if-explicitly-approved).

Example minimal canary (routing verification — **not** production default):

```env
VOICE_RUNTIME_VERSION=v4
VOICE_V4_REALTIME_ENABLED=true
VOICE_V4_CANARY_ENABLED=true
VOICE_V4_STREAMING_STT_ENABLED=false
VOICE_V4_STREAMING_TTS_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
```

Restart voice-bridge:

```bash
cd /opt/technolohit-voice/asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
sleep 3
docker logs --tail=30 technolohit-voice-bridge 2>&1 | grep -E 'voice-runtime|voice-bridge'
```

### 4.1 Verify flags inside container

```bash
docker exec technolohit-voice-bridge sh -lc \
  'printenv | sort | egrep "^VOICE_(RUNTIME_VERSION|V4_REALTIME|V4_CANARY|V4_BARGE|V4_STREAMING|RAG_ENABLED|RAG_SALES|RAG_API_URL)="'
```

### 4.2 Scenario S2 — expected startup log

Look for line like:

```text
[voice-runtime] selected=v4 v4_active=false reason=v4_canary_dialogue_stub_phase5 ...
```

If `selected=v3` despite v4 env, stop and document — do not proceed to extended scenarios.

---

## 5. Tier 9b-B — call QA scenarios (when live v4 path confirmed)

Run **one scenario block at a time**. Revert extra flags between blocks.

| Block | Env change |
|-------|------------|
| RAG | `VOICE_RAG_ENABLED=true`, `VOICE_RAG_SALES_ANSWERER_ENABLED=true` (+ rag-api-v1.11.0) |
| Barge-in | `VOICE_V4_BARGE_IN_ENABLED=true` |
| Streaming | `VOICE_V4_STREAMING_STT_ENABLED=true` / `VOICE_V4_STREAMING_TTS_ENABLED=true` — quota approved only |

Follow [blueprint §E scenario table](./voice_assistant_v4_phase9b_supervised_canary_blueprint.md#e-test-scenarios-call-qa-matrix). Record pass/fail per scenario ID.

After each call, collect metrics:

```bash
# Replace CALL_SESSION_ID
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c "
SELECT event_type, metric_name, metric_value, created_at
FROM voice.call_quality_events
WHERE call_session_id = 'CALL_SESSION_ID'
ORDER BY created_at;"
```

If Tier 9b-B is **N/A** on v1.11.0 production, skip to §7 rollback immediately after §4.

---

## 6. Metrics SQL (during / after window)

Full library: [voice_assistant_v4_phase8_quality_analytics_queries.sql](./voice_assistant_v4_phase8_quality_analytics_queries.sql)

**Errors (30m):**

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c "
SELECT call_session_id, event_type, left(payload->>'message', 120) AS msg, created_at
FROM voice.call_quality_events
WHERE event_type IN ('runtime_error', 'post_call_error')
  AND created_at >= now() - interval '30 minutes'
ORDER BY created_at DESC;"
```

**Lead events (30m):**

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c "
SELECT call_session_id, event_type, payload->>'reason' AS reason, created_at
FROM voice.call_quality_events
WHERE event_type IN ('lead_created', 'lead_skipped')
  AND created_at >= now() - interval '30 minutes'
ORDER BY created_at DESC;"
```

**RAG failures (30m):**

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c "
SELECT call_session_id, payload->>'fallback_reason' AS reason, created_at
FROM voice.call_quality_events
WHERE event_type = 'rag_retrieval_failed'
  AND created_at >= now() - interval '30 minutes'
ORDER BY created_at DESC;"
```

**Privacy scan:**

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c "
SELECT call_session_id, event_type, created_at
FROM voice.call_quality_events
WHERE payload::text ~ '[0-9]{8,}'
  AND created_at >= now() - interval '24 hours'
LIMIT 20;"
```

**Stop immediately** if privacy scan returns rows tied to phone data.

---

## 7. Rollback — restore baseline (Scenario S12)

### 7.1 Restore env from backup

```bash
CANARY_STAMP="<your-stamp-from-section-1>"
cp "/opt/technolohit-voice/voice-bridge/.env.pre-9b-${CANARY_STAMP}.bak" \
  /opt/technolohit-voice/voice-bridge/.env
```

Or manually ensure baseline:

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_CANARY_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_V4_STREAMING_STT_ENABLED=false
VOICE_V4_STREAMING_TTS_ENABLED=false
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
```

### 7.2 Restart voice-bridge

```bash
cd /opt/technolohit-voice/asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
docker logs --tail=20 technolohit-voice-bridge 2>&1 | grep voice-runtime
```

Expected: `selected=v3` and all v4 flags false in container.

### 7.3 Optional image rollback (if code issue)

```bash
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.3.4
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
```

Schema migrations 006–009 remain applied — no DB rollback needed for image rollback.

### 7.4 v3 verification call

Repeat §2. Confirm production behavior normal.

---

## 8. Collect logs (privacy-safe)

```bash
docker logs --tail=300 technolohit-voice-bridge 2>&1 \
  | grep -vEi 'api[_-]?key|password|secret|Bearer |Authorization:' \
  | grep -vE '\+?[0-9]{8,}' \
  > "voice-bridge-9b-${CANARY_STAMP}-redacted.log"

docker logs --tail=150 technolohit-rag-api 2>&1 \
  | grep -vEi 'api[_-]?key|password|secret' \
  > "rag-api-9b-${CANARY_STAMP}-redacted.log" 2>/dev/null || true
```

Do not attach raw `.env` files to tickets.

---

## 9. Stop criteria — abort checklist

Stop and run §7 immediately if any [blueprint §H stop criteria](./voice_assistant_v4_phase9b_supervised_canary_blueprint.md#h-stop--rollback-criteria) trigger.

---

## 10. Post-window sign-off

Fill [blueprint §I reporting template](./voice_assistant_v4_phase9b_supervised_canary_blueprint.md#i-reporting-template-for-sysadmin).

| Check | Pass |
|-------|------|
| Baseline env restored | ☐ |
| `VOICE_RUNTIME_VERSION=v3` | ☐ |
| All `VOICE_V4_*` false | ☐ |
| v3 verification call OK | ☐ |
| Quality events delta explained | ☐ |
| No privacy incidents | ☐ |
| Production v4 blockers still tracked | ☐ |
| Production v4 **not** marked accepted | ☐ |

Operator: _______________  Date: _______________  
Observer: _______________  Date: _______________
