# v4 Phase 10H — Supervised Live PSTN QA Runbook (AudioSocket Canary)

Date: 2026-06-01
Baseline image: **`thnhit/technhvoice:voice-bridge-v1.23.0`** (Phase 10L) or later tag that includes 10L
Prior failed QA: [voice_assistant_v4_phase10h_live_qa_report.md](./voice_assistant_v4_phase10h_live_qa_report.md) (includes failed **v1.20.0** retry)
Stabilization: [voice_assistant_v4_phase10i_live_canary_stabilize_report.md](./voice_assistant_v4_phase10i_live_canary_stabilize_report.md), [voice_assistant_v4_phase10j_stt_failure_and_session_hardening_report.md](./voice_assistant_v4_phase10j_stt_failure_and_session_hardening_report.md), [voice_assistant_v4_phase10k_full_utterance_stt_buffer_fix_report.md](./voice_assistant_v4_phase10k_full_utterance_stt_buffer_fix_report.md), [voice_assistant_v4_phase10l_stt_success_buffer_metrics_report.md](./voice_assistant_v4_phase10l_stt_success_buffer_metrics_report.md)
Wiring: [voice_assistant_v4_phase10_live_audiosocket_canary_wiring_blueprint.md](./voice_assistant_v4_phase10_live_audiosocket_canary_wiring_blueprint.md)

**Do not execute without written maintenance-window approval.** This runbook does **not** enable production v4 GA. It validates the gated `v4_canary` path on a **supervised** PSTN call only.

**Production must return to v3** immediately after QA, even on pass.

---

## Paths and containers

```text
Compose dir:  /opt/technolohit-voice/asterisk
Runtime env:  /opt/technolohit-voice/voice-bridge/.env
Postgres:     container central_postgres, DB technolohit_growth
Compose service: voice-bridge
Container:    technolohit-voice-bridge
```

Env source of truth: [docs/voice-bridge-runtime-env.md](../voice-bridge-runtime-env.md)  
Deploy tags: [docs/release-and-cicd.md](../release-and-cicd.md)

---

## A. Precondition gate (abort if any fail)

Record results in [voice_assistant_v4_phase10h_live_qa_report.md](./voice_assistant_v4_phase10h_live_qa_report.md).

### A.1 Written approval and window

- [ ] Maintenance window scheduled (UTC): _______________
- [ ] Sysadmin + log observer present
- [ ] No production v4 GA approval implied by this QA
- [ ] Rollback image recorded (previous known-good): _______________

### A.2 Running image — upgrade to v1.19.0 (immutable tag)

```bash
cd /opt/technolohit-voice/asterisk
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.19.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
sleep 3
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
```

**Pass:** image ends with `voice-bridge-v1.19.0`.  
**Do not** pin production to `voice-bridge-latest`.

### A.3 Migration 009 (quality events) — required before SQL checks

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c \
  "SELECT to_regclass('voice.call_quality_events') AS quality_table;"
```

**Pass:** `voice.call_quality_events` (not null).

If missing, apply migration from tag `v1.19.0` per [voice_assistant_v4_phase9_sysadmin_runbook.md](./voice_assistant_v4_phase9_sysadmin_runbook.md) §3 (file `009_v4_call_quality_events.sql`). Re-check before canary QA.

Baseline counts (optional):

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c \
  "SELECT count(*) AS total FROM voice.call_quality_events;"
```

### A.4 OpenAI key present (do not print)

```bash
docker exec technolohit-voice-bridge sh -lc 'test -n "$OPENAI_API_KEY" && echo openai_key_set=yes || echo openai_key_set=no'
```

**Pass:** `openai_key_set=yes` (required for `VOICE_V4_TTS_PROVIDER=openai` and **`VOICE_V4_STT_PROVIDER=openai`**).

### A.4b STT provider (Phase 10I — required for live semantic QA)

```bash
docker exec technolohit-voice-bridge sh -lc \
  'echo stt_provider=${VOICE_V4_STT_PROVIDER:-unset}'
```

**Pass:** `stt_provider=openai`.
**Fail / abort:** `stt_provider=mock` or unset on a supervised PSTN semantic QA run — mock STT invalidates utterance understanding tests.

Startup log (after restart) must **not** show misleading `v4_active=true` on v3 default:

