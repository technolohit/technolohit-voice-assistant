# TechnoloHit Voice Assistant v4 — Phase 9b Supervised Canary Validation Blueprint

Date: 2026-06-01  
Status: **Blueprint/runbook prepared — not executed; production v4 NOT enabled**  
Prior: [Phase 9 production rollout report](./voice_assistant_v4_phase9_production_rollout_report.md) (dry run **passed**)  
Operator runbook: [voice_assistant_v4_phase9b_sysadmin_canary_runbook.md](./voice_assistant_v4_phase9b_sysadmin_canary_runbook.md)

---

## A. Executive status

| Item | Status |
|------|--------|
| Phase 9 dry run | **Passed** (2026-06-01) |
| Production voice-bridge image | `thnhit/technhvoice:voice-bridge-v1.11.0` |
| Production runtime | **v3** (`VOICE_RUNTIME_VERSION=v3`) |
| All v4 / RAG canary flags | **Off** |
| `voice.call_quality_events` during v3 test | **0** (no v4 flush on v3 path) |
| Phase 9b scope | **Supervised validation plan only** — no flag enablement in this deliverable |
| Production v4 acceptance | **Not approved** |
| Phase 9b success | **Does not** automatically approve full production v4 |

Phase 9b is a **maintenance-window playbook** for a future, explicitly approved test. Completing Phase 9b validates operator procedure, env safety, and (when live wiring exists) v4 behavior under supervision. It is **not** production v4 rollout.

### v1.11.0 live-call wiring reality (critical)

In tag `v1.11.0`, v4 modules exist but **live AudioSocket calls still use the v3 `turn-assistant` path**. The v4 router returns `active: false` / `stub: true` for canary routes, and `routeAudioSocketCall` requires `harnessExplicit` (test harness only — not set from env on live calls).

Therefore Phase 9b has **two validation tiers**:

| Tier | Purpose | When |
|------|---------|------|
| **9b-A — Env & routing intent** | Verify flags, startup logs, v3 baseline calls, rollback, no quality DB writes on v3 | **Now** (v1.11.0) |
| **9b-B — Live v4 dialogue canary** | Full call QA matrix (orchestrator, RAG, lead, barge-in, quality flush) | **After** live AudioSocket → v4 canary wiring ships **or** on isolated test host with harness |

Do not interpret Tier 9b-A pass as full v4 production readiness.

---

## B. Preconditions before Phase 9b canary

All items must be checked **before** any env change. Blockers remain **open** until explicitly signed off — do not mark as solved in reports.

| # | Precondition | Status (2026-06-01) | Sign-off |
|---|--------------|---------------------|----------|
| 1 | Retention approval by Mojtaba (Founder) | Pending or explicit written approval | ☐ |
| 2 | Backup/encryption status recorded (pre-canary dump + off-host storage) | Dry-run backup exists; encryption policy confirmation pending | ☐ |
| 3 | QA route **or** maintenance-window plan confirmed (single low-traffic window) | Dedicated QA route pending | ☐ |
| 4 | Overload fallback decided **or** explicit low-risk single-call test accepted | Pending | ☐ |
| 5 | OpenAI streaming/realtime limits checked **or** test limited to non-streaming scope | Pending quota review | ☐ |
| 6 | Rollback image/tag recorded | `thnhit/technhvoice:voice-bridge-v1.3.4` (pre–Phase 9) | ☐ |
| 7 | Sysadmin on host during entire window | Required | ☐ |
| 8 | Codex/operator observing logs (redacted) | Required | ☐ |
| 9 | Reports use call session IDs only — **no full phone numbers** | Required | ☐ |
| 10 | Team written approval for Phase 9b window | Required | ☐ |
| 11 | RAG co-deploy decision recorded (see section C) | See below | ☐ |

**Gate:** If items 1, 3, or 10 are not satisfied, limit Phase 9b to **Tier 9b-A** (env verification + v3 baseline only) on production. Do not enable v4 flags on production.

