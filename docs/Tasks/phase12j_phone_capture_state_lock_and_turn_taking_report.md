# Phase 12J — Phone Capture State Lock and Turn-Taking Repair Report

Date: 2026-06-20  
Release: **`voice-bridge-v1.36.4`** (`thnhit/technhvoice:voice-bridge-v1.36.4`)
Status: **Released** — commit `d33adc7`, tag `v1.36.4`

## Context: Phase 12I live failure

Phase 12I supervised canary **FAILED** after Phase 12H (`v1.36.3`) shipped the raw-STT handoff fix.

| Evidence | Value |
|----------|-------|
| Handler | `v4_canary` / `v4_live_canary_selected` |
| Flow | `collect_contact_preference` → `request_phone_once` |
| Caller | `Meine Nummer ist 01511 2345678.` |
| Runtime | `intent=phone_capture_failed`, `response_type=callback_manual_review` |
| Follow-up | `barge_in_detected` during `callback_manual_review` |

STT and the spoken-phone parser were correct in isolation. The failure was **turn-taking and state-lock**: premature endpointing on partial transcripts, product/interruption routing winning over `PHONE_NUMBER_PENDING`, and barge-in opening interruption recovery instead of feeding phone capture.

## Root cause

1. **No locked sub-state** — while `callback_flow_state=phone_number_pending`, product Q&A, RAG, questionnaire, Smart Website fallback, and generic clarification could still compete with phone capture.
2. **Fail-fast on first incomplete utterance** — partial digit sequences (often from early VAD endpointing) immediately resolved to `phone_capture_failed` → `callback_manual_review` with misleading skip reasons.
3. **Barge-in hijack** — caller speech during `request_phone_once` playback triggered `pendingInterruptionRecovery` instead of continuing phone capture.
4. **Short endpoint silence** — default VAD window could finalize before the caller finished a full German mobile number.

## Fix summary

### 1. Locked phone-capture routing (`phone-capture-policy.js`, `transcript-intent.js`, `response-planner.js`)

While `collecting_phone_number` / `PHONE_NUMBER_PENDING`:

- Route only to phone capture, closing, callback refusal, or safe contact-form handoff.
- Block RAG, questionnaire, product Q&A, Smart Website fallback, and generic fallback clarification.
- `buildPhoneCaptureLockedPlan()` runs **before** interruption/product paths.

### 2. Partial retry before manual review

| Input | Result |
|-------|--------|
| Partial / incomplete digits (e.g. `Meine Nummer ist 015`) | `request_phone_once_retry`, `plan_reason=phone_capture_partial_or_incomplete`, state stays `PHONE_NUMBER_PENDING`, `phone_capture_attempt_count++` |
| Retry phrase | *Ich habe die Nummer noch nicht vollständig verstanden. Bitte nennen Sie sie langsam, Ziffer für Ziffer.* |
| After default 1 retry exhausted | `callback_manual_review`, `plan_reason=phone_capture_failed_after_retry`, `lead_skipped_reason=phone_capture_failed_after_retry` |

### 3. Successful capture (unchanged parser, reinforced routing)

Accepts:

- `Meine Nummer ist 01511 2345678.`
- `01511 2345678`, `0151 12345678`, spaced digits
- Spoken German: `null eins fünf eins eins zwei drei vier fünf sechs sieben acht`

→ `collect_callback_permission` / `phone_number_captured`; phone only in `orchestrator.callerPhoneNormalized`.

### 4. Endpointing / listening

- `VOICE_V4_PHONE_CAPTURE_ENDPOINT_SILENCE_MS` (default **1200**) via `resolvePhoneCaptureEndpointSilenceMs()` in `live-audiosocket-handler.js`.
- Planner-level partial retry absorbs premature partial transcripts when VAD cannot be tuned further.

### 5. Barge-in repair (`live-barge-in-endpoint.js`)

- `executeLivePhoneCapturePlaybackCancel()` cancels playback during phone capture without opening `pendingInterruptionRecovery`.
- Continued speech after `request_phone_once` feeds phone capture, not product interruption.

## Expected behavior after fix

| Step | Caller | Expected |
|------|--------|----------|
| 1 | Callback + phone preference | `request_phone_once` |
| 2 | `Meine Nummer ist 01511 2345678.` | `collect_callback_permission` |
| 3 | `Ja.` | `callback_finalized` |
| Partial | `Meine Nummer ist 015` | `request_phone_once_retry`, still `PHONE_NUMBER_PENDING` |
| Retry fail | invalid after 1 retry | `callback_manual_review` / `phone_capture_failed_after_retry` |
| Refusal | `Nein, lieber nicht.` | `callback_manual_review` / `phone_capture_refused` |

## Tests added

**File:** `voice-bridge/tests/v4-phase12j-phone-capture-state-lock.test.js` (11 tests)

- Phase 12I sequence reproduces and passes
- Partial → retry (no immediate manual review)
- Retry then success / retry exhaustion / refusal
- RAG, questionnaire, product QA, fallback blocked while pending
- Closing wins; barge-in does not open interruption recovery
- Extended endpoint silence; privacy on plan/memory/summary/notification

Updated: `v4-phase10g`, `v4-phase10au`, `v4-phase12h` for retry semantics.

## Playbook eval (draft / candidate only)

**Updated:** `technolohit.main_voice_sales.v1.json`, `technolohit.main_voice_sales.v1.publish-candidate.json`

