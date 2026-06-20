# Phase 10G — Caller-ID Missing `ask_phone_once` Flow

**Date:** 2026-06-20  
**Scope:** v4 callback flow only (no production env, no rag-api, no deploy)

## Summary

Implemented the founder-approved **ask_phone_once** path when caller ID is missing or invalid. Valid caller ID still goes directly to the permission question. Spoken phone capture is isolated in `spoken-phone-capture.js`; protected normalized phone lives on the orchestrator runtime only (`orchestrator.callerPhoneNormalized`), not in memory patches, quality events, or eval snapshots.

## State machine changes

| Stage | `callback_flow_state` | `current_state` | Response type |
|-------|----------------------|-----------------|---------------|
| Contact preference → phone, CLI valid | `callback_permission_pending` | `collecting_callback_permission` | `collect_callback_permission` |
| Contact preference → phone, CLI missing | `phone_number_pending` | `collecting_phone_number` | `request_phone_once` |
| Valid spoken/digit phone captured | `callback_permission_pending` | `collecting_callback_permission` | `collect_callback_permission` |
| Invalid/refusal/unrelated after ask | `callback_manual_review` | `listening` | `callback_manual_review` |
| Permission + valid phone | `callback_finalized` | `validating_contact` | `callback_finalized` |
| Permission, no valid phone | `callback_manual_review` | `listening` | `callback_manual_review` |

New intents: `phone_number_candidate`, `phone_capture_refused`, `phone_capture_failed`.

Memory fields (safe): `phone_capture_attempted`, `phone_present` (boolean only). No raw phone in memory.

## Protected phone storage

- **Write path:** planner may emit transient `captured_phone_normalized`; `consumeCapturedPhoneFromPlan()` in `decideNextAction()` copies it to `orchestrator.callerPhoneNormalized` and deletes it from the public plan before `lastPlan` is stored.
- **Protected full phone exists only in:** `orchestrator.callerPhoneNormalized` (verified: `action.plan` / `lastPlan` have no `captured_phone_normalized`; `JSON.stringify(plan)` contains no phone).
- **Validation:** `validatePhoneForCallback()` (single source of truth); `hasValidCallerPhone()` accepts CLI or `memory.phone_present` after successful capture.

## Parser / validator behavior

`spoken-phone-capture.js`:

- Digit strings with grouping/spaces (`0171 512345678`, `+49 …`).
- Deterministic German digit words (`null`, `eins` … `neun`, optional `plus`).
- Returns `{ ok, normalized_phone, masked_phone, reason }`; on success `normalized_phone` is passed to orchestrator only.
- Refusal detection: `isPhoneCaptureRefusal()` for explicit declines.

Playbook phrases via `caller-id-callback-policy.js` when `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=true`; hardcoded safe defaults otherwise (still ask at most once).

## Privacy proof

- Codex privacy blocker resolved: spoken digit phone transcripts are not persisted in `memory.last_user_utterance`.
- `phone-capture-privacy.js` redacts to `[phone_redacted]` only when `callback_flow_state=phone_number_pending` and `parseSpokenPhoneCandidate()` detects a candidate.
- Planner still receives the raw transcript for deterministic parsing; after planning, `currentTurn.transcript` is replaced with `[phone_redacted]`.
- `v4-phase10g-caller-id-missing-phone-capture.test.js`: numeric and spoken digit captures assert `memory.last_user_utterance === "[phone_redacted]"`, `action.plan.captured_phone_normalized === undefined`, `orchestrator.lastPlan.captured_phone_normalized === undefined`, and `orchestrator.callerPhoneNormalized` holds the protected value.
- `serializeMemoryForPersistence()`, post-call summary metadata, notification payloads, quality events, and behavior decision event payloads are asserted free of raw digit strings and the known spoken sequence.
- Outside `phone_number_pending`, normal phrases like "eins zwei Schritte bitte" remain unchanged.
- `privacy-sanitize.js` continues to mask `caller_phone*` keys in outbound objects.
- Planner never puts captured phone into `memory_patch` or quality payloads.
- Public `plan` / `lastPlan` never retain `captured_phone_normalized` after `decideNextAction()`.

## Flow test results

| Test area | Result |
|-----------|--------|
| `npm test` (voice-bridge) | **712 pass / 0 fail** |
| `v4-phase10g-caller-id-missing-phone-capture.test.js` | 13 pass |
| `v4-phase10au-golden-callback-contract.test.js` (updated no-CLI paths) | pass |
| `v4-phase10at-callback-permission-and-rag-retry.test.js` (CLI on refusal test) | pass |
| `python -m pytest rag-api/tests` | 7 passed |
| `run-ci-dialogue-scenarios.ps1` | 26/26 pass |
| `node --check` (changed JS) | OK |
| `git diff --check` | OK |

## Eval summaries

| Suite | pass | fail | pending |
|-------|------|------|---------|
| Playbook eval | **33** | 0 | 0 |
| Decision eval | **13** | 0 | 0 |

New playbook eval scenarios: `caller_id_available_permission`, `caller_id_missing_request_phone_once`, `valid_spoken_phone_then_permission`, `valid_digit_phone_then_permission`, `invalid_spoken_phone_manual_review`, `no_repeat_phone_request`, `no_rag_after_phone_capture_started`, `no_questionnaire_after_phone_capture_started`.

## Phase 10 closure

**Umbrella Phase 10: CLOSED** (2026-06-20)

- Criterion 15 (`request_phone_once`) — **complete**
- Codex privacy blocker — **resolved by test** (numeric + spoken digit transcript redaction)
- Criterion 16 — **resolved** for missing-phone path (playbook `caller_id_missing_phrase` + contact-form failure phrase). Success-path finalized wording still differs slightly from MD (“Ich habe die Anfrage aufgenommen…” vs “Ich nehme die Rückrufanfrage auf…”) — **non-blocking** content polish for Phase 11.
- No unresolved functional Phase 10 blockers.
- Defaults remain off (`VOICE_V4_*` opt-in flags false).

## Remaining founder decisions (optional, Phase 11)

1. Align success-path `CALLBACK_CONFIRMATION_TEXTS.finalized` with playbook MD wording.
2. Enable `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED` on canary when ready.
3. Live STT tuning for spoken-digit capture edge cases.

**No commit** until Codex review.