---

## C. RAG decision for Phase 9b

### Current production facts (post–Phase 9 dry run)

| Item | Value |
|------|--------|
| voice-bridge RAG URL (host network) | `http://127.0.0.1:8080` |
| `VOICE_RAG_ENABLED` | `false` |
| `VOICE_RAG_SALES_ANSWERER_ENABLED` | `false` |
| rag-api image | **Not** co-deployed to `rag-api-v1.11.0` during dry run (previous image still running) |
| RAG health via host-local URL | Passed during dry run |

### Decision matrix

| Test goal | rag-api-v1.11.0 co-deploy? | RAG flags |
|-----------|----------------------------|-----------|
| Tier 9b-A only (routing/env, v3 calls) | **No** (optional) | Keep `VOICE_RAG_ENABLED=false` |
| v4 RAG canary scenarios (Tier 9b-B) | **Yes — required first** | Enable only during supervised window: `VOICE_RAG_ENABLED=true`, `VOICE_RAG_SALES_ANSWERER_ENABLED=true` |
| v4 routing without RAG | Co-deploy optional | Keep RAG flags `false` |

**Recommended order for Tier 9b-B:**

1. Co-deploy `thnhit/technhvoice:rag-api-v1.11.0` (GitHub Actions or manual — see Phase 9 runbook §8).
2. Verify `curl -fsS http://127.0.0.1:8080/healthz` from host and from voice-bridge exec context.
3. Only then enable RAG flags for RAG-specific scenarios.
4. Revert RAG flags immediately after RAG scenarios complete.

Do **not** use Docker DNS `http://technolohit-rag-api:8080` from voice-bridge in the current host-network layout.

---

## D. Canary flag matrix

