# Phase 10AE — RAG Retrieve Preflight Jitter Guard

Date: 2026-06-09  
Target release: **`voice-bridge-v1.34.6`**

## Context

Phase 10AD / `voice-bridge-v1.34.5` proved that Smart Website knowledge is retrievable:

- `rag:retrieve-preflight` failed once at `706 ms` against a `700 ms` timeout.
- `rag:retrieve-diagnostics` then passed at the same `700 ms` budget with `5/5` hits and p50 around `226 ms`.
- No Gate 3 live call was placed.
- Production was restored to v3/RAG-off.

This points to a one-off retrieve jitter issue, not a knowledge miss.

## Fix

`rag:retrieve-preflight` now runs a small bounded retry set at the configured runtime timeout:

- Default attempts: `3`
- Required success: majority, currently `2/3`
- Timeout budget is unchanged: `VOICE_RAG_TIMEOUT_MS`
- No live runtime timeout is raised
- No production v4/RAG default changes

If one attempt times out but two attempts retrieve Smart Website knowledge, preflight passes and reports the jitter:

```text
attempt_count=3
success_count=2
required_success_count=2
timeout_count=1
attempt_fallback_reasons=rag_retrieve_timeout
```

If repeated attempts fail, preflight remains blocked:

- repeated timeout -> `fallback_reason=rag_retrieve_timeout`
- repeated miss -> `fallback_reason=rag_miss`
- wrong scope -> `fallback_reason=wrong_product_scope`
- unavailable RAG -> `fallback_reason=rag_unavailable`

## Code Changes

| File | Change |
|------|--------|
| `voice-bridge/src/v4/rag-retrieve-preflight.js` | Adds bounded retry/majority-success preflight and safe attempt counters |
| `voice-bridge/tests/v4-phase10ad-rag-retrieve-timeout-diagnostics.test.js` | Adds Phase 10AE jitter guard test |
| `docs/Tasks/voice_assistant_v4_phase10h_live_qa_runbook.md` | Documents preflight attempts and Gate 3 rule |
| `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` | Adds Phase 10AE status |

## Gate 3 Rule

Gate 3 may proceed only if:

1. `rag:canary-preflight` passes
2. `rag:retrieve-preflight` passes
3. output shows `hit=true`, `result_count>0`, and `success_count >= required_success_count`

If `rag:retrieve-preflight` fails, run `rag:retrieve-diagnostics` and do not place a live call.

## Local Verification

| Check | Result |
|-------|--------|
| `cd voice-bridge && npm test -- --test-name-pattern="10AD|10AE"` | **464/464 pass** |
| `node --check` on changed JS | pass |

Full release validation is required before tagging.

## Constraints Preserved

- Production remains v3/RAG-off by default
- RAG not enabled by default
- No production env changes
- No raw query/transcript/phone/email in preflight output
- `turn-assistant.js` untouched
