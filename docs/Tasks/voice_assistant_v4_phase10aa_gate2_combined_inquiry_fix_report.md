# Phase 10AA — Gate 2 Combined Smart Website Inquiry Fix

Date: 2026-06-03  
Target release: **`voice-bridge-v1.34.2`**

## Review outcome (Phase 10AB superseded)

**v1.34.2 is not approved for live Gate 2 re-test.**

The combined answer shipped in v1.34.2 was **413 characters**. Default live TTS uses
`VOICE_ASSISTANT_MAX_RESPONSE_CHARS=160` via `prepareLiveAssistantSpeechText()`.
The pricing section was trimmed before callers could hear it, even with an optional
300-char env override.

Follow-up fix: [Phase 10AB report](./voice_assistant_v4_phase10ab_live_heard_combined_inquiry_fix_report.md)
→ target **`voice-bridge-v1.34.3`**.

## Original problem (correct)

`detectShortFollowUpCategory()` returned only one category (pricing won when "kostet"
was present), so multi-question Smart Website turns skipped intro + value.

## What v1.34.2 did (partial)

| Area | Change |
|------|--------|
| `playbook-short-answer.js` | `detectCombinedProductInquiry()` + `buildPlaybookCombinedProductAnswer()` |
| `response-planner.js` | Combined answer before single-category fallback |

## What v1.34.2 did not fix (10AB blocker)

| Issue | Detail |
|-------|--------|
| Live TTS length | Combined text too long for default 160-char trim |
| Env dependency | Suggested `VOICE_ASSISTANT_MAX_RESPONSE_CHARS=300` — not acceptable |
| Sanitization | `einen Rückruf` → `einen Kontaktaufnahme` grammar bug in callback offer |
| Shared v3 copy | `sales-policy.js` Smart Website explanation changed unnecessarily |

## Gate status after 10AA review

| Gate | Status |
|------|--------|
| Stage A | PASS |
| Gate 1 v3/RAG-off | PASS |
| Gate 2 v4/RAG-off infra | PASS |
| Gate 2 v4/RAG-off functional | **FAIL on v1.34.2** — wait for **v1.34.3** (10AB) |
| Gate 3 | Blocked |