### 1. Baseline safe production (current — do not change without approval)

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_CANARY_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_V4_STREAMING_STT_ENABLED=false
VOICE_V4_STREAMING_TTS_ENABLED=false
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
VOICE_RAG_API_URL=http://127.0.0.1:8080
```

**Expected v1.11.0 startup log:** `[voice-runtime] selected=v3 v4_active=true reason=default_v3` — `v4_active=true` here means the route object is loaded; **`selected=v3` and env flags are authoritative**.

### 2. Non-production / test-host canary — **TEST HOST ONLY**

Never apply to production default. Use an isolated host or CI harness.

```env
# === NOT PRODUCTION ===
VOICE_RUNTIME_VERSION=v4
VOICE_V4_REALTIME_ENABLED=true
VOICE_V4_CANARY_ENABLED=true
VOICE_V4_STREAMING_STT_ENABLED=false
VOICE_V4_STREAMING_TTS_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
VOICE_RAG_API_URL=http://127.0.0.1:8080
VOICE_TENANT_ID=technolohit
VOICE_AGENT_ID=main_voice_sales
VOICE_AGENT_CONFIG_PATH=/app/config/agents/technolohit.main_voice_sales.v4.json
VOICE_LOG_TRANSCRIPT_PREVIEW=false
```

Repo validation (no live PSTN): `npm test` in `voice-bridge/` with v4 phase tests; harness uses `harnessExplicit: true`.

Optional RAG on test host:

```env
VOICE_RAG_ENABLED=true
VOICE_RAG_SALES_ANSWERER_ENABLED=true
```

### 3. Production maintenance-window supervised canary — **ONLY IF EXPLICITLY APPROVED**

Maximum window: **30 minutes** active canary flags; revert to baseline (§1) immediately after.

**Minimal flag set — routing / stub verification (Tier 9b-A):**

```env
# TEMPORARY — maintenance window only; revert after test
VOICE_RUNTIME_VERSION=v4
VOICE_V4_REALTIME_ENABLED=true
VOICE_V4_CANARY_ENABLED=true
VOICE_V4_STREAMING_STT_ENABLED=false
VOICE_V4_STREAMING_TTS_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
```

**Expected startup (v1.11.0):** `selected=v4` with `reason=v4_canary_dialogue_stub_phase5` or similar — **live calls may still hit v3** until wiring lands. Document observed behavior; do not assume v4 dialogue without log/call evidence.

**Extended set — Tier 9b-B scenarios (only after live wiring + approvals):**

| Scenario block | Additional flags |
|----------------|------------------|
| RAG product Q&A | `VOICE_RAG_ENABLED=true`, `VOICE_RAG_SALES_ANSWERER_ENABLED=true`, rag-api-v1.11.0 co-deployed |
| Barge-in | `VOICE_V4_BARGE_IN_ENABLED=true` (single-call test only) |
| Streaming STT/TTS | `VOICE_V4_STREAMING_STT_ENABLED=true` / `VOICE_V4_STREAMING_TTS_ENABLED=true` — **only if OpenAI limits approved** |

Do **not** enable broad production v4 by default. One scenario block at a time; revert between blocks.

---

## E. Test scenarios (call QA matrix)

Use `call_session_id` / bridge call id in reports — never full callee/caller numbers.

| ID | Scenario | Tier | Pass criteria |
|----|----------|------|---------------|
| S0 | Startup / env verification | 9b-A | Image `voice-bridge-v1.11.0`; flags match intended matrix; agent config loads |
| S1 | v3 baseline call **before** any canary flag change | 9b-A | Call completes; assistant behaves as today; quality events count unchanged |
| S2 | Canary route / flag verification (post flag change, pre-call) | 9b-A | Startup log shows expected `selected=` / `reason=`; container env matches matrix |
| S3 | Product question: Smart Website | 9b-B | Answers from playbook/RAG; no contact re-intake |
| S4 | Product question: Digitale Rezeption / AI Voice Assistant | 9b-B | Same as S3 |
| S5 | Interruption / barge-in (if path supports) | 9b-B | Playback stops; recovery without loop; `playback_cancelled` events if quality flush active |
| S6 | Contact preference: email | 9b-B | Email captured; lead policy respected |
| S7 | Contact preference: phone with caller ID | 9b-B | Valid callback path; no raw phone in logs/notifications |
| S8 | Invalid/incomplete phone | 9b-B | **No** callback-ready lead; `lead_skipped` or equivalent |
| S9 | Post-contact product question | 9b-B | Does **not** restart intake |
| S10 | RAG question (if RAG enabled) | 9b-B | `rag_retrieval_completed` or safe fallback; RAG must not answer contact/permission/lead prompts |
| S11 | Closing behavior | 9b-B | Clean hangup; post-call pipeline OK or documented skip on stub |
| S12 | Rollback test | 9b-A | Revert flags + optional image; v3 call OK |

Mark Tier 9b-B scenarios **N/A — v1.11.0 live wiring** until live v4 path is confirmed in release notes.

---

## F. Metrics to collect

### From `voice.call_quality_events` (v4 path only — expect **no rows** on pure v3)

Reference: [voice_assistant_v4_phase8_quality_analytics_queries.sql](./voice_assistant_v4_phase8_quality_analytics_queries.sql)

| Metric / event | event_type or field |
|----------------|---------------------|
| Call started / closed | `call_started`, `audio_session_closed` |
| Turn count | count of `turn_started` per `call_session_id` |
| STT latency | `stt_completed` / `stt_final`, `metric_name` `stt_ms` / `stt_final_ms` |
| TTS latency | `tts_completed`, `metric_name` `tts_ms` |
| RAG used / failed | `rag_retrieval_completed`, `rag_retrieval_failed` |
| Barge-in cancel latency | `playback_cancelled`, `metric_name` `cancel_latency_ms` |
| Lead created / skipped | `lead_created`, `lead_skipped` |
| Post-call error | `post_call_error` |
| Runtime error | `runtime_error` |
| Privacy | No raw phone in `payload`; `privacy_ok` events if emitted |

### From logs (redacted)

- `[voice-runtime]` startup line
- Per-call handler selection if logged
- RAG fetch errors (no API keys)
- Post-call notify errors (no webhook secrets)

### Latency thresholds (stop if exceeded repeatedly — 3+ turns)

| Metric | Warning | Stop |
|--------|---------|------|
| STT p95 per call | > 800 ms | > 1500 ms |
| TTS p95 per call | > 1200 ms | > 2500 ms |
| Barge-in cancel | > 400 ms | > 800 ms |

---

## G. SQL queries

Base runbook: [voice_assistant_v4_phase8_quality_analytics_queries.sql](./voice_assistant_v4_phase8_quality_analytics_queries.sql)

### Phase 9b-specific snippets (privacy-safe)

**Count before / after canary window:**

```sql
SELECT count(*) AS total_events
FROM voice.call_quality_events;

