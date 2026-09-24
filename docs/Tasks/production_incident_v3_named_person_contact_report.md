# Production Incident IR-2026-09-24 — Increment A

**Title:** v3 named-person / human-contact intent repair  
**Date:** 2026-09-24  
**Status:** Implemented — awaiting Codex re-review (not committed)  
**Branch:** `incident/ir-2026-09-24-v3-named-person-contact` (from `origin/main`)  
**Scope:** Increment A only — deterministic intent classification. No deploy, no live QA.

## Root cause

`voice-bridge/src/turn-assistant.js` `detectIntent()` recognized generic human-contact phrases such as:

- `mit jemandem sprechen`
- `mit einem Menschen sprechen`
- `Team sprechen`

but **did not** recognize natural named-person requests such as:

- `Ich möchte mit Herrn <surname> sprechen`

Those utterances fell through to `unknown` / product discovery instead of the existing safe soft-intake handoff path (`handoff_requested` → contact preference email/phone).

## Codex review blockers addressed

1. **Repeated handoff while preference pending:** When contact preference is pending and the new intent is `handoff_requested`, restate `HANDOFF_CONTACT_PREFERENCE_TEXT`. Do not use acoustic `CONTACT_PREFERENCE_REASK_*` wording (`akustisch` / `nicht verstanden`) and do not enter product discovery. The product repeat-guard exception is limited to that case only (`handoff_requested` + preference pending). `callback_request` keeps prior preference/phone matching behavior.
2. **Priority:** Explicit named-person / human-contact is resolved **before** pricing and product discovery. Closing and active contact-detail/permission handling remain higher priority via existing soft-intake gates. Mixed-intent regression: `Ich möchte mit Herrn Neumann über den Preis sprechen.` → `handoff_requested`, not `pricing_question`.
3. **Titleless-name detection tightened:** No expanding denylist for arbitrary `mit <token>`. Prefer:
   - Herr/Frau + name;
   - titleless first + surname (two plausible name tokens);
   - single name only with a stronger explicit connection phrase (`Verbinden Sie mich … mit`, `Stellen Sie mich … zu/mit`).
   Titleless product-token exclusions are **derived from `PRODUCT_INTAKE_POLICY` aliases** (plus a small fixed generic non-person role set). No employee directory. No manually duplicated product-alias list.

## Exact behavior after Increment A

| Caller utterance (examples) | Intent | Assistant path |
|-----------------------------|--------|----------------|
| `Ich möchte mit Herrn Neumann sprechen.` | `handoff_requested` | Soft intake contact preference (email vs phone) |
| `Kann ich Frau Neumann erreichen?` | `handoff_requested` | Same |
| `Ich möchte mit Martin Neumann sprechen.` (titleless two-token) | `handoff_requested` | Same |
| `Verbinden Sie mich bitte mit Martin.` (strong connect + single name) | `handoff_requested` | Same |
| `Ich möchte mit Martin sprechen.` (single token after mit) | **not** handoff | Unchanged non-handoff path |
| `Ich möchte mit Herrn Neumann über den Preis sprechen.` | `handoff_requested` | Same — not pricing |
| `Bitte verbinden Sie mich mit Herrn Ziegler.` (unknown person) | `handoff_requested` | Same — no employee directory lookup |
| `Ich möchte mit jemandem sprechen.` | `handoff_requested` | Regression preserved |
| `Ich möchte mit AI Assistant / digitale Rezeption / Marketing Automation / KI Chatbot / Smart Website / SEO sprechen.` | existing product selection path | **not** `handoff_requested` |
| Product-only / pricing questions | unchanged | Not reclassified as handoff |

Guarantees:

- Maps to **existing** `handoff_requested` soft-intake path (no new product feature).
- Does **not** extract, validate, persist, or log employee names.
- Does **not** claim live transfer or invent an employee directory.
- First response and repeated `handoff_requested` while preference is pending use approved contact-preference wording (`HANDOFF_CONTACT_PREFERENCE_TEXT`) — no “verbinde Sie jetzt”, no acoustic reask, no product discovery.
- Named-person / human-contact detection runs **before** pricing and product discovery.
- Closing phrases are not classified as human contact; existing closing priority elsewhere is unchanged.
- Lead, permission, privacy, and callback guards are untouched; explicit callback while preference is pending still selects the phone path.
- Production default remains **v3**; no v4/RAG enablement.

## Implementation

| File | Role |
|------|------|
| `voice-bridge/src/human-contact-intent.js` | Deterministic detector; titleless product tokens from `PRODUCT_INTAKE_POLICY` |
| `voice-bridge/src/turn-assistant.js` | Detector before pricing/product; handoff-only preference restatement + narrow repeat-guard exception |
| `voice-bridge/tests/v3-named-person-human-contact.test.js` | Unit + processTextTurn coverage (mixed Preis, product negatives, repeated handoff/pricing, callback) |
| `voice-bridge/scripts/qa-dialogue-text.js` | Scenario `v3_named_person_human_contact` |
| `voice-bridge/scripts/run-ci-dialogue-scenarios.ps1` | Scenario list |
| `.github/workflows/ci.yml` | Scenario list parity |

## Separate follow-up tracks (not in this increment)

### 1. Caller-ID propagation

Documented gap only: when a named-person / human-contact caller later chooses phone callback, ensure caller-ID (when present) and spoken capture still feed protected lead persistence correctly. This is adjacent to Phase 12M persistence work and must not be mixed into Increment A.

### 2. Manual-review dashboard for named-person / human-contact leads

Documented gap only: operators may need dashboard visibility that the caller asked for a person/team handoff (without storing the spoken name). UI/filters/audit for that signal are **unimplemented** here.

## Remaining risks

- Single-token first names without Herr/Frau or a strong connect phrase are intentionally **not** classified as handoff (reduces product false positives; may miss some ASR-stripped named requests).
- Very noisy STT that drops “Herr/Frau” and the speak/connect framing may still miss the request.
- Closing-while-in-permission-state edge cases remain governed by existing soft-intake logic (out of Increment A scope).
- Production redeploy / supervised verification still required after Codex re-review and release.

## Verification (local)

| Check | Result |
|-------|--------|
| `cd voice-bridge && npm test` | **828 pass**, 1 skipped |
| `py -3 -m pytest rag-api/tests` | **7/7** |
| `node --check` (changed JS) | pass |
| `git diff --check` | pass |
| `run-ci-dialogue-scenarios.ps1` | **27/27** |

**Not committed / not pushed** — awaiting Codex re-review.
