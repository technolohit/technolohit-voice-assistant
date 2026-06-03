# Phase 10AA — Gate 2 Combined Smart Website Inquiry Fix

Date: 2026-06-03  
Target release: **`voice-bridge-v1.34.2`**

## Gate 2 functional failure (observed on v1.34.1)

Infrastructure passed (Stage A, v4/RAG-off canary, STT/TTS, barge-in, quality flush, post-call summary on v1.34.1).

Functional failure: combined Smart Website inquiry ("Was ist …?", "Was macht …?", "Was kostet …?") received only a single pricing or generic snippet instead of a structured product-scoped answer.

## Root cause

`detectShortFollowUpCategory()` returns **one** category (pricing wins when "kostet" is present).  
`planScopedProductAnswer()` and the `product_question` path therefore answered only pricing, skipping intro + value explanation.

## Fix

| Area | Change |
|------|--------|
| `playbook-short-answer.js` | `detectCombinedProductInquiry()` + `buildPlaybookCombinedProductAnswer()` |
| `response-planner.js` | Use combined answer before single-category playbook fallback |
| `sales-policy.js` | Sharper Smart Website one-line explanation |
| `live-tts-playback-endpoint.js` | Raise v4 live response fallback to 300 chars so combined answers are not truncated mid-sentence |

Required combined answer structure (Smart Website, RAG-off):

1. What Smart Website is (modern site, service pages, local visibility, trust, inquiry flow)
2. What it does for the caller (understand offer, better questions, qualified inquiries)
3. Pricing scoped with realistic estimate language
4. Optional soft callback/consultation offer — **not** immediate Neukunde/intake

## Gate 2 re-test script (sysadmin)

Deploy `voice-bridge-v1.34.2`, enable same Gate 2 v4/RAG-off flags as prior run.

Test utterance (single turn or natural multi-clause):

> Was ist Smart Website, was macht sie und was kostet sie?

**Pass criteria:**

- Response mentions Smart Website definition, customer value, and scoped pricing
- Does **not** jump to Neukunde/bestandskunde qualification on this turn
- Does **not** repeat a single generic one-liner only
- Post-call summary still created (`post_call_summary_created`)

Optional env (if answers still truncate):

```bash
VOICE_ASSISTANT_MAX_RESPONSE_CHARS=300
```

## Gate status

| Gate | Status |
|------|--------|
| Stage A | PASS |
| Gate 1 v3/RAG-off | PASS |
| Gate 2 v4/RAG-off | **Re-test on v1.34.2** |
| Gate 3 | Blocked until Gate 2 functional pass |
