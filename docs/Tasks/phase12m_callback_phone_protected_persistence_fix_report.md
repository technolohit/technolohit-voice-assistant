# Phase 12M — Callback Phone Protected Persistence Fix Report

Date: 2026-06-25  
Status: **Ready for Codex review** — not committed, tagged, deployed, or live-QA’d  
Release target (after review): **`voice-bridge-v1.36.5`**

## Context: Phase 12L / 12K operational blocker

Phase 12K supervised dialogue **passed** on `voice-bridge-v1.36.4`:

`collect_contact_preference` → `request_phone_once` → `collect_callback_permission` → `callback_finalized` → `closing`

But post-call persistence did **not** store the captured phone.

| Evidence | Value |
|----------|-------|
| `lead_id` | `741f6e28-ffb8-4e66-8a23-2bc10551bb40` |
| `call_session_id` | `7a76318a-05b4-4853-b1cb-bf8bc0478cfb` |
| `voice.leads.normalized_phone` | empty |
| `voice.call_sessions.caller_phone_*` | empty (by design for missing caller ID) |
| Summary metadata | `phone_present=true` |
| Quality `response_plan_created` | `phone_number_captured` present; no raw phone (correct) |
| Lead dashboard | “No phone captured”; Reveal not testable |

**Conclusion:** Runtime used `orchestrator.callerPhoneNormalized` for callback validation, but `runPostCallLeadExtraction()` only read `call_sessions.caller_phone_normalized` / `caller_phone_raw`. Spoken capture never wrote those session columns (privacy-by-design).

Phase 12L Lead Dashboard verification was **blocked** by this gap. **Phase 13 remains blocked** until 12M ships and is verified.

## Root cause

1. Phone capture stores full normalized digits only on the orchestrator (`callerPhoneNormalized`) via `consumeCapturedPhoneFromPlan()` — stripped from public `lastPlan` / quality payloads.
2. `finalizeV4PostCallHandoff()` built correct `leadCandidate.callback_ready=true` and `phone_present=true` in summary metadata.
3. `runPostCallLeadExtraction()` ignored v4 handoff and resolved phone exclusively from `call_sessions` — always empty for missing-caller-ID captures.

## Fix summary

### 1. Protected handoff field (`post-call-bridge.js`)

- New `resolveProtectedNormalizedPhoneForLeadPersistence()` — returns normalized phone **only** when `callback_ready` and phone validator passes.
- `finalizeV4PostCallHandoff()` now returns `protectedNormalizedPhone` on the handoff object.
- Field is **not** merged into `summaryMetadata`, quality events, notifications, or public metadata.

### 2. Lead persistence (`post-call-lead.js`)

- New `resolveLeadNormalizedPhoneForPostCall(ctx, session)`:
  - Prefer `ctx.v4PostCallHandoff.protectedNormalizedPhone`
  - Fallback to `call_sessions` caller-ID columns (valid caller ID path)
- `runPostCallLeadExtraction()` uses this for insert and update.
- `shouldCreateLead()` now requires a resolved protected phone when `contact_preference=phone` and `phone_present=true` — prevents callback-ready leads with empty `normalized_phone`.

### 3. Storage design (unchanged policy)

| Surface | Phone storage |
|---------|----------------|
| `orchestrator.callerPhoneNormalized` | Runtime-only during call |
| `voice.leads.normalized_phone` | **Operational source of truth** for callback follow-up |
| `voice.call_sessions.caller_phone_*` | Caller-ID path only; intentionally empty for spoken capture |
| Summary / quality / n8n | No raw phone (unchanged) |
| Lead dashboard | Masked until audited Reveal |

## Expected behavior after fix

| Step | Result |
|------|--------|
| Spoken phone capture | `orchestrator.callerPhoneNormalized` set; stripped from public plan |
| `closeCall` / handoff | `protectedNormalizedPhone` populated when `callback_ready` |
| Post-call lead insert | `voice.leads.normalized_phone` populated from handoff |
| Dashboard list | Masked phone visible |
| Reveal phone | Full number + `lead_access_audit` row |

## Tests added

**File:** `voice-bridge/tests/v4-phase12m-callback-phone-protected-persistence.test.js`

- Protected resolver requires `callback_ready`
- Handoff preferred over empty session
- Session caller-ID fallback
- Full missing-caller-ID sequence → `protectedNormalizedPhone` + privacy on summary/notification/memory
- Retry exhaustion → no protected phone / no callback-ready lead

## Manual backfill (Phase 12K lead only — do not auto-run)

If the operator has the captured number from supervised notes and approves one-time repair:

```sql
-- VERIFY FIRST: lead belongs to Phase 12K session and is callback-ready metadata
SELECT id, call_session_id, normalized_phone, metadata->>'next_action'
FROM voice.leads
WHERE id = '741f6e28-ffb8-4e66-8a23-2bc10551bb40'::uuid;

-- Only after explicit approval and with the verified normalized E.164/local digits:
-- UPDATE voice.leads
-- SET normalized_phone = '<VERIFIED_NORMALIZED_PHONE>',
--     updated_at = now()
-- WHERE id = '741f6e28-ffb8-4e66-8a23-2bc10551bb40'::uuid
--   AND call_session_id = '7a76318a-05b4-4853-b1cb-bf8bc0478cfb'::uuid
--   AND COALESCE(normalized_phone, '') = '';
```

Prefer re-verifying with a supervised test call on `v1.36.5+` over manual backfill when possible.

## Phase status updates

| Phase | Status |
|-------|--------|
| 12K dialogue | **PASS** (runtime flow) |
| 12K operational persistence | **INCOMPLETE** on `v1.36.4` — fixed in 12M |
| 12L | **BLOCKED** on lead phone / n8n email until 12M + n8n redeploy |
| 13 Limited Operational Canary | **BLOCKED** until 12M verified live |

## Constraints honored

- No deploy, live QA, v4 GA, or RAG enablement
- No rag-api, Docker/deploy workflow, production env, or `logs.txt` changes
- No automatic backfill executed

## Changed files (implementation)

| File | Change |
|------|--------|
| `voice-bridge/src/v4/post-call-bridge.js` | Protected phone resolver + handoff field |
| `voice-bridge/src/post-call-lead.js` | Resolve protected phone for lead insert/update |
| `voice-bridge/tests/v4-phase12m-callback-phone-protected-persistence.test.js` | New tests |