```bash
docker logs --since=2m technolohit-voice-bridge 2>&1 \
  | grep '\[voice-runtime\]' | tail -3
```

**Pass (v3 baseline):** `selected_runtime=v3 selected_runtime_active=true v4_requested=false v4_runtime_active=false reason=default_v3`

### A.4c Stale active call sessions (before and after QA)

```sql
SELECT id, status, started_at, ended_at, external_call_id
FROM voice.call_sessions
WHERE status = 'active' AND ended_at IS NULL
ORDER BY started_at DESC
LIMIT 10;
```

**Pass before QA:** zero rows, or only explained in-flight calls during the window.
**Pass after QA:** no new stale rows for the canary `call_session_id` (session must be `completed` with `ended_at` set).

**Read-only only** — do not bulk-update or auto-complete unrelated stale sessions from SQL.

### A.4d OpenAI STT preflight (Phase 10J — mandatory before canary)

Run **inside** the voice-bridge container after restart and **before** enabling canary env:

```bash
docker exec technolohit-voice-bridge npm run stt:preflight
```

**Pass (exit 0):** output includes `openai_stt_preflight=pass` and `http_status=200` (or another 2xx). `error_code=none` is ideal; `error_code=empty_transcript_on_tone` is also acceptable because the preflight uses a synthetic tone, not spoken German.

**Abort canary if fail:** `openai_stt_preflight=fail` — fix API key, model, or outbound connectivity first. Do **not** place a supervised PSTN call until preflight passes.

Expected safe output shape (no secrets, no transcript text):

```text
openai_stt_preflight=pass
model=gpt-4o-mini-transcribe
http_status=200
error_code=none
latency_ms=<number>
```

### A.5 RAG health (host-local URL from voice-bridge network)

```bash
curl -fsS http://127.0.0.1:8080/healthz && echo rag_ok
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://127.0.0.1:8080/healthz || curl -fsS http://127.0.0.1:8080/healthz'
```

**Pass:** HTTP 200 / health body.  
Phase 10H scenarios keep `VOICE_RAG_ENABLED=false` initially; this gate confirms infra only.

### A.6 v3 baseline call (before any v4 canary flags)

With **production-safe baseline** env (section C), place **one** normal test call on the approved QA route.

```bash
docker logs --since=5m technolohit-voice-bridge 2>&1 \
  | grep -vEi 'api[_-]?key|password|secret|Bearer |OPENAI' \
  | grep -vE '\+?[0-9]{8,}' \
  | egrep 'call_handler selected=|call accepted|call_end' \
  | tail -20
```

**Pass:**

- `call_handler selected=v3` (or handler not `v4_canary`)
- Greeting/assistant behavior normal for v3
- No `[v4-live]` lines on this call

Record `call_session_id` if needed (UUID only — **not** caller phone).

### A.7 Backup env before canary changes

```bash
QA_STAMP="$(date -u +%Y%m%dT%H%MZ)"
cp /opt/technolohit-voice/voice-bridge/.env \
  "/opt/technolohit-voice/voice-bridge/.env.pre-10h-${QA_STAMP}.bak"
ls -l "/opt/technolohit-voice/voice-bridge/.env.pre-10h-${QA_STAMP}.bak"
```

---

## B. Safety rules

| Rule | Detail |
|------|--------|
| Supervised only | Run only in an approved maintenance window with an operator on the call |
| Restore v3 after QA | Revert section C env and restart **before** leaving the window |
| Empty allowlist | `VOICE_V4_LIVE_CANARY_ALLOWLIST=` (empty) **always** fail-closes to v3 |
| No phone in allowlist | Never put DID, E.164, or caller number in the allowlist |
| No concurrent PSTN | During canary window, avoid overlapping calls when using broad allowlist (see B.1) |
| No production v4 | Passing QA does not approve `VOICE_RUNTIME_VERSION=v4` for all traffic |
| Spike flags off | `VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=false`, `VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED=false` |

### B.1 Allowlist feasibility (current code — read before canary)

`bridge_call_id` is a **new random UUID on every AudioSocket connection** (`persist.assignBridgeCallIdentity`). The allowlist is evaluated **once at call start**. You **cannot** learn the ID from the same call and activate v4 on that call retroactively.