SELECT count(*) AS events_last_30m
FROM voice.call_quality_events
WHERE created_at >= now() - interval '30 minutes';
```

**Events by call_session_id (replace placeholder):**

```sql
SELECT event_type, event_stage, metric_name, metric_value,
       payload->>'runtime_version' AS runtime_version,
       payload->>'fallback_reason' AS fallback_reason,
       created_at
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'
ORDER BY created_at;
```

**Errors in last 30 minutes:**

```sql
SELECT call_session_id, event_type, event_stage,
       payload->>'error_class' AS error_class,
       left(payload->>'message', 120) AS message_truncated,
       created_at
FROM voice.call_quality_events
WHERE event_type IN ('runtime_error', 'post_call_error')
  AND created_at >= now() - interval '30 minutes'
ORDER BY created_at DESC;
```

**Lead events in last 30 minutes (no phone fields):**

```sql
SELECT call_session_id, event_type,
       payload->>'reason' AS reason,
       payload->>'next_action' AS next_action,
       created_at
FROM voice.call_quality_events
WHERE event_type IN ('lead_created', 'lead_skipped')
  AND created_at >= now() - interval '30 minutes'
ORDER BY created_at DESC;
```

**RAG failures in last 30 minutes:**

```sql
SELECT call_session_id,
       payload->>'fallback_reason' AS fallback_reason,
       created_at
FROM voice.call_quality_events
WHERE event_type = 'rag_retrieval_failed'
  AND created_at >= now() - interval '30 minutes'
ORDER BY created_at DESC;
```

**Privacy scan — payloads must not contain long digit sequences:**

```sql
SELECT call_session_id, event_type, created_at
FROM voice.call_quality_events
WHERE payload::text ~ '[0-9]{8,}'
  AND created_at >= now() - interval '24 hours'
LIMIT 20;
```

Expected: **zero rows** (timestamps/version strings should not match if sanitization works).

---

## H. Stop / rollback criteria

### Immediate stop if any occur

- Container env flags differ from approved matrix
- Unexpected `VOICE_RUNTIME_VERSION` or v4 flag enabled outside window
- Call drops unexpectedly or AudioSocket disconnects mid-test
- Assistant loops, silence deadlock, or cannot recover after 2 retries
- Quality event payloads match phone pattern query (section G)
- Full phone number appears in logs, webhook payload, or operator report
- Lead created incorrectly or `callback_ready` without valid phone + permission
- RAG answers contact capture, permission, or lead-validation questions
- STT/TTS/barge-in latency exceeds stop threshold on 3+ consecutive turns
- Post-call pipeline errors (`post_call_error`) on canary calls
- Any uncertainty about public exposure, recording retention, or privacy

### Rollback procedure (summary)

Full commands: [Phase 9 sysadmin runbook §11](./voice_assistant_v4_phase9_sysadmin_runbook.md) and [Phase 9b sysadmin runbook](./voice_assistant_v4_phase9b_sysadmin_canary_runbook.md).

1. Restore env backup (baseline §D.1).
2. `docker compose ... up -d voice-bridge` (no restart-only if env changed).
3. Verify `selected=v3`, all v4 flags `false`.
4. Optional: pin `voice-bridge-v1.3.4` if code rollback needed (schema forward-only OK).
5. Place one v3 verification call.
6. Confirm quality events did not grow unexpectedly after revert.

---

## I. Reporting template for Sysadmin

Copy into ticket/email after window (redact secrets and phone numbers):

```text
=== Phase 9b Supervised Canary Report ===
Date (UTC):
Operator:
Observer (Codex/engineering):
Maintenance window start/end (UTC):

