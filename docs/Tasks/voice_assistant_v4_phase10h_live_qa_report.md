# v4 Phase 10H — Supervised Live PSTN QA Report

Date: 2026-06-01
Operator: Cursor agent (execution attempt) + **human operator required on production host**
Maintenance window (UTC): Not started from agent environment
Runbook: [voice_assistant_v4_phase10h_live_qa_runbook.md](./voice_assistant_v4_phase10h_live_qa_runbook.md)

**Status:** **Live PSTN QA not completed** from the Cursor workspace. Production stack (`technolohit-voice-bridge`, `/opt/technolohit-voice/`, `central_postgres`, PSTN) is not reachable here. **Do not treat this as a v4 code pass or fail** until a human runs E1–E14 on the server during an approved window.

---

## Executive summary

| Item | Result |
|------|--------|
| Phase 10H live PSTN QA executed end-to-end | **No** |
| `voice-bridge-v1.19.0` image available on Docker Hub | **Yes** (pulled locally) |
| Production gates A.1–A.7 on server | **Not run** (no host access) |
| Scenarios E1–E14 on live call | **Not run** (no PSTN + no voice-bridge container) |
| v3 restored on production | **N/A** (no env changes made) |
| **Final classification (live QA)** | **fail** — *execution incomplete / blocked* |

**Interpretation:** Classification is **fail** because supervised live QA was **not performed**, not because v4 failed on a live call. After human execution, replace this document’s classification with pass / partial / fail / unsafe per actual evidence.

---

## 1. Deployment baseline

| Item | Value |
|------|--------|
| Target image | `thnhit/technhvoice:voice-bridge-v1.19.0` |
| Running image (before QA) | *Not inspected — container absent on agent host* |
| Running image (during canary) | *Not applied* |
| Running image (after rollback) | *Not applied* |
| Rollback image (if used) | N/A |

### Local verification only (not production)

```text
$ docker pull thnhit/technhvoice:voice-bridge-v1.19.0
Status: Downloaded newer image for thnhit/technhvoice:voice-bridge-v1.19.0
Digest: sha256:6654b43acdef2090c1e75c46da6614692c7355a9eb170acbbb40e8124614b61e

$ docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
Error: No such object: technolohit-voice-bridge
```

---

## 2. Precondition gate

| Check | Pass / Fail | Notes |
|-------|-------------|--------|
| A.1 Written approval | **N/A** | Agent cannot confirm maintenance approval |
| A.2 Image v1.19.0 on **production** | **Not run** | Pull OK locally; production not accessed |
| A.3 Migration 009 `voice.call_quality_events` | **Not run** | Requires `central_postgres` on deploy host |
| A.4 `OPENAI_API_KEY` set (yes/no only) | **Not run** | Requires `docker exec technolohit-voice-bridge` |
| A.5 RAG `http://127.0.0.1:8080/healthz` | **Not run** | Requires deploy host network |
| A.6 v3 baseline call (pre-canary) | **Not run** | Requires live PSTN call |
| A.7 `.env` backup path | **Not run** | No write access to `/opt/technolohit-voice/voice-bridge/.env` |

Migration 009 check:

```text
(not executed on production)
```

---

## 3. Env flags (names and safe values only — no secrets)

**No production `.env` was read or modified** from this environment.

### 3.1 Before canary (baseline) — expected per runbook

```text
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_CANARY_ENABLED=false
VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=false
VOICE_V4_LIVE_CANARY_ALLOWLIST=
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_V4_TTS_PROVIDER=mock
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
```

### 3.2 During canary (QA window) — intended supervised matrix

```text
VOICE_RUNTIME_VERSION=v4
VOICE_V4_REALTIME_ENABLED=true
VOICE_V4_CANARY_ENABLED=true
VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=true
VOICE_V4_LIVE_CANARY_ALLOWLIST=bridge:
VOICE_V4_BARGE_IN_ENABLED=true
VOICE_V4_TTS_PROVIDER=openai
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
```

### 3.3 After rollback — required target

```text
VOICE_RUNTIME_VERSION=v3
VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=false
VOICE_V4_LIVE_CANARY_ALLOWLIST=
VOICE_V4_TTS_PROVIDER=mock
```

---

## 4. Allowlist procedure used

| Item | Value |
|------|--------|
| Procedure | **`bridge:`** (documented for single-call maintenance window) |
| Other PSTN traffic during window? | **Unknown** — not supervised from here |
| Allowlist blocker noted? | **yes** — random per-call UUID; `bridge:` workaround documented in runbook §B.1 |

Notes:

```text
Per-call UUID allowlist cannot be pre-set before connect in v1.19.0.
Supervised QA plan: empty traffic + VOICE_V4_LIVE_CANARY_ALLOWLIST=bridge: + one call + immediate v3 rollback.
Agent did not apply this on production.
```

---

## 5. Scenario results

| ID | Scenario | Pass / Fail / N/A | Notes |
|----|----------|-------------------|--------|
| E1 | v3 baseline before canary | **N/A** | Not executed |
| E2 | v4 route selected | **N/A** | Not executed |
| E3 | Greeting heard | **N/A** | Not executed |
| E4 | VAD speech start + endpoint | **N/A** | Not executed |
| E5 | STT completed | **N/A** | Not executed |
| E6 | Dialogue plan created | **N/A** | Not executed |
| E7 | OpenAI TTS intelligible | **N/A** | Not executed |
| E8 | Barge-in stops playback | **N/A** | Not executed |
| E9 | Switch → Smart Website | **N/A** | Not executed |
| E10 | Switch → AI Voice Assistant / voice_agent | **N/A** | Not executed |
| E11 | Quality flush completed | **N/A** | Not executed |
| E12 | SQL summary + session close | **N/A** | Not executed |
| E13 | Privacy (logs + SQL) | **N/A** | Not executed |
| E14 | v3 works after rollback | **N/A** | Not executed |