| Approach | Feasible? | Notes |
|----------|-----------|--------|
| Put DID/phone in allowlist | **No** | Forbidden; not matched anyway |
| Preflight call → copy UUID → second call with that UUID | **No** | Second call gets a **new** UUID |
| Allowlist `qa-canary` without that substring in live IDs | **No** | Tests use `qa-canary`; production PSTN uses random UUIDs |
| Maintenance window + `VOICE_V4_LIVE_CANARY_ALLOWLIST=bridge:` | **Yes (supervised)** | Matches `external_call_id` form `bridge:<uuid>` for **every** call — **only** with zero other PSTN traffic |
| Dedicated non-phone route marker env (future code) | **Not in v1.19.0** | Recommended follow-up if `bridge:` is too broad |

**Recommended Phase 10H procedure (single-call window):**

1. Confirm **no other** inbound PSTN traffic during the window.
2. Set `VOICE_V4_LIVE_CANARY_ALLOWLIST=bridge:` (matches `external_call_id`; see section D).
3. Apply canary env, restart voice-bridge, place **one** supervised QA call.
4. Verify `call_handler selected=v4_canary` in logs.
5. Roll back env immediately after the call.

**Optional stricter procedure (two-call, still v3 on first call):**

1. Call #1 with empty allowlist → stays **v3**; note `bridge_call_id` in logs (for audit only).
2. Do **not** reuse that UUID for call #2 — it will not match.
3. For call #2, use `bridge:` allowlist (above) or stop and request a code follow-up for a static QA marker.

**Phase 10H blocker (document if `bridge:` cannot be used):** Without `bridge:` or a code change, random per-call UUIDs prevent pre-provisioned allowlist for PSTN canary.

---

## C. Production-safe baseline env (default / rollback target)

Edit `/opt/technolohit-voice/voice-bridge/.env`:

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_CANARY_ENABLED=false
VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=false
VOICE_V4_LIVE_CANARY_ALLOWLIST=
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_V4_STT_PROVIDER=mock
VOICE_V4_TTS_PROVIDER=mock
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=false
VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED=false
```

Restart after rollback:

```bash
cd /opt/technolohit-voice/asterisk
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.19.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

(v1.19.0 code with v3 flags is the intended production-safe state until v4 GA is approved.)

---

## D. Supervised canary env matrix (QA window only)

Edit `/opt/technolohit-voice/voice-bridge/.env` — **only** during the window:

```env
VOICE_RUNTIME_VERSION=v4
VOICE_V4_REALTIME_ENABLED=true
VOICE_V4_CANARY_ENABLED=true
VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=true
VOICE_V4_LIVE_CANARY_ALLOWLIST=bridge:
VOICE_V4_STT_PROVIDER=openai
VOICE_V4_TTS_PROVIDER=openai
VOICE_V4_BARGE_IN_ENABLED=true
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=false
VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED=false
```

Keep existing `OPENAI_API_KEY`, `VOICE_AGENT_CONFIG_PATH`, `VOICE_RAG_API_URL=http://127.0.0.1:8080`, VAD/barge-in thresholds unless ops standard says otherwise.

Restart:

```bash
cd /opt/technolohit-voice/asterisk
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.19.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
sleep 3
docker exec technolohit-voice-bridge sh -lc \
  'printenv | sort | egrep "^(VOICE_RUNTIME_VERSION|VOICE_V4_|VOICE_RAG_|VOICE_V4_TTS_PROVIDER|VOICE_V4_STT_PROVIDER)=" || true'
```

Also verify the host source-of-truth file:

```bash
grep -E '^(VOICE_RUNTIME_VERSION|VOICE_V4_|VOICE_RAG_|VOICE_V4_TTS_PROVIDER|VOICE_V4_STT_PROVIDER)=' \
  /opt/technolohit-voice/voice-bridge/.env
```

---

## E. Live QA scenarios

Use one supervised call for scenarios 2–11 where possible. Mark pass/fail in the report template.

