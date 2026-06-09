# Phase 10AH — Live RAG Path Equivalence and Miss Diagnostics

Date: 2026-06-09  
Target release: **`voice-bridge-v1.34.9`** (pending Codex review — do not tag/publish yet)

## Context

Phase 10AG / v1.34.8 Gate 3 live call was valid and human-quality passed, but **RAG-on criteria failed**.

| Check | Result |
|-------|--------|
| `rag:retrieve-preflight` | **pass** (`result_count=1`, `hit=true`, `timeout_ms=1500`) |
| Live v4 canary RAG | **fail** (`rag_used=false`, `rag_fallback_used=true`, `rag_result_count=0`, `rag_latency_ms=347`, `timeout_count=0`) |

**Conclusion:** Raw HTTP retrieve preflight was **not equivalent** to the live `retrieveV4RagAnswer()` path. Gate 3 must not rely on raw retrieve alone.

## Root cause

Raw `rag:retrieve-preflight` called `/v1/retrieve` directly and classified hits **before** live voice-bridge filtering:

1. **Query mismatch** — preflight used a shorter probe query, not the Gate 3 combined utterance.
2. **No product filter** — raw hits could be wrong-product chunks (`voice_agent`) that live filtering removes → `rag_wrong_product_scope`, `result_count=0`.
3. **No answer safety** — snippets with phone-like text pass raw preflight but fail live `validateRagAnswerSafety`.
4. **Score threshold on unfiltered top score** — live path now applies `min_score` to **scoped** chunks only.

Live failure at 347 ms with `timeout_count=0` matches **post-retrieve filtering**, not timeout.

## Fix summary

| # | Fix |
|---|-----|
| 1 | New `npm run rag:live-path-preflight` — exercises `retrieveV4RagAnswer()` with Gate 3 transcript/memory/state |
| 2 | Raw preflight kept but marked `preflight_mode=raw_retrieve`; **cannot approve Gate 3 alone** |
| 3 | Gate 3 requires all three: `rag:canary-preflight`, `rag:retrieve-preflight`, `rag:live-path-preflight` |
| 4 | Live RAG quality events include before/after filter counts and safe diagnostics (no PII) |
| 5 | `min_score` checked against scoped top score; filter-stage fields on all live RAG outcomes |
| 6 | 10H runbook: wait for post-call summary before rollback |

## Gate 3 preflight (all required)

```bash
docker exec technolohit-voice-bridge npm run rag:canary-preflight
docker exec technolohit-voice-bridge npm run rag:retrieve-preflight
docker exec technolohit-voice-bridge npm run rag:live-path-preflight
```

**Abort Gate 3 unless all three exit 0.**

### Live-path pass criteria

```text
rag_live_path_preflight=pass
used_rag=true
product_scope=smart_website
result_count>0
fallback_reason=none
top_score>=min_score
result_count_after_product_filter>0
```

### Sample live-path fail (wrong product filter)

```text
rag_live_path_preflight=fail
used_rag=false
fallback_reason=rag_wrong_product_scope
raw_result_count_before_voice_filter=1
result_count_after_product_filter=0
failures=rag_wrong_product_scope
```

## Safe live RAG diagnostics (quality events)

Added to `rag_retrieval_started`, `rag_retrieval_completed`, and `rag_retrieval_failed`:

- `normalized_query_type` (e.g. `combined_product_inquiry`)
- `query_chars` (length only)
- `product_scope`, `tenant_id`, `agent_id`
- `timeout_ms`, `max_attempts`
- `raw_result_count_before_voice_filter`
- `result_count_after_product_filter`
- `top_score_before_filter`, `top_score_after_filter`
- `min_score`, `fallback_reason`, `rag_error_reason`
- `rag_attempt_count`, `rag_timeout_count`, `rag_success_count`
- `rag_attempt_fallback_reasons`

No raw transcript, query text, snippets, phone, email, or secrets.

## Code changes

| File | Change |
|------|--------|
| `voice-bridge/src/v4/rag-live-path-preflight.js` | Live-path Gate 3 preflight (new) |
| `voice-bridge/scripts/rag-live-path-preflight.js` | CLI (new) |
| `voice-bridge/src/v4/rag-quality-diagnostics.js` | Safe RAG event diagnostics (new) |
| `voice-bridge/src/v4/rag-retrieve-probe.js` | Gate 3 transcript + live memory probe context |
| `voice-bridge/src/v4/rag-orchestrator.js` | Filter stages, scoped score threshold, diagnostics fields |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Rich RAG quality payloads |
| `voice-bridge/src/v4/rag-retrieve-preflight.js` | `preflight_mode=raw_retrieve` marker |
| `voice-bridge/tests/v4-phase10ah-live-rag-path-equivalence.test.js` | Phase 10AH tests (new) |

## Post-call / rollback (10H)

After a Gate 3 live call, **wait for post-call summary** before rollback unless H1–H13 emergency stop applies:

```sql
SELECT event_type, created_at
FROM voice.call_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type IN ('post_call_summary_created', 'post_call_summary_failed', 'post_call_summary_skipped')
ORDER BY created_at;

SELECT COUNT(*) FROM voice.call_summaries WHERE call_session_id = '<CALL_SESSION_ID>'::uuid;
```

Proceed to section I rollback only after `post_call_summary_created` or explicit timeout (recommended: up to 60s after socket close).

## Local verification (2026-06-09)

| Check | Result |
|-------|--------|
| `cd voice-bridge && npm test` | **478/478 pass** |
| `python -m pytest rag-api/tests` | **7/7 pass** |
| `node --check` on changed JS | pass |
| `git diff --check` | pass |
| `run-ci-dialogue-scenarios.ps1` | **26/26 pass** |

## Gate status

| Gate | Status |
|------|--------|
| Gate 2 (v4/RAG-off) | **PASS** |
| Gate 3 (v4/RAG-on) | **Failed on v1.34.8** — raw preflight false positive; fix in v1.34.9 |
| Production | **v3 / RAG-off** |

## Constraints preserved

- Production v4 not globally enabled
- No production env file changes from repo
- No deploy or live tests in this phase
- `turn-assistant.js` untouched
- No raw PII in logs or quality payloads
