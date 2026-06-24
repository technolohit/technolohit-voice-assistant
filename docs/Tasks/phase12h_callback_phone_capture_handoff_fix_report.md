# Phase 12H — Callback Phone Capture Handoff Fix Report

Date: 2026-06-20  
Release target (after Codex review): **`voice-bridge-v1.36.3`**  
Status: **Released** — `voice-bridge-v1.36.3` (`thnhit/technhvoice:voice-bridge-v1.36.3`)

## Context: Phase 12G live failure

Phase 12G supervised canary **FAILED** on missing-caller-ID callback phone capture.

| Evidence | Value |
|----------|-------|
| STT transcript | `Meine Nummer ist 01511 2345678.` |
| Runtime plan | `response_type=callback_manual_review`, `plan_reason=phone_capture_failed` |
| Post-call | `lead_skipped`, `reason=callback_permission_missing`, `next_action=manual_followup` |

STT was correct. The bug was in the live dialogue handoff: phone redaction ran **before** intent detection and spoken-phone parsing.

## Root cause

`runLiveDialogueOnCallerTranscript()` in `live-dialogue-endpoint.js` applied `redactPhoneLikeText()` to the STT transcript before `acceptUserTranscript()` / `decideNextAction()`.

After redaction the transcript became `Meine Nummer ist [phone_redacted].`, so:

1. `evaluateSpokenPhoneCapture()` returned `no_phone_detected`
2. `transcript-intent.js` resolved `phone_capture_failed`
3. `response-planner.js` emitted `callback_manual_review` / `phone_capture_failed`
4. Post-call `validateCallbackReadyLead()` reported misleading `callback_permission_missing` because permission was never reached

The deterministic parser already accepted the raw live transcript:

```text
parseSpokenPhoneCandidate("Meine Nummer ist 01511 2345678.") → 015112345678
evaluateSpokenPhoneCapture(...) → ok: true
```

Privacy redaction for persistence (`phone-capture-privacy.js`, `call-session-memory.js`, `dialogue-orchestrator.js`) was correct; only the **live planning input** was over-redacted.

## Fix summary

### 1. Live dialogue — raw STT for planning

**File:** `voice-bridge/src/v4/live-dialogue-endpoint.js`

- Pass **raw** STT transcript into the orchestrator for intent detection and phone capture.
- Log a **redacted preview** only (`safeTranscriptPreview`), never the full number.
- Memory, `currentTurn` snapshots, quality events, and post-call paths continue to redact via existing Phase 10G guards.

### 2. Post-call skip reason clarity

**Files:** `callback-flow-policy.js`, `lead-candidate.js`, `response-planner.js`

- Added `resolvePostCallLeadSkipReason()` so `callback_manual_review` outcomes report `phone_capture_failed` (or explicit `lead_skipped_reason`) instead of generic `callback_permission_missing`.
- `response-planner.js` now sets `lead_skipped_reason` on manual-review memory patches.

### 3. German mobile formats (verified, no parser change required)

These variants already normalize to `015112345678` and pass `validatePhoneForCallback()`:

- `01511 2345678`
- `0151 12345678`
- `0 1 5 1 1 2 3 4 5 6 7 8`
- `null eins fuenf eins eins zwei drei vier fuenf sechs sieben acht`

Full normalized phone remains only in `orchestrator.callerPhoneNormalized` (stripped from public plan / `lastPlan`).

## Expected behavior after fix

| Step | Caller | Expected |
|------|--------|----------|
| 1 | Callback request | Contact preference flow |
| 2 | `Telefonisch bitte.` | `request_phone_once` / `phone_number_pending` |
| 3 | `Meine Nummer ist 01511 2345678.` | `collect_callback_permission` / phone captured |
| 4 | `Ja.` | `callback_finalized`, post-call `callback_ready` |

Failure path (invalid phone): `callback_manual_review` with `phone_capture_failed`, **not** `callback_permission_missing`.

## Tests added

**File:** `voice-bridge/tests/v4-phase12h-callback-phone-capture-handoff.test.js` (8 tests)

- Exact live numeric transcript capture
- German mobile format variants
- Full sequence through `callback_finalized`
- Live dialogue endpoint raw-STT path
- Privacy: plan, memory, quality, summary, notification
- Failure path skip reason

## Verification (local)

| Check | Result |
|-------|--------|
| `cd voice-bridge && npm test` | pass |
| `npm run playbook:publish-validate:published` | pass |
| `npm run playbook:canary-artifact-validate` | pass |
| `python -m pytest rag-api/tests` | pass |
| `node --check` on changed JS | pass |
| `git diff --check` | pass |
| `run-ci-dialogue-scenarios.ps1` | 26/26 |

## Files changed

| File | Change |
|------|--------|
| `voice-bridge/src/v4/live-dialogue-endpoint.js` | Raw STT for planning; redacted log preview |
| `voice-bridge/src/v4/callback-flow-policy.js` | `resolvePostCallLeadSkipReason()` |
| `voice-bridge/src/v4/lead-candidate.js` | Use resolved skip reason |
| `voice-bridge/src/v4/response-planner.js` | `lead_skipped_reason` on manual review |
| `voice-bridge/tests/v4-phase12h-callback-phone-capture-handoff.test.js` | New regression suite |
| `docs/Tasks/phase12h_callback_phone_capture_handoff_fix_report.md` | This report |
| `docs/Tasks/voice_assistant_v3_semantic_sales_agent_blueprint.md` | Phase 12G/12H status |
| `docs/Tasks/voice_assistant_v4_phase10h_live_qa_runbook.md` | Canary pin guidance |

## Release notes (draft)

- **v1.36.3** — Fix missing-caller-ID numeric German mobile phone capture on live STT path; clarify post-call manual-review skip reasons.

## Constraints honored

- No deploy, live QA, production v4/RAG enablement, rag-api, Docker/deploy workflow, production env, or `docs/Tasks/logs.txt` changes.
- No commit/tag/push until Codex review completes.
