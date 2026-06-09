# TechnoloHit Voice Assistant v4 — Phase 10AF Live RAG Timeout Retry

Date: 2026-06-09  
Status: **Implemented — pending release and one-call Gate 3 retry**

Superseded for release by [Phase 10AG](./voice_assistant_v4_phase10ag_rag_retrieve_timeout_config_report.md):
v1.34.7 still used the 700 ms retrieve budget in preflight. v1.34.8 adds retrieve-specific
timeout/max-attempt configuration and should be used for the next Gate 3 attempt.

## Context

Phase 10AE / `voice-bridge-v1.34.6` produced a valid supervised Gate 3 v4/RAG-on live call, but the result was **PARTIAL**:

- The live call was valid and evaluable.
- Human observation was positive.
- The assistant answered the combined Smart Website question correctly.
- Post-call summary, privacy scan, stale-session check, and rollback passed.
- However, live RAG retrieval timed out at about 702 ms and the answer came from playbook fallback:
  - `rag_used=false`
  - `rag_fallback_used=true`
  - `rag_retrieval_failed=1`
  - `rag_result_count=0`

The preflight immediately before the call passed with repeated successful retrievals, so the remaining issue is live-call RAG jitter at the 700 ms budget, not missing knowledge.

## Decision

Add a bounded live retry for RAG timeout only.

The live path now retries once when the first retrieve attempt returns `reason=timeout`. It does **not** retry `rag_miss`, wrong product scope, low score, unsafe answer, or unavailable/non-timeout failures.

This keeps the call safe:

- RAG remains disabled by default.
- v4 remains disabled by default.
- If both attempts timeout, the assistant still uses the same safe playbook fallback.
- No raw transcript, query, phone, email, or lead details are written to quality payloads.

## Files Changed

| File | Change |
|------|--------|
| `voice-bridge/src/v4/rag-orchestrator.js` | Added live timeout retry helper and attempt metadata on RAG results |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Persists retry diagnostics in RAG quality events |
| `voice-bridge/tests/v4-phase10af-live-rag-timeout-retry.test.js` | New tests for timeout→hit retry, non-timeout no-retry, and safe quality payload |
| `docs/Tasks/voice_assistant_v4_phase10af_live_rag_timeout_retry_report.md` | This report |
| `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` | Current status and checklist updated |
| `docs/Tasks/voice_assistant_v4_phase10h_live_qa_runbook.md` | Gate 3 SQL updated with retry diagnostics |
| `docs/Tasks/voice_assistant_v4_phase10o_controlled_repeatability_and_rag_canary_plan.md` | Gate 3 status and preflight/live expectations updated |

## Runtime Behavior

When RAG is enabled in the v4 live canary path:

1. Attempt 1 uses `VOICE_RAG_TIMEOUT_MS` (currently 700 ms).
2. If attempt 1 succeeds, no retry.
3. If attempt 1 times out, attempt 2 uses the same timeout.
4. If attempt 2 succeeds, the live turn uses RAG and emits `rag_retrieval_completed`.
5. If attempt 2 fails or times out, the live turn uses the existing safe playbook fallback and emits `rag_retrieval_failed`.

## New Quality Fields

RAG quality events now include:

- `rag_attempt_count`
- `rag_success_count`
- `rag_timeout_count`
- `rag_attempt_fallback_reasons`
- `rag_total_latency_ms`

These are non-sensitive counters/latencies only.

## Verification

Local verification:

- `cd voice-bridge && npm test` → `467/467 pass`
- `node --check src/v4/rag-orchestrator.js src/v4/dialogue-orchestrator.js tests/v4-phase10af-live-rag-timeout-retry.test.js` → pass

Additional repo verification must be run before release:

- `python -m pytest rag-api/tests`
- `git diff --check`
- `run-ci-dialogue-scenarios.ps1`

## Gate 3 Retest Criteria

Use the normal supervised Gate 3 window, then place **one** live call only.

Pass criteria for the RAG portion:

- `rag_retrieval_completed >= 1`
- `rag_used=true`
- `rag_product_scope=smart_website`
- `rag_result_count > 0`
- If retry occurred:
  - `rag_attempt_count=2`
  - `rag_timeout_count=1`
  - `rag_attempt_fallback_reasons` includes `timeout`
- Corrected privacy scan returns 0 rows.
- No new stale active session.
- Rollback to v3/RAG-off succeeds.

## Recommendation

Do not run another Gate 3 live call on `v1.34.6` or `v1.34.7`; they can still fail around the
700 ms retrieve budget. Use `voice-bridge-v1.34.8` or newer.
