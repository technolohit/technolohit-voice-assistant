# Voice Assistant v4 Phase 10V - v3 Fallback and Canary Gate Report

Date: 2026-06-03
Target release: `voice-bridge-v1.30.1`
Status: **Implementation complete; live validation required**

## Incident

The Phase 10U attempt stopped before RAG-on because the initial call ran on the v3 production fallback and exposed poor known-product question handling.

Failed session:

```text
708af042-f2e2-4fab-85e9-e86f9c008483
```

The caller selected Smart Website and asked `Was kostet das?`. v3 forced customer-type qualification before answering and later repeated a generic product response.

This was not a v4 or RAG failure:

- `VOICE_RUNTIME_VERSION=v3`
- RAG flags were off
- v4 flags were off
- v3 does not support barge-in by design

## Root Cause

v3 correctly detected `pricing_question`, but `maybeCreateProductResponse()` routed the active `sales_customer_type` stage into customer-type handling before direct known-product questions were answered.

The response history also did not prevent consecutive near-identical generic product answers.

## Changes

### v3 direct known-product question routing

New module:

```text
voice-bridge/src/v3/product-question-routing.js
```

When a product is already selected, direct pricing and explanation questions are answered before customer-type qualification:

- Smart Website + `Was kostet das?`
- Smart Website + `Wie funktioniert das?`
- Voice Agent + `Was kostet das?`

Pricing remains bounded and does not invent an exact price. Qualification is not entered unless the caller explicitly asks for callback, contact, consultation, project, or implementation discussion.

### Repeated-response prevention

Consecutive identical or near-identical product-question responses are replaced by a shorter direct response. This prevents a rigid repeated generic sentence without creating a fallback loop.

### Minimal live-call quality telemetry

New module:

```text
voice-bridge/src/live-call-quality.js
```

All live calls can now emit fail-safe, privacy-safe quality events:

- `live_runtime_selected`
- `live_response_created`
- `live_runtime_summary`

Safe fields include:

- selected runtime;
- selected handler;
- response type/template;
- current product context;
- close reason;
- response, turn, and inbound-frame counters.

The payload never includes raw transcript, assistant response text, phone, email, RAG query, or lead details. Insert failures never break call completion.

## Canary Gate Clarification

### Gate 1 - v3 baseline health and pricing sanity

Validates:

- v3 routing;
- greeting;
- known-product pricing sanity;
- persistence and close;
- minimal quality events;
- no new stale session;
- rollback safety.

Does not validate:

- barge-in;
- interruption handling;
- v4 response-plan events;
- RAG behavior.

### Gate 2 - v4 / RAG-off control call

Validates:

- live v4 route;
- OpenAI STT/TTS;
- dialogue;
- barge-in;
- interruption recovery;
- product-context persistence;
- v4 quality flush.

### Gate 3 - v4 / RAG-on canary

Validates Phase 10U product-scoped RAG behavior. Gate 3 is allowed only after Gate 2 passes.

## Files Changed

| Area | Files |
|------|-------|
| v3 routing | `voice-bridge/src/v3/product-question-routing.js`, `voice-bridge/src/turn-assistant.js` |
| Live telemetry | `voice-bridge/src/live-call-quality.js`, `voice-bridge/src/audiosocket.js`, `voice-bridge/src/persist.js`, `voice-bridge/src/call-finish.js` |
| Tests / QA | `voice-bridge/tests/v4-phase10v-v3-fallback-telemetry.test.js`, `voice-bridge/scripts/qa-dialogue-text.js`, `voice-bridge/scripts/run-ci-dialogue-scenarios.ps1`, `.github/workflows/ci.yml` |
| Docs | Phase 10V report, Phase 10U report, Phase 10H runbook, Phase 10O plan, main blueprint |

## Safety

- Production v4 remains disabled by default.
- RAG remains disabled by default.
- No v4 barge-in behavior was added to v3.
- No production env file was changed.
- `turn-assistant.js` contains only bounded helper wiring.
- `docs/Tasks/logs.txt` is not part of this change.
- `rag-api` is unchanged; no new RAG API image is required for Phase 10V.

## Verification

| Check | Result |
|------|--------|
| `cd voice-bridge && npm test` | `393/393` passed |
| `python -m pytest rag-api/tests` | `7/7` passed |
| `voice-bridge/scripts/run-ci-dialogue-scenarios.ps1` | `26/26` passed |
| `node --check` on changed JS | passed |
| `git diff --check` | clean |