| ID | Scenario | Pass criteria (logs / behavior) |
|----|----------|----------------------------------|
| E1 | v3 baseline before canary | Section A.6 — handler v3, no `[v4-live]` |
| E2 | v4 route selected | `[voice-bridge] call_handler selected=v4_canary` |
| E3 | Greeting heard | Caller hears normal greeting audio (v4 uses `skipAssistant` greeting path) |
| E4 | VAD speech start + endpoint | `[v4-live] vad_speech_started` and `vad_endpoint_detected` |
| E5 | STT completed | `[v4-live] stt_started stt_provider=openai` and `stt_completed stt_provider=openai` (no raw transcript in log line unless `VOICE_ASSISTANT_LOG_TRANSCRIPT_PREVIEW=true`) |
| E5a | Full utterance sent to STT (10K) | For multi-frame utterances, SQL diagnostics on `stt_completed` rows where `payload ? 'pcm_bytes'` show `pcm_bytes` much larger than `320`; `wav_bytes = pcm_bytes + 44`. A one-frame `pcm_bytes=320` with high `utterance_frames` is a fail. |
| E5b | STT failure fallback (10J) | If STT fails: `[v4-live] stt_failed … http_status=…` then `stt_fallback_started` / `stt_fallback_completed`; caller hears short retry prompt — **not** long silence |
| E5c | Goodbye / closing (10M) | After product Q&A, say **Auf Wiederhören** → warm goodbye (no open-ended “anything else?”) |
| E5d | Summary + latency SQL (10M) | G.3 returns `live_call_quality_summary`; G.3b shows `turn_latency_metrics` |
| E5e | Interruption follow-up (10N) | During playback: **Stopp, ich habe eine kurze Frage** → acknowledgement (not “nicht verstanden”); then **Was kostet das?** → bounded playbook answer |
| E5f | Barge-in quality (10N) | G.3c: `barge_in_detected` row present; logs must not show `quality_flush_skip_event` for that type |
| E6 | Dialogue plan | `[v4-live] dialogue_plan_created` |
| E7 | OpenAI TTS playback | `[v4-live] tts_completed` + `playback_started`; speech intelligible; no choppy overlap (see `silence_writer_paused` / `silence_writer_resumed`) |
| E8 | Barge-in | During assistant playback, caller speaks; `barge_in_detected`, `playback_cancelled` |
| E9 | Interruption product switch 1 | Say interest in **Digitale Rezeption** / voice agent → barge-in → say **Smart Website** → product updates |
| E10 | Interruption product switch 2 | From **Smart Website** context → barge-in → say **AI Voice Assistant** (alias for Digitale Rezeption product) or explicit switch utterance |
| E11 | Quality flush | `[v4-live] quality_flush_completed inserted_count=` (may be 0 if buffer empty; >0 if events buffered) |
| E12 | SQL summary + close | Rows for `live_call_quality_summary` and `audio_session_closed` for session UUID |
| E13 | Privacy | No `+49…` / long digit runs in `[v4-live]` logs or quality payloads (section G.4) |
| E14 | Restore v3 | Section C env; new call → `call_handler selected=v3` |

### E.9 / E.10 utterance hints (German, no phone numbers)

Agent catalog: `voice-bridge/config/agents/technolohit.main_voice_sales.v4.json`

1. **Digitale Rezeption:** e.g. “Ich interessiere mich für die digitale Rezeption.”
2. **Barge-in + Smart Website:** during playback, “Stopp — ich meine Smart Website.”
3. **Barge-in + voice agent / AI Voice Assistant:** during playback, “Stopp — ich meine den AI Voice Assistant.” (maps to product `voice_agent` / Digitale Rezeption)

Do not speak phone numbers during QA.

### E.8 barge-in tip

Wait until assistant is speaking (TTS playback). Speak clearly for ~0.5–1 s (multiple 20 ms frames). Expect cancel within configured `VOICE_V4_BARGE_IN_MIN_PLAYBACK_MS`.

---

## F. Logs to collect (privacy-safe)

During and after the canary call:

```bash
QA_STAMP="$(date -u +%Y%m%dT%H%MZ)"
docker logs --since=30m technolohit-voice-bridge 2>&1 \
  | grep -vEi 'api[_-]?key|password|secret|Bearer |OPENAI_API_KEY' \
  | grep -vE '\+?[0-9]{8,}' \
  | egrep '\[v4-live\]|quality_flush|barge_in|stt_|tts_|playback_|dialogue|call_end|call_handler selected=|silence_writer_|call_finish_persisted|\[voice-runtime\]' \
  > "/tmp/voice-bridge-10h-${QA_STAMP}.log"
wc -l "/tmp/voice-bridge-10h-${QA_STAMP}.log"
```

