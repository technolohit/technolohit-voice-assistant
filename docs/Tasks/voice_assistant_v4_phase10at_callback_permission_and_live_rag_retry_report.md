# Phase 10AT — Callback Permission Continuation + Live RAG Transient Retry Report

Date: 2026-06-10
Release target: `v1.35.2` (`thnhit/technhvoice:voice-bridge-v1.35.2`)
Production status: **v3 / RAG-off unchanged**. v4, RAG, and questionnaire runtime remain **opt-in/default-off**.

> Focused fix after the failed `voice-bridge-v1.35.1` supervised canary
> (call session `5877d6be-348a-4a21-a860-05629cbe3890`). No assistant redesign.

## Canary failure evidence (v1.35.1)

Transcript: product question → pricing → "Bitte rufen Sie mich telefonisch zurück." →
"Ich habe doch gesagt, telefonisch." → "Ja."

| Turn | Expected | Observed (v1.35.1) |
|---|---|---|
| callback request | `collect_contact_preference` | `collect_contact_preference` / `callback_request_intent` (OK, fixed in 10AS) |
| "telefonisch" | `collect_callback_permission` | `collect_callback_permission` (OK) |
| "Ja." | callback permission granted | **`product_question_answer` / `scoped_product_qa`** (FAIL) |
| live RAG | up to 3 attempts | **`rag_attempt_count=1`**, `rag_timeout_count=0`, `rag_used=false`, `rag_fallback_used=true`, `rag_latency_ms=1428`, `errors.rag_unavailable=1` (FAIL) |

## Root cause A — callback permission continuation

For a bare "Ja." with a remembered product context:

1. `resolveClosedDomainIntent()` defaults to `intent="product_question"` (confidence 0.5) and
   keeps `matched_product` from memory, so the turn is not low-confidence.
2. `isScopedProductQaTurn()` returns true via `closedDomain.intent === "product_question"`.
3. In `buildResponsePlanCore()` the scoped-product-QA branch runs **before** the
   `callback_permission_granted` branch and **ignores the resolved transcript intent**,
   so the correctly detected permission grant was hijacked into `scoped_product_qa`.

Additionally `"okay"` did not match the affirmative pattern (`\bok\b` does not match
"okay"), and there was no refusal intent at all.

### Fix A

`voice-bridge/src/v4/transcript-intent.js`

- New `isCallbackPermissionPending(memory)`: pending while
  `current_state=collecting_callback_permission`, or `contact_preference=phone` and no
  `callback_permission` decision yet (robust against live state churn where
  `current_state` cycles speaking → listening → thinking between turns).
- While permission is pending (and the caller did not ask a new product question and is
  not doing topic repair):
  - "Ja", "ja gerne", "okay", "ok", "einverstanden", "in Ordnung", "klar" →
    `callback_permission_granted`.
  - "nein", "lieber nicht", "bitte nicht", "kein Anruf", "nicht anrufen" →
    `callback_permission_denied` (new intent).
- `contact_flow_pending` memory flag now also counts as "collecting contact preference"
  so a follow-up answer is not re-classified as a fresh `callback_request`.
- Closing still wins: the closing check runs first, so "Nein danke, das war alles."
  remains `closing`.

`voice-bridge/src/v4/response-planner.js`

- New guard: contact-flow continuation intents (`contact_phone`, `contact_email`,
  `callback_permission_granted`, `callback_permission_denied`) skip the scoped-product-QA
  branch entirely.
- `callback_request` plan marks `contact_flow_pending: true`; `contact_phone` keeps it
  pending and preserves `contact_preference: "phone"`; grant/denial/email clear it.
- `callback_permission_granted` plan (`plan_reason=callback_permission_granted`) confirms
  and proceeds to `validating_contact` with `lead_transition_allowed: true` — the
  existing `validateLeadReadyTransition` validator still decides whether a callback-ready
  lead is possible (no bypass).
