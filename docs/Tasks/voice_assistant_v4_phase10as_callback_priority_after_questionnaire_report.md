# Phase 10AS - Callback Priority After Questionnaire Canary

Date: 2026-06-10

## Status

Implemented and ready for supervised canary release as `voice-bridge-v1.35.1`.

Production defaults remain unchanged:

- `VOICE_RUNTIME_VERSION=v3`
- `VOICE_RAG_ENABLED=false`
- `VOICE_RAG_SALES_ANSWERER_ENABLED=false`
- `VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED=false`

## Trigger

The `voice-bridge-v1.35.0` supervised v4/RAG-on/questionnaire canary produced a good Smart Website answer and a correct closing response, but failed callback handling.

Observed live behavior:

- Caller asked for a phone callback.
- The assistant continued with Smart Website product explanation.
- `response_plan_created` stayed on `product_question_answer`.
- `questionnaire_block_reason=callback_uses_contact_flow` showed that the questionnaire layer noticed callback intent, but the core planner had already selected product Q&A.

## Root Cause

Callback/contact intent had lower effective priority than scoped product Q&A.

Two code paths allowed the failure:

1. `detectTranscriptIntent()` checked product/product-question patterns before callback request detection.
2. `buildResponsePlanCore()` handled scoped product Q&A before the `callback_request` branch.

With `current_product_context=smart_website`, a callback utterance could be interpreted as another product turn before the lead-capture path ran.

## Fix

The Conversation Priority Contract is now enforced for callback/contact requests:

1. Closing remains highest priority.
2. Safety / role boundary remains second.
3. Explicit callback/contact requests now run before interruption recovery, product Q&A, RAG, and questionnaire.

Changed files:

- `voice-bridge/src/v4/transcript-intent.js`
- `voice-bridge/src/v4/response-planner.js`
- `voice-bridge/tests/v4-phase10ap-role-boundary-runtime.test.js`

Added coverage:

- Callback request with known `smart_website` context returns `collect_contact_preference`.
- Callback request after interruption returns `collect_contact_preference`, not `interrupt_scoped_product_qa`.
- Existing contact preference follow-up still maps `telefonisch` to `contact_phone`.

## Verification

Local checks:

- `cd voice-bridge && npm test` -> `568/568` pass
- `python -m pytest rag-api/tests` -> `7/7` pass
- `node --check` on changed JS -> pass
- `git diff --check` -> pass (CRLF warnings only)
- `run-ci-dialogue-scenarios.ps1` -> `26/26` pass

## Live QA Required

Run one supervised v4/RAG-on/questionnaire canary on `voice-bridge-v1.35.1`.

Required scenario:

1. Ask: `Was ist eine Smart Webseite, was macht sie und was kostet sie?`
2. Then ask: `Bitte rufen Sie mich telefonisch zurueck.`
3. Then answer the contact preference / permission flow.
4. Close with: `Danke, das reicht erstmal.`

Pass criteria:

- Smart Website product answer remains good.
- Callback request produces `response_type=collect_contact_preference`.
- No `product_question_answer` after the callback request unless the caller asks a new product question.
- No RAG retrieval is triggered by the callback request.
- Lead/post-call pipeline produces the expected guarded outcome depending on caller ID and permission.
- Closing still produces only the approved goodbye response.
- Privacy scan returns zero rows.
- No new stale active session.
- Runtime is rolled back to v3/RAG-off/questionnaire-off after evidence collection.

## Recommendation

Ship `voice-bridge-v1.35.1` and run a single supervised canary. Do not enable production v4 globally.