**Do not** paste full `.env`, API keys, raw transcripts, or assistant text into tickets.

Useful single-call checklist in logs:

| Pattern | Expected |
|---------|----------|
| `call_handler selected=v4_canary` | Once per canary call |
| `[v4-live] call_start handler=v4_canary` | Once |
| `vad_speech_started` / `vad_endpoint_detected` | Per caller turn |
| `stt_started stt_provider=openai` / `stt_completed stt_provider=openai` | Per caller turn (reject mock) |
| `silence_writer_paused` / `silence_writer_resumed` | Around assistant playback |
| `call_finish_persisted` | On hangup/close (session end path) |
| `dialogue_plan_created` | After STT |
| `tts_completed` / `playback_started` | Per assistant reply |
| `barge_in_detected` / `playback_cancelled` | On interruption test |
| `quality_flush_started` / `quality_flush_completed` | On hangup |
| `[v4-live] call_end` | On hangup |

Capture `call_session_id` from log lines (UUID), not caller phone.

---

## G. SQL verification

Use `call_session_id` from section F (UUID). Replace `<CALL_SESSION_ID>` below.

### G.1 Latest v4 quality rows for session

```sql
SELECT
  cqe.created_at,
  cqe.event_type,
  cqe.event_stage,
  cqe.metric_name,
  cqe.metric_value,
  cqe.payload->>'live_phase' AS live_phase,
  cqe.payload->>'runtime_version' AS runtime_version
FROM voice.call_quality_events cqe
WHERE cqe.call_session_id = '<CALL_SESSION_ID>'::uuid
ORDER BY cqe.created_at ASC;
```

### G.2 Event type counts per call

```sql
SELECT event_type, count(*) AS n
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
GROUP BY event_type
ORDER BY n DESC;
```

### G.3 Summary event (Phase 10G / 10M — required after canary)

**Pass:** ≥ 1 row with `event_type = 'live_call_quality_summary'`.
If 0 rows but logs show `quality_flush_completed`, check v1.24.0+ (10M UUID validation fix).

```sql
SELECT
  created_at,
  event_type,
  payload->>'live_phase' AS live_phase,
  payload->>'close_reason' AS close_reason,
  payload->'live_counters'->>'endpoint_count' AS endpoint_count,
  payload->'live_counters'->>'stt_completed_count' AS stt_completed_count,
  payload->'live_counters'->>'tts_completed_count' AS tts_completed_count,
  payload->'live_counters'->>'barge_in_count' AS barge_in_count,
  payload->'turn_latency'->>'dialogue_plan_to_tts_started_ms' AS dialogue_plan_to_tts_started_ms,
  payload->'turn_latency'->>'tts_started_to_first_chunk_ms' AS tts_started_to_first_chunk_ms,
  payload->'turn_latency'->>'endpoint_to_first_playback_ms' AS endpoint_to_first_playback_ms,
  payload->'turn_latency'->>'total_turn_response_ms' AS total_turn_response_ms
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'live_call_quality_summary';
```

**Pass (10N):** On a successful STT→dialogue→TTS→playback turn, `dialogue_plan_to_tts_started_ms`, `tts_started_to_first_chunk_ms`, and `endpoint_to_first_playback_ms` should be **non-NULL**.

### G.3b Turn latency metrics (Phase 10M)

```sql
SELECT
  created_at,
  metric_value AS total_turn_response_ms,
  payload->>'endpoint_to_stt_completed_ms' AS endpoint_to_stt_completed_ms,
  payload->>'stt_completed_to_dialogue_plan_ms' AS stt_completed_to_dialogue_plan_ms,
  payload->>'dialogue_plan_to_tts_started_ms' AS dialogue_plan_to_tts_started_ms,
  payload->>'tts_started_to_first_chunk_ms' AS tts_started_to_first_chunk_ms,
  payload->>'endpoint_to_first_playback_ms' AS endpoint_to_first_playback_ms
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'turn_latency_metrics'
ORDER BY created_at DESC
LIMIT 5;
```

### G.3c Barge-in detected (Phase 10N)

```sql
SELECT created_at, event_type, metric_value AS cancel_latency_ms
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'barge_in_detected'
ORDER BY created_at;
```

