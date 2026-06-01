# TechnoloHit Voice Assistant v4 — Phase 7 Lead Policy, Post-Call Reliability, And Privacy Report

Date: 2026-06-01  
Status: **Ready for Codex review** (canary lead/post-call layer; production remains v3)  
Blueprint: [voice_assistant_v4_realtime_tenant_ready_blueprint.md](./voice_assistant_v4_realtime_tenant_ready_blueprint.md)  
Prior phase: Phase 6 RAG product/sales Q&A (tag `v1.9.0`)

## Objective

Wire and harden the v4 **lead policy**, **post-call reliability**, and **privacy** layer so the canary runtime can produce lead candidates safely without bypassing deterministic validators or leaking sensitive data.

## Files inspected

| File | Role |
|------|------|
| `voice-bridge/src/v4/lead-validator.js` | Callback-ready guards, RAG lead blocks |
| `voice-bridge/src/lead-policy.js` | Shared `deriveLeadNextAction`, strict callback rules |
| `voice-bridge/src/post-call-lead.js` | Post-call lead extraction |
| `voice-bridge/src/post-call-summary.js` | Summary metadata generation |
| `voice-bridge/src/post-call-notify.js` | n8n webhook payloads |
| `voice-bridge/src/post-call.js` | Post-call pipeline orchestration |
| `voice-bridge/src/v4/call-session-memory.js` | Structured memory + redacted persistence |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Lead transitions + close handoff |
| `voice-bridge/src/v4/quality-events.js` | Quality event builders |
| `lead-dashboard/app/privacy.py` | Dashboard mask/reveal model (unchanged) |

## Files changed / added

| File | Change |
|------|--------|
| `voice-bridge/src/v4/lead-candidate.js` | **New** — explicit lead candidate from `CallSessionMemory` |
| `voice-bridge/src/v4/post-call-bridge.js` | **New** — v4 summary metadata + close handoff |
| `voice-bridge/src/v4/privacy-sanitize.js` | **New** — mask/redact for outbound payloads |
| `voice-bridge/src/v4/transcript-intent.js` | **New** — breaks circular import with RAG/planner |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Lead candidate on close; structured validator inputs |
| `voice-bridge/src/v4/lead-validator.js` | `assertRagCannotSetLeadReady` |
| `voice-bridge/src/v4/response-planner.js` | Import from `transcript-intent.js` |
| `voice-bridge/src/v4/rag-orchestrator.js` | Import from `transcript-intent.js` |
| `voice-bridge/src/v4/quality-events.js` | `buildPostCallErrorEvent` |
| `voice-bridge/src/post-call-lead.js` | Config bug fix; email≠callback guard; privacy sanitize |
| `voice-bridge/src/post-call-summary.js` | Merge v4 tenant/agent/version metadata patch |
| `voice-bridge/src/post-call-notify.js` | Privacy sanitize + idempotency key |
| `voice-bridge/src/post-call.js` | Notification fail-safe try/catch |
| `voice-bridge/tests/v4-phase7-lead-postcall-privacy.test.js` | **New** Phase 7 tests (18 cases) |

**Not modified:** `turn-assistant.js`, production env files, `docs/Tasks/logs.txt`, lead-dashboard reveal/audit routes.

## Lead policy acceptance / rejection matrix

| Scenario | Result |
|----------|--------|
| Phone preference + granted permission + valid caller ID | **Accepted** → `team_callback`, `callback_ready: true` |
| Phone preference + granted permission + no valid phone | **Rejected** → `manual_review` |
| Incomplete spoken phone (`0170`, `123`, etc.) | **Rejected** → `incomplete_spoken_phone` |
| Email preference | **Never** `team_callback` → `await_customer_email` |
| RAG/product Q&A source | **Never** creates lead / sets `lead_ready` |
| LLM-granted permission without explicit user consent | **Rejected** |
| Post-contact product/pricing question | Contact/lead state **preserved** |

## Privacy guardrails

- No full phone in v4 post-call metadata, quality events, or notification payloads
- `maskPhoneForExternal` for outbound phone fields; `phone_masked` on lead candidates
- `assertNoRawPhoneInPayload` uses phone-like detection (not timestamps/version strings)
- Booleans like `phone_present` preserved (not stringified to `[redacted]`)
- No full transcript in v4 summary metadata (`include_full_transcript: false`)
- Lead-dashboard reveal/audit model unchanged — full phone only via explicit reveal action

## Post-call reliability

| Behavior | Status |
|----------|--------|
| Summary failure → lead skipped, notification skipped | Existing + unchanged path |
| Lead extraction failure → summary kept, notification still attempted | Existing try/catch in `post-call.js` |
| Notification failure → logged, persisted as failed | **Added** try/catch wrapper |
| Duplicate lead row | Existing `getLeadByCallSessionId` enrichment first |
| Webhook idempotency key | **Added** `idempotency_key` in notification payload |
| v4 tenant/agent/version in summary metadata | **Added** via `buildV4PostCallSummaryMetadata` |

## Default production behavior

**Unchanged.**

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_CANARY_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
```

Live calls route to **v3**; v4 lead/post-call handoff runs in canary orchestrator close path only.

## Rollback

1. Keep production defaults above.
2. Revert Phase 7 files if needed; no DB migrations.
3. Deploy prior image tag (e.g. `v1.9.0`) — v3 path unaffected.

## Test results

| Suite | Result |
|-------|--------|
| `cd voice-bridge && npm test` | **199/199 pass** |
| `python -m pytest rag-api/tests` | **6/6 pass** |
| `node --check` on changed JS | **pass** |
| `git diff --check` | **clean** |

## Remaining risks / blockers

- v4 post-call handoff is **canary/memory-only** until live AudioSocket + DB persistence wiring (Phase 8–9).
- Post-call summary still reads v3 turn rows in production; v4 metadata patch applied when `ctx.v4PostCallMetadata` supplied.
- n8n dedup depends on workflow consuming `idempotency_key` (documented in existing notification blueprint).
- Live end-to-end post-call QA on production DB not run in this phase.

## Next phase

**Phase 8 — Observability And Quality Analytics** (persist v4 quality events to DB, latency/error visibility, QA queries).
