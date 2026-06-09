# TechnoloHit Voice Assistant v4 — Phase 10AG RAG Retrieve Timeout Config

Date: 2026-06-09  
Status: **Implemented — pending release and Gate 3 preflight/live retry**

## Context

Phase 10AF / `voice-bridge-v1.34.7` still failed before a live Gate 3 call because
`rag:retrieve-preflight` used the 700 ms runtime RAG budget and timed out on every attempt:

- `rag_retrieve_preflight=fail`
- `fallback_reason=rag_retrieve_timeout`
- `rag_latency_ms=701`
- `timeout_ms=700`
- `attempt_count=3`
- `success_count=0`

This is not a conversation/STT/TTS/product-context issue. The blocker is RAG retrieval latency
around the 700 ms boundary.

## Decision

Add a dedicated product-retrieval budget and share it between preflight and live RAG:

```env
VOICE_RAG_RETRIEVE_TIMEOUT_MS=1500
VOICE_RAG_RETRIEVE_MAX_ATTEMPTS=3
```

`VOICE_RAG_TIMEOUT_MS` remains available for legacy/general RAG timeout behavior. Gate 3 product
retrieval should use `VOICE_RAG_RETRIEVE_TIMEOUT_MS`, starting at 1500 ms. If the preflight is still
unstable, 2000 ms is the next controlled canary budget.

## Behavior

Both `rag:retrieve-preflight` and the v4 live RAG path now use:

- same timeout source: `config.rag.retrieveTimeoutMs`
- same max attempts source: `config.rag.retrieveMaxAttempts`
- same tenant/agent/product-scoped payload construction
- timeout-only retry
- stop immediately after the first successful hit
- safe playbook fallback only after all configured attempts fail

Preflight no longer keeps retrying after the first successful hit. This keeps preflight behavior
aligned with the live path.

## Files Changed

| File | Change |
|------|--------|
| `voice-bridge/src/config.js` | Adds `VOICE_RAG_RETRIEVE_TIMEOUT_MS` and `VOICE_RAG_RETRIEVE_MAX_ATTEMPTS` |
| `voice-bridge/src/v4/rag-retrieve-config.js` | New shared timeout/attempt resolver |
| `voice-bridge/src/v4/rag-orchestrator.js` | Live RAG uses shared retrieve timeout/max attempts |
| `voice-bridge/src/v4/rag-retrieve-preflight.js` | Preflight uses shared retrieve timeout/max attempts and stops after first hit |
| `voice-bridge/src/v4/rag-retrieve-probe.js` | Re-exports shared config helpers for diagnostics/preflight |
| `voice-bridge/tests/v4-phase10ag-rag-retrieve-timeout-config.test.js` | New tests for env config, preflight retry success, live retry success, and all-attempt fallback |
| `voice-bridge/.env.example` | Documents new retrieve-specific env |
| `docs/voice-bridge-runtime-env.md` | Documents new retrieve-specific env |
| `docs/Tasks/voice_assistant_v4_phase10h_live_qa_runbook.md` | Gate 3 instructions updated |
| `docs/Tasks/voice_assistant_v4_phase10o_controlled_repeatability_and_rag_canary_plan.md` | Gate 3 status updated |
| `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` | Current status updated |

## Gate 3 Requirements

Before the live call:

- `VOICE_RAG_RETRIEVE_TIMEOUT_MS=1500`
- `VOICE_RAG_RETRIEVE_MAX_ATTEMPTS=3`
- `rag:canary-preflight=pass`
- `rag:retrieve-preflight=pass`
- `timeout_ms=1500`
- `hit=true`
- `result_count>0`

Gate 3 live PASS still requires actual live RAG usage:

- `rag_retrieval_completed >= 1`
- `used_rag=true` / `rag_used=true`
- `rag_product_scope=smart_website`
- `rag_result_count > 0`
- `response_plan_created` shows:
  - `response_type=product_question_answer`
  - `plan_reason=combined_product_inquiry`
  - `current_product_context=smart_website`
  - `rag_enabled=true`
  - `rag_used=true`

Fallback-only answers remain user-safe but are **not** Gate 3 PASS.

## Phase 10AH update (v1.34.8 live call)

v1.34.8 Gate 3 live call: raw `rag:retrieve-preflight` passed (`result_count=1`, `timeout_ms=1500`)
but live path failed RAG (`rag_result_count=0`, `rag_latency_ms=347`, `timeout_count=0`).
Root cause: raw preflight did not exercise product filtering, answer safety, or Gate 3 transcript.
See [Phase 10AH report](./voice_assistant_v4_phase10ah_live_rag_path_equivalence_report.md).

Gate 3 now requires **`rag:live-path-preflight`** in addition to raw retrieve preflight.

## Recommendation

Release as `voice-bridge-v1.34.8`. Do not deploy a new `rag-api` image unless diagnostics prove
the API itself needs a change.