**Pass:** ≥ 1 row when caller interrupted assistant playback. **Fail:** 0 rows but logs show `barge_in_detected` or `quality_flush_skip_event event_type=barge_in_detected` (upgrade to v1.25.0+).

### G.4 Session close + privacy-oriented payload scan

```sql
SELECT event_type, created_at
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type IN ('audio_session_closed', 'live_call_quality_summary');
```

```sql
-- Fail if raw phone-like pattern appears in payloads (no phone columns selected).
-- Version fields intentionally contain date-like numbers and are excluded from this scan.
SELECT id, event_type
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND (
    payload
      - 'runtime_version'
      - 'agent_config_version'
      - 'prompt_playbook_version'
      - 'knowledge_version'
  )::text ~ '\+?\d{8,}';
```

**Pass:** zero rows on G.4 phone scan; summary + close rows present when flush ran with events.

### G.5 Failed flush / runtime errors (if suspected)

```sql
SELECT created_at, event_type, payload->>'error_class' AS error_class, payload->>'event_subtype' AS subtype
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'runtime_error'
ORDER BY created_at;
```

### G.6 STT failure diagnostics (Phase 10J)

```sql
SELECT
  created_at,
  metric_value AS stt_ms,
  payload->>'stt_provider' AS stt_provider,
  payload->>'stt_error_code' AS stt_error_code,
  payload->>'stt_http_status' AS stt_http_status,
  payload->>'stt_error_type' AS stt_error_type,
  payload->>'pcm_bytes' AS pcm_bytes,
  payload->>'wav_bytes' AS wav_bytes,
  payload->>'utterance_frames' AS utterance_frames,
  payload->>'utterance_duration_ms' AS utterance_duration_ms,
  payload->>'stt_failed_fallback_prompted' AS fallback_prompted,
  payload->>'event_subtype' AS event_subtype
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'runtime_error'
  AND payload->>'error_class' = 'stt_failed'
ORDER BY created_at;
```

**Pass:** rows explain failure (HTTP status / error code / byte counts). **No** transcript or API key in payload text.

### G.7 Successful STT buffer metrics (Phase 10K)

```sql
SELECT
  created_at,
  metric_value AS stt_ms,
  payload->>'stt_provider' AS stt_provider,
  payload->>'stt_http_status' AS stt_http_status,
  payload->>'utterance_frames' AS utterance_frames,
  payload->>'pcm_bytes' AS pcm_bytes,
  payload->>'wav_bytes' AS wav_bytes,
  payload->>'wav_bytes_minus_pcm_bytes' AS wav_bytes_minus_pcm_bytes,
  payload->>'sample_rate' AS sample_rate,
  payload->>'utterance_duration_ms' AS utterance_duration_ms
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'stt_completed'
  AND payload ? 'pcm_bytes'
ORDER BY created_at;
```

**Pass:** for normal multi-frame utterances, `pcm_bytes > 320`, `wav_bytes = pcm_bytes + 44`, `wav_bytes_minus_pcm_bytes = 44`, and `stt_http_status` is 2xx. **Fail:** high `utterance_frames` with `pcm_bytes=320`.

See also [voice_assistant_v4_phase8_quality_analytics_queries.sql](./voice_assistant_v4_phase8_quality_analytics_queries.sql) (live summary query at end).

---

## H. Stop criteria (rollback immediately)

Stop the window and run section I if **any** occur:

| # | Condition |
|---|-----------|
| H1 | Call drops / silent line / no greeting |
| H2 | Garbled or unusable assistant audio |
| H3 | Assistant does not stop speaking after caller interruption (barge-in) |
| H4 | Repeated `[v4-live] stt_failed` without `stt_fallback_completed` (caller hears long silence) |
| H5 | Repeated `[v4-live] tts_failed` / no playback |
| H6 | `quality_flush_failed` with `relation` / missing table **after** migration 009 was verified |
| H7 | Raw phone pattern in `[v4-live]` logs or SQL payload scan (G.4) |
| H8 | `call_handler selected=v4_canary` on a call **outside** maintenance / wrong allowlist |
| H9 | v3 baseline (E14) fails after rollback |
| H10 | Unexpected concurrent production traffic while `bridge:` allowlist active |

---

## I. Rollback commands (restore v3)

### I.0 Collect v4 logs before rollback (when possible)

