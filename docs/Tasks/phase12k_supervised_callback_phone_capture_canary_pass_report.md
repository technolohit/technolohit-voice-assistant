# Phase 12K — Supervised Callback Phone Capture Canary Pass Report

Date: 2026-06-25  
Status: **PASS (dialogue)** / **operational persistence incomplete on v1.36.4** — see Phase 12M
Image: `thnhit/technhvoice:voice-bridge-v1.36.4`  
Commit: `d33adc7` (Phase 12J lock phone capture turn taking)

## Executive summary

Supervised missing-caller-ID callback phone capture canary on the approved playbook binding **passed** on **`voice-bridge-v1.36.4`**. Exactly **one** PSTN call was executed. The callback flow completed:

`collect_contact_preference` → `request_phone_once` → `collect_callback_permission` → `callback_finalized` → `closing`

Production was restored to **v3 / RAG-off** after evidence capture.

**Phase 12M follow-up:** Live dialogue and callback finalization passed, but `voice.leads.normalized_phone` was empty for `lead_id=741f6e28-ffb8-4e66-8a23-2bc10551bb40` while summary showed `phone_present=true`. Operational persistence fix targets **`voice-bridge-v1.36.5`**. Phase 12L Lead Dashboard reveal verification was blocked.

## Release artifact

| Item | Value |
|------|-------|
| Docker image | `thnhit/technhvoice:voice-bridge-v1.36.4` |
| linux/amd64 digest | `sha256:c9f9c61fd0d6c4f604bff4d6517a5c989a14437d3236eebe73f6c83b84a3d444` |
| Published playbook checksum | `f8bb259a09d409242b876939ebefb63bf7031bb6bccbaa70e8e1b56cb786a21c` (unchanged) |

## Supervised call evidence

| Field | Value |
|-------|-------|
| Calls | **1** (exactly one supervised canary call) |
| `call_session_id` | `7a76318a-05b4-4853-b1cb-bf8bc0478cfb` |
| `bridge_call_id` | `4737af80-f805-4b3e-bc6c-8ec4b33c1464` |
| Handler | `v4_canary` |
| Selection reason | `v4_live_canary_selected` |
| `playbook_version` | `technolohit-playbook-v1-20260622-published` |
| `playbook_source` | `approved_runtime_binding` |
| RAG | **off** (`rag_used=false` on callback turns) |
| `lead_created_count` | **1** |
| `normalized_phone` persisted | **No** on `v1.36.4` (Phase 12M fix) |
| Privacy scan (phone-like in payloads) | **0** matches |
| Notification | HTTP **200** (`action=sent`, `reason=ok`) |
| Rollback | **v3 / RAG-off** restored after call |

## Callback flow sequence (live)

| Step | Caller (summary) | `response_type` | Notes |
|------|------------------|-----------------|-------|
| 1 | Callback request | `collect_contact_preference` | Playbook-bound routing |
| 2 | Phone preference | `request_phone_once` | Missing caller ID |
| 3 | Spoken mobile number | `collect_callback_permission` | Phase 12J lock + capture |
| 4 | Permission grant (`Ja.`) | `callback_finalized` | Callback-ready lead path |
| 5 | Closing phrase | `closing` | Clean hangup |

## Preflight (before call)

| Check | Result |
|-------|--------|
| `playbook:canary-artifact-validate` | pass |
| `playbook:canary-preflight` (v4 window) | pass |
| `call_handler selected=v4_canary` | observed at call start |
| Approved binding resolves published bytes | pass (`published_sha256=f8bb259a…`) |

## Post-call

| Check | Result |
|-------|--------|
| `voice.call_summaries` | 1 row |
| `voice.leads` | callback-ready lead created |
| `quality_flush_completed` | pass |
| Raw phone in quality payloads | none |
| Stale session after rollback | none |

## Phase 12 arc (closure)

| Phase | Result |
|-------|--------|
| 12D | PARTIAL PASS / acceptance fail (provenance/TTS/callback abandon) |
| 12E | Fix shipped (`v1.36.2`) |
| 12G | FAIL — phone capture on live STT |
| 12H | Fix shipped (`v1.36.3`) — raw STT handoff |
| 12I | FAIL — turn-taking / state-lock |
| 12J | Fix shipped (`v1.36.4`) — locked phone capture sub-state |
| **12K** | **PASS** — supervised missing-caller-ID callback capture |

**Final classification: PASS (dialogue). Operational phone persistence: INCOMPLETE on v1.36.4.**

Phase 12 runtime behavior arc closed at 12K; ops readiness continues in 12L/12M.

## Observability follow-up (non-blocking)

`response_plan_created` may still omit explicit `callback_permission`, `callback_ready`, and `next_action` fields on some turns. Populating these in quality payloads is a **Phase 13** observability improvement — **not** a blocker for Phase 12 closure or limited operational canary readiness.

## Related reports

- [phase12j_phone_capture_state_lock_and_turn_taking_report.md](phase12j_phone_capture_state_lock_and_turn_taking_report.md)
- [phase12h_callback_phone_capture_handoff_fix_report.md](phase12h_callback_phone_capture_handoff_fix_report.md)
- [phase12e_live_playbook_provenance_and_spoken_integrity_report.md](phase12e_live_playbook_provenance_and_spoken_integrity_report.md)

## Constraints honored

- Supervised canary only; production returned to v3/off.
- No production env, rag-api, Docker/deploy workflow, or `docs/Tasks/logs.txt` changes as part of this closeout.
