# Voice Assistant v4 Phase 10U - RAG-On Live Canary Readiness Report

Date: 2026-06-03  
Target release: `voice-bridge-v1.30.0`  
Status: **Gate 2 PASS (v1.34.3). Gate 3 FAIL (v1.34.3, `call_session_id=c00a2c38-8ff8-43a0-aed8-85cd1d3e441f`). Phase 10AC fixes fallback + adds `rag:retrieve-preflight`. No second Gate 3 until v1.34.4+ and retrieve preflight passes.**

## Objective

Prepare the gated v4 live AudioSocket canary for product-scoped RAG product/sales Q&A without changing the production v3 default or enabling RAG globally.

Phase 10S proved that product context can switch and persist during interruption handling. Phase 10U makes that context authoritative for RAG retrieval and adds the evidence needed to validate a supervised RAG-on call safely.

## Safety Boundaries

- Production remains on `VOICE_RUNTIME_VERSION=v3`.
- `VOICE_RAG_ENABLED=false` and `VOICE_RAG_SALES_ANSWERER_ENABLED=false` remain the defaults.
- RAG retrieval requires both RAG flags and the existing v4 live canary gates.
- `turn-assistant.js` is not expanded.
- RAG cannot create leads, validate callback permission, or change contact policy.
- RAG failures fall back to short product playbook answers.
- No raw transcript, query text, phone number, email, or lead details are written to quality event payloads.
- v4 voice RAG requests never persist `query_preview` in RAG retrieval logs.

## Implementation

### Product-scoped retrieval

`voice-bridge/src/v4/rag-product-scope.js` resolves the active product from `current_product_context`, selected product, or product interest. The v4 RAG request sends:

```json
{
  "context": {
    "product": "smart_website",
    "product_scope": "smart_website",
    "v4_rag": true
  }
}
```

The scope is enforced twice:

1. `rag-api` filters retrieval candidates to the requested product scope.
2. `voice-bridge` rejects answer chunks that do not match the active product.

Generic German references such as `Was kostet das?`, `Wie funktioniert das?`, `Was kann das?`, and `Erklar mir das kurz.` therefore bind to the current product context before retrieval.

### Fail-closed behavior

The assistant continues with a bounded non-RAG product answer when retrieval:

- times out;
- is unavailable;
- returns no usable result;
- returns a low-score result;
- returns only a different product;
- produces an unsafe or forbidden answer.

The fallback does not restart intake or enter `collect_sales_context` unless the caller explicitly asks for contact, callback, or project discussion.

**Phase 10AC (v1.34.4):** On RAG miss/timeout, combined Smart Website inquiries fall back to the
Gate 2 combined playbook answer (definition + value + scope-based pricing). Scoped pricing
follow-ups (`Was kostet das?`) use pricing playbook with Umfang language. Run
`npm run rag:retrieve-preflight` before Gate 3 — health-only `rag:canary-preflight` is insufficient.

### Telemetry and response-plan evidence

RAG quality events use:

- `rag_retrieval_started`
- `rag_retrieval_completed`
- `rag_retrieval_failed`

Safe payload fields include:

- `rag_enabled`
- `rag_sales_answerer_enabled`
- `rag_product_scope`
- `rag_result_count`
- `rag_fallback_used`
- `fallback_reason`
- `rag_latency_ms` through the event metric value

`response_plan_created` includes safe RAG evidence:

- `current_product_context`
- `previous_product_context`
- `matched_product`
- `response_type`
- `plan_reason`
- `rag_enabled`
- `rag_product_scope`
- `rag_used`
- `rag_fallback_used`
- `interrupt_sequence_id` when applicable

### 24/7 readiness foundation

- `voice-bridge` has a non-blocking RAG API health check.
- Startup logs show RAG enablement and API configuration without printing secrets or the URL.
- Live call quality summaries already count `rag_used_count` and `rag_failed_count`.
- Repeated RAG failures do not crash the call or prevent later non-RAG answers.
- Existing stale-session detection and call-finalization behavior is unchanged.

## Files Changed

| Area | Files |
|------|-------|
| Product scope | `voice-bridge/src/v4/rag-product-scope.js`, `voice-bridge/src/v4/rag-orchestrator.js` |
| Dialogue evidence | `voice-bridge/src/v4/dialogue-orchestrator.js`, `voice-bridge/src/v4/response-planner.js`, `voice-bridge/src/v4/product-context-persistence.js` |
| Health/startup | `voice-bridge/src/rag-client.js`, `voice-bridge/src/index.js` |
| RAG API scope/privacy | `rag-api/app/retrieval.py` |
| Tests | `voice-bridge/tests/v4-phase10u-rag-live-canary-readiness.test.js`, existing Phase 5/6 tests, `rag-api/tests/test_contract_static.py` |

## Verification

| Check | Result |
|-------|--------|
| `cd voice-bridge && npm test` | `386/386` passed |
| `python -m pytest rag-api/tests` | `7/7` passed |
| `node --check` on changed JS | Passed |
| `git diff --check` | Clean |
| `voice-bridge/scripts/run-ci-dialogue-scenarios.ps1` | `25/25` passed |

## Supervised Canary Decision

Phase 10U is ready for a supervised RAG-on canary after release of `voice-bridge-v1.30.0`.

The canary must:

1. use `VOICE_RAG_API_URL=http://127.0.0.1:8080`;
2. enable both RAG flags only during the approved canary window;
3. prove Smart Website questions remain scoped to Smart Website;
4. prove a controlled RAG failure produces a short playbook answer;
5. prove quality payloads contain safe evidence and no raw query/transcript/PII;
6. roll back to v3 and RAG-off after evidence collection.

Passing the canary does not enable production v4 globally.

## Phase 10V Gate Correction

The first v1.30.0 attempt stopped on a v3 baseline call before RAG-on. The call exposed a real v3 fallback defect, but v3 must not be used to validate v4 barge-in or interactive behavior.

The corrected sequence is:

1. v3 baseline health and known-product pricing sanity;
2. v4/RAG-off control call for interactivity, interruption, and product context;
3. v4/RAG-on canary for product-scoped retrieval.

See [Phase 10V report](./voice_assistant_v4_phase10v_v3_fallback_and_canary_gate_report.md).

## Phase 10W Gate 3 Invalid Attempt Follow-up

The first Phase 10V Gate 3 attempt was **FAIL / INVALID** because the running
container still reported `VOICE_RAG_ENABLED=false` and
`VOICE_RAG_SALES_ANSWERER_ENABLED=false`. SQL response-plan evidence also
reported `rag_enabled=false` and `rag_used=false`.

Phase 10W adds a hard in-container preflight:

```bash
docker exec technolohit-voice-bridge npm run rag:canary-preflight
```

No future RAG-on call is valid unless this command exits `0`.