Before reverting env, capture privacy-safe canary logs for post-mortem:

```bash
QA_STAMP="$(date -u +%Y%m%dT%H%MZ)"
docker logs --since=45m technolohit-voice-bridge 2>&1 \
  | grep -vEi 'api[_-]?key|password|secret|Bearer |OPENAI_API_KEY' \
  | grep -vE '\+?[0-9]{8,}' \
  | egrep '\[v4-live\]|stt_|tts_|call_finish_|active_call_|openai_stt_preflight' \
  > "/tmp/voice-bridge-10h-${QA_STAMP}-pre-rollback.log"
wc -l "/tmp/voice-bridge-10h-${QA_STAMP}-pre-rollback.log"
```

Then run section I.1–I.3.

### I.1 Restore env from backup

```bash
ls -lt /opt/technolohit-voice/voice-bridge/.env.pre-10h-*.bak | head -3
cp /opt/technolohit-voice/voice-bridge/.env.pre-10h-<STAMP>.bak \
  /opt/technolohit-voice/voice-bridge/.env
```

Or hand-edit to section C values (especially `VOICE_RUNTIME_VERSION=v3`, empty allowlist, `VOICE_V4_TTS_PROVIDER=mock`).

### I.2 Restart voice-bridge (immutable image — no `latest`)

```bash
cd /opt/technolohit-voice/asterisk
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.19.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
sleep 3
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
docker logs --tail=20 technolohit-voice-bridge 2>&1 | grep -E 'voice-runtime|voice-bridge'
```

### I.3 Verify v3 on host env

```bash
grep -E '^(VOICE_RUNTIME_VERSION|VOICE_V4_LIVE_AUDIOSOCKET_ENABLED|VOICE_V4_LIVE_CANARY_ALLOWLIST|VOICE_V4_TTS_PROVIDER)=' \
  /opt/technolohit-voice/voice-bridge/.env
```

**Expected:** `VOICE_RUNTIME_VERSION=v3`, live gates false, allowlist empty, `VOICE_V4_TTS_PROVIDER=mock`.

### I.4 Optional — rollback image only (if v1.19.0 faulty)

```bash
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.11.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

Keep section C v3 flags regardless of image tag.

### I.5 Post-rollback v3 call

Repeat section A.6 / scenario E14. **Must pass** before closing the ticket.

---

## J. Sysadmin report

Copy [voice_assistant_v4_phase10h_live_qa_report.md](./voice_assistant_v4_phase10h_live_qa_report.md) into the ticket when complete.

---

## Phase references (10A–10G)

| Phase | Report |
|-------|--------|
| 10A | [voice_assistant_v4_phase10a_live_route_selection_report.md](./voice_assistant_v4_phase10a_live_route_selection_report.md) |
| 10B | [voice_assistant_v4_phase10b_vad_endpointing_report.md](./voice_assistant_v4_phase10b_vad_endpointing_report.md) |
| 10C | [voice_assistant_v4_phase10c_live_stt_report.md](./voice_assistant_v4_phase10c_live_stt_report.md) |
| 10D | [voice_assistant_v4_phase10d_live_dialogue_report.md](./voice_assistant_v4_phase10d_live_dialogue_report.md) |
| 10E | [voice_assistant_v4_phase10e_live_tts_playback_report.md](./voice_assistant_v4_phase10e_live_tts_playback_report.md) |
| 10E2 | [voice_assistant_v4_phase10e2_real_tts_report.md](./voice_assistant_v4_phase10e2_real_tts_report.md) |
| 10F | [voice_assistant_v4_phase10f_live_barge_in_report.md](./voice_assistant_v4_phase10f_live_barge_in_report.md) |
| 10G | [voice_assistant_v4_phase10g_quality_flush_report.md](./voice_assistant_v4_phase10g_quality_flush_report.md) |

---

## Production v4 status after 10H

| Outcome | Meaning |
|---------|---------|
| **pass** | Supervised canary path validated; **still** not production v4 for all calls |
| **partial** | Some scenarios failed; keep v3; open engineering ticket |
| **fail** | Do not retry without fix; v3 rollback required |
| **unsafe** | Privacy or routing safety failure; stop immediately |

Production v4 GA remains blocked until: live QA pass, production blocker list in blueprint, and explicit leadership approval for Phase 9c.