- New `callback_permission_denied` plan (`response_type=callback_permission_denied`,
  `quality_event_type=lead_skipped`): polite alternative contact path (e-mail), patches
  `callback_permission: "denied"`, `lead_ready: false`, no lead transition, no RAG, no
  product Q&A.

`voice-bridge/src/v4/rag-orchestrator.js`

- `shouldUseRagForTurn()` explicitly blocks `callback_permission_granted` and
  `callback_permission_denied` (in addition to `callback_request` from 10AP).

`voice-bridge/src/v4/questionnaire-runtime.js`

- Contact-flow intents (`contact_phone`, `contact_email`, `callback_permission_granted`,
  `callback_permission_denied`) added to the questionnaire block list
  (`callback_uses_contact_flow`) so no follow-up question can attach to these turns.

`voice-bridge/src/post-call-summary.js`

- `callerNeedFromV4Metadata()` / `firstCallerNeed()` now skip acknowledgement-only caller
  text ("Ja.", "okay", "einverstanden", "nein", …) so a bare permission answer is never
  stored as the caller need; permission/contact state is already carried by the
  `permission` / `contact_preference` summary fields.

## Root cause B — live RAG single attempt

`retrieveWithLiveTimeoutRetry()` (Phase 10AG) retried **only** `reason === "timeout"`.
The canary attempt failed after 1428 ms (< 1500 ms budget) with a transient
transport-level failure (`request_failed`/HTTP 5xx class), so the loop exited after one
attempt despite `VOICE_RAG_RETRIEVE_MAX_ATTEMPTS=3`.

### Fix B

`voice-bridge/src/v4/rag-orchestrator.js`

- New exported `isTransientRetrievalFailure(result)`:
  - transient (retry): `timeout`, `request_failed`, `rag_unavailable`, `http_429`, `http_5xx`
  - deterministic (no retry): `http_4xx` (except 429), successful miss (`ok` + no hit),
    and all post-transport gates (`rag_wrong_product_scope`, `rag_low_score`,
    `rag_unsafe_or_empty` happen after the loop and are unchanged — they never retried
    and still do not).
- `retrieveWithLiveTransientRetry()` (replaces the timeout-only loop):
  - retries transient failures up to `runtimeRetrieveMaxAttempts(config)`
    (`VOICE_RAG_RETRIEVE_MAX_ATTEMPTS`, clamped 1..5),
  - each attempt uses `runtimeRetrieveTimeoutMs(config)` (`VOICE_RAG_RETRIEVE_TIMEOUT_MS`),
  - stops immediately on a transport-level success (usable hit or deterministic miss),
  - a thrown retriever error is recorded as a failed attempt
    (`reason=rag_request_failed`) and retried like other transient failures.
- Preflight/live equivalence: `rag-live-path-preflight.js` already calls
  `retrieveV4RagAnswer()` directly, so preflight and live calls share the same retrieval
  function, payload builder, timeout, attempts, product filtering, and safety gates —
  now including the transient retry policy.

### Quality evidence (unchanged fields, now correct counts)

`rag_retrieval_started` / `rag_retrieval_completed` / `rag_retrieval_failed` payloads
already carry: `rag_attempt_count`, `rag_timeout_count`, `rag_success_count`,
`rag_attempt_fallback_reasons`, `rag_latency_ms` / `rag_total_latency_ms`,
`rag_result_count`, `rag_product_scope`, `used_rag` / `rag_fallback_used`,
`rag_http_status`, `rag_error_reason`, `timeout_ms`, `max_attempts`. No raw transcript,
query, phone, e-mail, or secret is included (verified by test).

## Files changed