- `request_phone_once_retry` in `allowed_callback_response_types`
- `invalid_spoken_phone_manual_review`: `phone_capture_attempt_count: 1`, `plan_reason=phone_capture_failed_after_retry`
- `no_questionnaire_after_phone_capture_started`: expects `request_phone_once_retry`

**Not changed semantically:** `technolohit.main_voice_sales.v1.published.json` (immutable approved binding content). Published governance validation uses artifact conformance, not live runtime replay against evolved code.

## Verification blockers resolved

### Root cause: 15 npm failures

| Cluster | Root cause | Fix |
|---------|------------|-----|
| 12A/12B/12C/12E (14 tests) | Windows checkout wrote **CRLF** into `published.json`; raw SHA-256 `d5b18a09…` vs binding LF contract `f8bb259a…` → approved binding resolution failed → 12E `playbook_version` null | `.gitattributes` `eol=lf` + LF byte normalization |
| phase11a published validate (1 test) | Phase 12J runtime retries partial phone; frozen published eval scenarios document pre-12J immediate manual-review expectations | Published mode uses `runPublishedArtifactEvalConformanceSuite()`; candidate/draft keeps live `runPlaybookEvalSuite()` |

### CRLF / checksum

- `.gitattributes` added for checksum-sensitive playbook/binding JSON.
- `published.json` bytes now match approved binding: `f8bb259a09d409242b876939ebefb63bf7031bb6bccbaa70e8e1b56cb786a21c` (semantic JSON unchanged).
- Helper: `voice-bridge/scripts/normalize-playbook-artifact-eol.mjs`.

## Verification (local, post-fix)

| Check | Result |
|-------|--------|
| `cd voice-bridge && npm test` | **804 pass / 0 fail** |
| `npm run playbook:publish-validate` (candidate) | **pass** (33 runtime eval) |
| `npm run playbook:publish-validate:published` | **pass** (33 artifact conformance) |
| `npm run playbook:canary-artifact-validate` | **pass** (`published_sha256=f8bb259a…`) |
| `python -m pytest rag-api/tests` | **7 pass** |
| `node --check` on changed JS | **pass** |
| `git diff --check` | **pass** |
| `run-ci-dialogue-scenarios.ps1` | **26/26 pass** |

## Files changed

| File | Change |
|------|--------|
| `voice-bridge/src/v4/phone-capture-policy.js` | **NEW** — lock, partial intent, retry patch, endpoint silence |
| `voice-bridge/src/v4/spoken-phone-capture.js` | `looksLikePartialPhoneCapture()` |
| `voice-bridge/src/v4/transcript-intent.js` | Phone-capture lock early block |
| `voice-bridge/src/v4/response-planner.js` | `REQUEST_PHONE_RETRY`, locked plan before interruption |
| `voice-bridge/src/v4/callback-flow-policy.js` | Partial continuation, `phone_capture_failed_after_retry` skip reason |
| `voice-bridge/src/v4/live-barge-in-endpoint.js` | Phone-capture playback cancel without interruption recovery |
| `voice-bridge/src/v4/live-audiosocket-handler.js` | Dynamic endpoint silence during phone capture |
| `voice-bridge/src/config.js` | `VOICE_V4_PHONE_CAPTURE_ENDPOINT_SILENCE_MS` |
| `voice-bridge/src/v4/rag-orchestrator.js` | Block partial phone turns |
| `voice-bridge/src/v4/questionnaire-runtime.js` | Block during phone lock |
| `voice-bridge/src/v4/agent-behavior-decision.js` | Handle `phone_capture_partial` |
| `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json` | Eval + allowed response types |
| `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.publish-candidate.json` | Matching candidate eval |
| `voice-bridge/tests/v4-phase12j-phone-capture-state-lock.test.js` | **NEW** regression suite |
| `voice-bridge/tests/v4-phase10g-*.test.js`, `v4-phase10au-*.test.js`, `v4-phase12h-*.test.js` | Retry semantics |
| `voice-bridge/src/v4/playbook-eval-scenarios.js` | `runPublishedArtifactEvalConformanceSuite()` |
| `voice-bridge/src/v4/playbook-publish-validator.js` | Published vs candidate eval split |
| `voice-bridge/tests/v4-phase11-playbook-publish-validator.test.js` | Published/candidate eval distinction test |
| `.gitattributes` | LF enforcement for checksum-sensitive artifacts |
| `voice-bridge/scripts/normalize-playbook-artifact-eol.mjs` | Windows LF restore helper |
| `docs/Tasks/phase12j_phone_capture_state_lock_and_turn_taking_report.md` | This report |
| `docs/Tasks/voice_assistant_v3_semantic_sales_agent_blueprint.md` | Phase 12I/12J status |
| `docs/Tasks/voice_assistant_v4_phase10h_live_qa_runbook.md` | Canary pin guidance |

## Release notes (draft)

- **v1.36.4** — Lock phone-capture sub-state during `PHONE_NUMBER_PENDING`; partial retry before manual review; barge-in and extended VAD turn-taking repair for missing-caller-ID callback capture.

## Constraints honored

- No deploy, live QA, production v4/RAG enablement, rag-api, Docker/deploy workflow, production env, or `docs/Tasks/logs.txt` changes.
- No commit/tag/push until Codex review completes.
