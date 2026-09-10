# Phase 12N - Multi-Endpoint Phone Capture Remediation

Date: 2026-09-10
Status: **Implemented and locally verified; release not yet deployed**
Release target: **`voice-bridge-v1.36.6`**

## Production evidence

Phase 12N Part D placed exactly one supervised call on `voice-bridge-v1.36.5` and rolled back safely.

| Evidence | Value |
|----------|-------|
| `call_session_id` | `fb53e18a-c14d-40d1-ae8e-bd520b215d04` |
| `bridge_call_id` | `4b738efd-9abc-4f02-955a-5dfb0fedc653` |
| Runtime route | `v4_canary` / `v4_live_canary_selected` |
| Callback result | `request_phone_once` -> `request_phone_once_retry` -> `callback_manual_review` |
| Failure reason | `phone_capture_failed_after_retry` |
| Post-call pipeline | completed; notification HTTP 200 |
| Lead | not created, correctly, because callback guards were not met |
| Rollback | v3 / RAG-off / v4 flags off; Asterisk active calls 0 |

Classification: **Phase 12N Part D acceptance blocked by phone capture protocol completion.** Routing, rollback, post-call processing, notification, and lead guards behaved correctly.

## Root cause

Phase 12J treated every completed STT endpoint as a complete phone-capture attempt. It could parse a number delivered in one transcript, but it did not retain a partial fragment between VAD/STT endpoints. A naturally paused number could therefore consume the one retry on the first fragment and fall into manual review before the remaining digits were combined.

This is an endpoint-boundary problem, not an STT recognition, callback permission, lead persistence, or RAG problem.

## Fix

### Protected fragment extraction

`spoken-phone-capture.js` now extracts numeric and German spoken-digit fragments without logging or persisting them.

`live-dialogue-endpoint.js` applies the same context-aware guard before rendering its transcript preview, so a short partial fragment cannot leak through a log line before orchestration.

### In-call accumulation

`phone-capture-policy.js` combines fragments while `PHONE_NUMBER_PENDING` is active:

- national (`0...`) or international (`+...`) prefixes restart the candidate
- repeated suffixes are de-duplicated
- overlapping fragments merge only with a three-character or longer overlap
- candidates over 15 digits restart from the latest fragment
- the existing deterministic `validatePhoneForCallback()` remains the final authority

### Orchestrator ownership

`dialogue-orchestrator.js` keeps the partial value only in:

```text
orchestrator.protectedPhoneCaptureFragment
```

It is cleared after success, refusal, closing, or terminal failure. A successfully combined number follows the existing protected path:

```text
orchestrator.callerPhoneNormalized
  -> v4PostCallHandoff.protectedNormalizedPhone
  -> voice.leads.normalized_phone
```

### Safe evidence

The public plan and `response_plan_created` may expose only:

- `phone_capture_accumulated` (boolean)
- `phone_capture_segment_count` (number)

They never expose full or partial digits. Partial phone-like transcripts are persisted as `[phone_redacted]` while the phone-capture state is locked.

## Tests

New suite: `voice-bridge/tests/v4-phase12n-multi-endpoint-phone-capture.test.js`

- numeric split across two endpoints reaches callback permission
- spoken German digits split across endpoints reach callback finalization
- a repeated full number safely replaces a partial candidate
- retry exhaustion clears the protected candidate
- refusal clears the protected candidate
- live log preview, public plan, memory, quality events, summary metadata, and notification-facing payloads contain no known numeric or spoken phone sequence
- ordinary product wording with number words remains unaffected outside a detected phone candidate

## Verification

| Check | Result |
|-------|--------|
| `npm test` | 819 tests: 818 pass, 0 fail, 1 expected skip |
| Phase 12H/12J/12M/12N focused tests | 33/33 pass |
| `npm run playbook:publish-validate:published` | pass; eval 33/0/0, decision 13/0/0 |
| `npm run playbook:canary-artifact-validate` | pass; approved checksum unchanged |
| `python -m pytest rag-api/tests -q` | 7/7 pass |
| `node --check` changed JavaScript | pass |
| `run-ci-dialogue-scenarios.ps1` | 26/26 pass |

The final counts must be refreshed after applying the reviewed patch to the main repository.

## Release and operational gate

No deploy or second call is authorized from this implementation report alone.

After release as `voice-bridge-v1.36.6`, Sysadmin may run one supervised missing-caller-ID callback canary using the existing baseline, immutable digest, preflight, one-call, evidence, and rollback gates. The call should speak the number with one natural pause so multi-endpoint handling is exercised.

Acceptance requires:

- `collect_contact_preference` -> `request_phone_once` -> `collect_callback_permission` -> `callback_finalized` -> `closing`
- `phone_capture_accumulated=true` and `phone_capture_segment_count >= 2` when the STT input is split
- `lead_created_count=1` with protected `voice.leads.normalized_phone`
- no raw or partial phone digits on public surfaces
- dashboard masked phone and audited Reveal verification
- n8n email/Telegram readable with no literal `undefined`
- immediate rollback to v3/RAG-off after evidence

Phase 13 remains blocked until this canary and the remaining Phase 12L operational checks pass.

## Scope boundaries

- No RAG changes or enablement
- No production v4/global activation
- No callback permission or lead-policy relaxation
- No production env, Docker/deploy workflow, `rag-api`, or `docs/Tasks/logs.txt` changes