| File | Change |
|---|---|
| `voice-bridge/src/v4/transcript-intent.js` | Permission pending detection, grant ("okay" etc.) + refusal intents, contact-flow pending awareness |
| `voice-bridge/src/v4/response-planner.js` | Contact-flow guard before scoped QA, `contact_flow_pending` patches, granted/denied plans |
| `voice-bridge/src/v4/rag-orchestrator.js` | Transient retry policy honoring max attempts; RAG blocked for permission intents |
| `voice-bridge/src/v4/questionnaire-runtime.js` | Contact-flow intents block questionnaire attach |
| `voice-bridge/src/post-call-summary.js` | Acknowledgement-only text never stored as caller need |
| `voice-bridge/tests/v4-phase10at-callback-permission-and-rag-retry.test.js` | **New** — 19 tests (callback flow + RAG retry + privacy) |
| `docs/Tasks/voice_assistant_v4_phase10at_callback_permission_and_live_rag_retry_report.md` | **New** — this report |
| `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` | Phase 10AT status |
| `docs/Tasks/voice_assistant_v4_phase10h_live_qa_runbook.md` | Retry-policy note updated (transient retry, not timeout-only) |

Not changed: production env files, `turn-assistant.js`, `docs/Tasks/logs.txt`,
`rag-api/` (image unchanged), Docker/deploy files.

## Tests added (Phase 10AT)

Callback flow:
1. callback request → "telefonisch" → "Ja." grants permission (not `product_question_answer` / `scoped_product_qa`), no RAG call, no questionnaire.
2. "ja gerne", "okay", "einverstanden" also grant.
3. Refusal ("Nein, bitte nicht.") → `callback_permission_denied`, no callback-ready lead, polite e-mail alternative.
4. Callback request with `current_product_context=smart_website` runs no RAG and attaches no questionnaire.
5. Closing still wins over callback/contact continuation.
6. "telefonisch" maps to `contact_phone` in the contact-preference flow; explicit callback wording outside the flow stays `callback_request`.
7. New product question during pending permission still reaches product QA.
8. RAG gate blocks permission intents explicitly.
9. Post-call summary never stores "Ja." as caller need.

RAG live retry:
1. Transient `request_failed` then success → 2 attempts, `rag_used=true`.
2. Transient `http_503` then success → retry, stop on success.
3. All attempts transient-fail → exactly `VOICE_RAG_RETRIEVE_MAX_ATTEMPTS` attempts, then fallback.
4. `VOICE_RAG_RETRIEVE_MAX_ATTEMPTS=2` honored.
5. Deterministic `http_404` not retried.
6. Orchestrator emits `rag_retrieval_completed` / `rag_used=true` after retry success and `rag_retrieval_failed` / `rag_fallback_used=true` only after all attempts fail.
7. Preflight shares the live retrieval path (same retry behavior/meta).
8. No PII/raw transcript in RAG quality diagnostics.
9. v3 defaults unchanged.

(Existing Phase 10AF timeout-retry tests still pass unchanged.)

## Verification results

| Check | Result |
|---|---|
| `cd voice-bridge && npm test` | **PASS** — 587/587 |
| `python -m pytest rag-api/tests` | **PASS** — 7/7 |
| `node --check` changed JS | **PASS** |
| `git diff --check` | **PASS** |
| `run-ci-dialogue-scenarios.ps1` | **PASS** — 26/26 |

## Confirmations

- Production v4/RAG/questionnaire defaults remain off (`VOICE_RUNTIME_VERSION=v3`,
  `VOICE_RAG_ENABLED=false`, `VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED=false`).
- Closing priority unchanged (above callback/contact); callback/contact priority above
  product Q&A, RAG, interruption recovery, and questionnaire.
- Lead validator not bypassed; permission grant only requests a transition that the
  validator still gates.
- `rag-api` code unchanged — no rag-api image publish.
- `docs/Tasks/logs.txt` untouched.

## Recommendation for next phase

Codex review, then one supervised `voice-bridge-v1.35.2` v4/RAG-on/questionnaire canary
repeating the v1.35.1 script (product question → pricing → callback → "telefonisch" →
"Ja.") and verifying `callback_permission_granted` plus `rag_attempt_count`/retry
evidence; restore v3/RAG-off afterwards.