---

## 6. Call identifiers (no phone numbers)

| Field | Value |
|-------|--------|
| `call_session_id` (canary) | *Not captured* |
| `bridge_call_id` (canary) | *Not captured* |
| `external_call_id` (canary) | *Not captured* |
| QA route label (internal name only) | *Operator to fill* |

---

## 7. Log excerpts (redacted)

Attach file: `/tmp/voice-bridge-10h-<STAMP>.log` — **not produced** (no production logs collected).

```text
(no live canary call — agent host has no technolohit-voice-bridge container)
```

Required lines present?

| Pattern | Seen? |
|---------|--------|
| `call_handler selected=v4_canary` | No |
| `vad_speech_started` | No |
| `vad_endpoint_detected` | No |
| `stt_completed` | No |
| `dialogue_plan_created` | No |
| `tts_completed` | No |
| `playback_started` | No |
| `barge_in_detected` | No |
| `playback_cancelled` | No |
| `quality_flush_completed` | No |
| `call_end` | No |

### Operator command (run on deploy host after canary call)

```bash
QA_STAMP="$(date -u +%Y%m%dT%H%MZ)"
docker logs --since=30m technolohit-voice-bridge 2>&1 \
  | grep -vEi 'api[_-]?key|password|secret|Bearer |OPENAI_API_KEY' \
  | grep -vE '\+?[0-9]{8,}' \
  | egrep '\[v4-live\]|quality_flush|barge_in|stt_|tts_|playback_|dialogue|call_end|call_handler selected=' \
  > "/tmp/voice-bridge-10h-${QA_STAMP}.log"
```

---

## 8. SQL evidence

`call_session_id`: *Not captured*

### 8.1 Event counts

```text
(not executed)
```

### 8.2 Summary row

```text
(not executed)
```

### 8.3 Privacy scan (`\+?\d{8,}` in payload)

| Rows returned | Expected: 0 |
|---------------|---------------|
| *Not run* | |

### Operator SQL (after call — replace CALL_SESSION_ID)

```sql
SELECT event_type, count(*) AS n
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
GROUP BY event_type ORDER BY n DESC;

SELECT created_at, payload->'live_counters' AS live_counters, payload->>'close_reason'
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'live_call_quality_summary';

SELECT id, event_type FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND payload::text ~ '\+?\d{8,}';
```

---

## 9. Stop criteria / incidents

| Triggered? | Which (H1–H10) | Action taken |
|------------|----------------|--------------|
| no | — | No live call attempted from agent environment |

---

## 10. Rollback

| Item | Value |
|------|--------|
| Rollback completed | **N/A** (no canary env applied by agent) |
| `.env` restored from backup | **N/A** |
| v3 verification call (E14) | **N/A** |
| Time rollback completed (UTC) | — |

---

## 11. Final classification

- [ ] **pass** — All critical scenarios E1–E14 pass; privacy OK; v3 restored
- [ ] **partial** — Canary mostly works; list failures: _______________
- [x] **fail** — **Live PSTN QA not executed** (agent blocked: no production host, no PSTN)
- [ ] **unsafe** — Privacy/routing safety issue; immediate escalation

### Engineering follow-ups

```text
- Human operator must execute runbook on deploy host with SSH + approved maintenance window.
- Confirm written approval (A.1) before changing .env.
- Use immutable image voice-bridge-v1.19.0 only (not latest).
- Single supervised call with VOICE_V4_LIVE_CANARY_ALLOWLIST=bridge: only if zero concurrent PSTN traffic.
- Replace this report after live execution with real log/SQL evidence and re-classify.
- Repo automated tests (285/285 voice-bridge) are not a substitute for Phase 10H PSTN QA.
```

### Production v4 recommendation

```text
Production v4 for all traffic: STILL BLOCKED.
Phase 10H live QA: NOT COMPLETE — execution required on production before any v4 GA discussion.
```

---

## 12. Sign-off

| Role | Name | Date |
|------|------|------|
| Sysadmin | *Pending — human* | |
| Engineering observer | Cursor agent (prep only) | 2026-06-01 |
| Approval (if required) | *Pending* | |

---

## Appendix — one-shot operator script (production host)

Run on the deploy server as the user with Docker access. **Human on PSTN required** for call steps.

```bash
# === Preconditions ===
cd /opt/technolohit-voice/asterisk
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'

docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c \
  "SELECT to_regclass('voice.call_quality_events');"

docker exec technolohit-voice-bridge sh -lc 'test -n "$OPENAI_API_KEY" && echo openai_key_set=yes || echo openai_key_set=no'

curl -fsS http://127.0.0.1:8080/healthz && echo rag_ok

QA_STAMP="$(date -u +%Y%m%dT%H%MZ)"
cp /opt/technolohit-voice/voice-bridge/.env \
  "/opt/technolohit-voice/voice-bridge/.env.pre-10h-${QA_STAMP}.bak"

# === v3 baseline: confirm .env section C, restart, place ONE test call, verify v3 in logs ===

# === Canary window: edit .env section D, then: ===
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.19.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull technolohit-voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d technolohit-voice-bridge

# === ONE supervised PSTN call; collect logs (section F of runbook) ===

# === Rollback: restore .env.pre-10h backup or section C; restart; v3 verification call ===
```