--- Images ---
voice-bridge before:
voice-bridge after:
rag-api before:
rag-api after:

--- Env flags (names + true/false only) ---
BEFORE: VOICE_RUNTIME_VERSION=  VOICE_V4_REALTIME=  VOICE_V4_CANARY=  VOICE_V4_BARGE_IN=
        VOICE_V4_STREAMING_STT=  VOICE_V4_STREAMING_TTS=  VOICE_RAG_ENABLED=  VOICE_RAG_SALES_ANSWERER=
AFTER:  (same fields)

--- Call identifiers (no phone numbers) ---
call_session_id / bridge_call_id list:

--- quality_events ---
count before window:
count after window:
delta:

--- SQL summary (paste counts / truncated rows only) ---
errors_30m:
lead_events_30m:
rag_failures_30m:
phone_pattern_scan:

--- Scenario results ---
S0 startup/env:
S1 v3 baseline:
S2 flag verification:
S3 Smart Website:  PASS / FAIL / N/A
S4 Digitale Rezeption:  PASS / FAIL / N/A
S5 barge-in:  PASS / FAIL / N/A
S6 email contact:  PASS / FAIL / N/A
S7 phone + caller ID:  PASS / FAIL / N/A
S8 invalid phone:  PASS / FAIL / N/A
S9 post-contact product Q:  PASS / FAIL / N/A
S10 RAG:  PASS / FAIL / N/A
S11 closing:  PASS / FAIL / N/A
S12 rollback:  PASS / FAIL / N/A

--- Human observations ---
(brief, no transcripts with PII)

--- Incidents ---
rollback used?  YES / NO
privacy incidents?  YES / NO
stop criteria triggered?  YES / NO — which:

--- Recommendation ---
Tier 9b-A:  PASS / FAIL
Tier 9b-B:  PASS / FAIL / NOT RUN (reason)
Production v4 enablement:  NOT RECOMMENDED / DEFER / (requires separate approval)

Blockers still open: retention / backup encryption / QA route / overload / OpenAI limits
```

---

## J. Remaining production blockers (unchanged)

These **block production v4 enablement**. They **do not block** staying on v1.11.0 with v3 active.

| Blocker | Owner |
|---------|--------|
| Final retention approval | Mojtaba, Founder of TechnoloHit |
| Backup/encryption confirmation | Sysadmin |
| Dedicated QA phone/route | Operations |
| Overload fallback destination | Architecture/ops |
| OpenAI streaming/realtime limits | Provider quota review |

Additional: live AudioSocket → v4 canary wiring not present in v1.11.0 (Tier 9b-B blocked on production until shipped).

---

## Recommendation

| Audience | Verdict |
|----------|---------|
| Codex / engineering review | **Ready** — blueprint and runbook are complete for review |
| Sysadmin execution | **Not yet** — await team approval + precondition sign-off |
| Production v4 enablement | **Not ready** — blockers open; Phase 9b success ≠ v4 GA |

**Next step:** Team reviews Phase 9b docs → explicit approval → Sysadmin schedules Tier 9b-A maintenance window (env verification + v3 baseline + rollback drill only, unless wiring release changes scope).
