# Phase 10AC — RAG Retrieval Readiness and Fallback Fix

Date: 2026-06-03  
Target release: **`voice-bridge-v1.34.4`** (pending Codex review — do not tag/publish yet)

## Gate status context

| Gate | Status |
|------|--------|
| Gate 2 (v4/RAG-off) | **PASS** on v1.34.3 |
| Gate 3 (v4/RAG-on canary) | **FAIL** on v1.34.3 |
| Production | **v3 / RAG-off** (unchanged) |

## Gate 3 failure (v1.34.3)

**Session:** `call_session_id=c00a2c38-8ff8-43a0-aed8-85cd1d3e441f`

| Check | Result |
|-------|--------|
| handler | v4_canary |
| RAG env / `rag:canary-preflight` | pass |
| RAG health | pass |
| OpenAI STT/TTS | pass |
| barge-in | pass |
| post-call summary | pass |
| privacy scan | pass |
| rollback | pass |
| RAG retrieval | **fail** — 3× `rag_retrieval_failed`, `rag_result_count=0`, `rag_used=false`, `rag_fallback_used=true` |

**Human observation:** For *"Was ist Smart Website, was macht sie und was kostet sie?"* the assistant only explained what Smart Website is. Pricing was not heard. A repeated pricing question repeated the same generic explanation.

**Root cause:** `fallbackToPlaybook()` returned generic `buildSalesProductExplanation()` only. `buildResponsePlan()` preferred `ragAnswer` (generic fallback) over the proven Gate 2 combined playbook answer. `rag:canary-preflight` checked `/healthz` only — not whether Smart Website knowledge is retrievable.

## Fix summary

| # | Fix |
|---|-----|
| 1 | Transcript-aware `fallbackToPlaybook()` — combined inquiry, pricing, capability/how |
| 2 | `resolveRagAwareProductAnswer()` — when `used_rag=false`, playbook beats RAG fallback text |
| 3 | `npm run rag:retrieve-preflight` — product-scoped retrieve check for Smart Website |
| 4 | `rag_retrieval_failed` events carry safe diagnostics (no raw query/transcript) |
| 5 | Tests for miss/timeout/hit/repeat-pricing/preflight/privacy |
| 6 | Docs updated — no second Gate 3 until retrieve preflight passes |

## Code changes

| File | Change |
|------|--------|
| `voice-bridge/src/v4/rag-orchestrator.js` | Transcript-aware `fallbackToPlaybook()`; richer failure diagnostics |
| `voice-bridge/src/v4/response-planner.js` | `resolveRagAwareProductAnswer()` for RAG-off fallback priority |
| `voice-bridge/src/v4/rag-retrieve-preflight.js` | Retrieve-level Gate 3 preflight (new) |
| `voice-bridge/scripts/rag-retrieve-preflight.js` | CLI wrapper (new) |
| `voice-bridge/package.json` | `rag:retrieve-preflight` script |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Safe `rag_retrieval_failed` payload fields |
| `voice-bridge/tests/v4-phase10ac-rag-fallback-retrieve-preflight.test.js` | Phase 10AC tests (new) |

Note: the same RAG-miss fallback priority is covered for interruption follow-up turns after barge-in, so `Was kostet das?` after an interruption remains scoped to the active Smart Website context.

## Combined Smart Website fallback (RAG miss)

When RAG is enabled but retrieval fails/misses, callers hear the Gate 2 combined answer:

```text
Smart Website ist eine moderne Firmenwebsite mit Leistungsseiten und lokaler Sichtbarkeit. Sie bereitet Anfragen besser vor. Der Preis hängt vom Umfang ab.
```

Length: **155 characters** (within default live TTS limit 160).

## Gate 3 preflight (required before next canary)

Run **both** checks immediately before a supervised Gate 3 call:

```bash
docker exec technolohit-voice-bridge npm run rag:canary-preflight
docker exec technolohit-voice-bridge npm run rag:retrieve-preflight
```

**Do not place a second Gate 3 canary** until `rag:retrieve-preflight` reports `rag_retrieve_preflight=pass` with `hit=true` and `result_count>0`.

### Sample pass output

```text
rag_retrieve_preflight=pass
product_scope=smart_website
result_count=2
hit=true
top_score=0.88
fallback_reason=none
payload_tenant_id=technolohit
payload_agent_id=main_voice_sales
rag_retrieve_ok=true
rag_http_status=200
rag_latency_ms=42
min_score=0.72
failure_count=0
failures=none
```

### Sample fail output (rag_miss — blocks Gate 3)

```text
rag_retrieve_preflight=fail
product_scope=smart_website
result_count=0
hit=false
top_score=none
fallback_reason=rag_miss
payload_tenant_id=technolohit
payload_agent_id=main_voice_sales
rag_retrieve_ok=true
rag_http_status=200
rag_latency_ms=30
min_score=0.72
failure_count=1
failures=rag_miss
```

## SQL evidence (Gate 3 combined inquiry after fix)

```sql
SELECT created_at,
       payload->>'response_type' AS response_type,
       payload->>'plan_reason' AS plan_reason,
       payload->>'rag_used' AS rag_used,
       payload->>'rag_fallback_used' AS rag_fallback_used,
       payload->>'fallback_reason' AS fallback_reason,
       payload->>'rag_product_scope' AS rag_product_scope,
       payload->>'rag_result_count' AS rag_result_count
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type IN ('response_plan_created', 'rag_retrieval_failed', 'rag_retrieval_completed')
ORDER BY created_at;
```

**Pass on RAG miss (v1.34.4+):**

- `response_type=product_question_answer`
- `plan_reason=combined_product_inquiry` (or `product_pricing_fallback` on follow-up pricing)
- `rag_fallback_used=true`, `rag_used=false`
- `fallback_reason=rag_miss` (or `timeout`) on `rag_retrieval_failed`
- Caller hears definition + value + scope-based pricing
- No `collect_sales_context` for the combined-inquiry turn

## Local verification (2026-06-03)

| Check | Result |
|-------|--------|
| `cd voice-bridge && npm test` | **454/454 pass** |
| `python -m pytest rag-api/tests` (repo root) | **7/7 pass** |
| `node --check` on changed JS | pass |
| `git diff --check` | pass |
| `run-ci-dialogue-scenarios.ps1` | **26/26 pass** |

## Constraints preserved

- Production remains **v3 / RAG-off**
- RAG not enabled by default
- No production env file changes from repo
- No rag-api image change (voice-bridge only)
- Privacy rules unchanged
- RAG does not create leads or callback permission
