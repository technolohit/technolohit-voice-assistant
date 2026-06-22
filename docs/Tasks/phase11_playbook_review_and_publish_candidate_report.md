# Phase 11 — Playbook Review, Validation, and Publish Candidate Report

> **Phase 11A closure update (2026-06-22):** Founder decisions are resolved and Phase 11 governance is complete. The immutable published artifact is `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.published.json` (`technolohit-playbook-v1-20260622-published`). It is content-approved but remains runtime-inactive (`runtime_binding.active=false`); activation and canary approval have not started. The authoritative closure details are in `docs/Tasks/phase11a_publish_governance_closure_report.md`.

**Date:** 2026-06-22
**Source commit (Phase 10 baseline):** `389e0d0254797857b389677e7a5c3b9633355729`
**Draft baseline:** `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json`
**Publish candidate:** `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.publish-candidate.json`
**Playbook version (candidate):** `technolohit-playbook-v1-20260620-candidate`
**Candidate founder approval:** pending (historical candidate state)
**Published founder approval:** approved by Mojtaba on 2026-06-22
**Runtime binding:** inactive on both artifacts (`runtime_binding.active=false`)

---

## Executive summary

Phase 11 delivers governance-only artifacts: a founder review matrix, documentation drift analysis, an immutable publish candidate JSON, and non-live publish validation tooling (`npm run playbook:publish-validate`). No runtime activation, no deploy, no production env changes, and no v4 flag changes were made.

The publish candidate passes schema validation, policy checks, eval gates (33/0/0 playbook, 13/0/0 decision), and remains explicitly inactive pending Mojtaba approval.

**Closure:** Founder decisions are recorded in the published v1 artifact; no wording decision remains open in Phase 11.

---

## 1. Founder review matrix

| Area | Markdown source | JSON field | Runtime consumer | Eval scenario IDs | Current wording/value | Status |
|------|-----------------|------------|------------------|-------------------|----------------------|--------|
| Company positioning | §1 Company Positioning | `company.positioning_short`, `positioning_long`, `diagnostic_follow_up` | `playbook-product-content.js` → `resolveCompanyAnswer()` (when playbook runtime on) | `company_general_question` | Short/long German positioning + diagnostic follow-up match MD verbatim | **aligned** |
| Smart Website explanation | §5 Product: Smart Website | `products[smart_website].phone_answers.*`, `short_explanation` | `playbook-product-content.js` → `resolveProductAnswer()` | `combined_product_inquiry_smart_website` | 10s/25s/45s answers match MD | **aligned** |
| Smart Website pricing | §5 Price policy | `products[smart_website].price_policy.approved_phrase` | `playbook-product-content.js` (pricing path) | `pricing_question_smart_website` | "Der Preis hängt vom Umfang ab. Nach einer kurzen Website-Analyse…" | **aligned** |
| Smart Website follow-up | §5 Follow-up question | `products[smart_website].follow_up_question`, `questionnaire_policy.products.smart_website` | `playbook-questionnaire-generator.js` | `questionnaire_smart_website_after_answer` | "Möchten Sie, dass unser Team Ihre Website kurz analysiert?" / questionnaire variant for relaunch goals | **equivalent** (questionnaire uses project-context variant by design) |
| Voice Agent explanation | §6 Product: Voice Agent | `products[voice_agent].phone_answers.*` | `playbook-product-content.js` | `voice_agent_explanation` | 10s/25s/45s match MD | **aligned** |
| Voice Agent pricing | §6 Price policy | `products[voice_agent].price_policy.approved_phrase` | `playbook-product-content.js` | `voice_agent_price` | Entry ~65 €/Monat as orientation, not fixed price | **aligned** |
| Voice Agent follow-up | §6 Follow-up | `follow_up_question` | `playbook-questionnaire-generator.js` | `questionnaire_voice_agent_after_answer` | "Geht es bei Ihnen eher um viele Anrufe…" | **aligned** |
| AiseoQ explanation | §7 Product: AiseoQ | `products[aiseoq].phone_answers.*` | `playbook-product-content.js` | `aiseoq_explanation` | 10s/25s/45s match MD | **aligned** |
| AiseoQ pricing | §7 Price policy | `products[aiseoq].price_policy.approved_phrase` | `playbook-product-content.js` | `aiseoq_price` | ~40 €/Seite/Monat orientation + scope language | **aligned** |
| AiseoQ follow-up | §7 Follow-up | `follow_up_question` | `playbook-questionnaire-generator.js` | (via product content) | "Geht es Ihnen eher um Google-Ranking…" | **aligned** |
| LokalKI low-priority / direct-only | §8 Product: LokalKI | `priority: low`, `answer_only_when_asked: true` | `playbook-loader.js` validator; `playbook-product-content.js` | `questionnaire_lokalki_after_answer` | Not proactively sold; short answers only when asked | **aligned** |
| Role boundaries | §2 Global rules + §9 Priority | `role.boundaries`, `conversation_priority_contract`, `escalation_policy` | `response-planner.js`, `transcript-intent.js`, `rag-orchestrator.js`, `agent-behavior-decision.js` | `out_of_scope_general_question`, `technical_escalation`, `questionnaire_blocked_*` | No general chatbot, no guarantees, callback blocks RAG/questionnaire | **aligned** |
| Callback / contact policy | §3 Contact Capture + §9 flow | `callback_policy`, `contact_capture_policy`, `lead_capture_policy` | `callback-flow-policy.js`, `caller-id-callback-policy.js` | `callback_request`, `company_general_with_callback_request`, `questionnaire_callback_contact_preference` | Permission-first callback; no live transfer claims | **aligned** (confirmation wording see drift §2) |
| Caller-ID available path | §3 If Caller ID available | `contact_capture_policy.caller_id_policy.caller_id_available_phrase` | `caller-id-callback-policy.js` (when playbook runtime on); hardcoded default otherwise | `caller_id_available_permission` | Playbook/MD: "…unter **dieser** Nummer zurückrufen?" | **runtime safety override** (live default: "…unter **Ihrer** Nummer zurückmelden?" until playbook runtime bound) |
| Caller-ID missing ask-phone-once | §3 If Caller ID missing | `caller_id_missing_phrase`, `max_phone_asks: 1` | `callback-flow-policy.js`, `caller-id-callback-policy.js`, `spoken-phone-capture.js` | `caller_id_missing_request_phone_once`, `valid_*_phone_*`, `invalid_spoken_phone_manual_review`, `no_repeat_phone_request` | "Unter welcher Telefonnummer…" once, then manual review / contact form | **aligned** |
| Manual review / contact form fallback | §3 contact form + §9 no-phone path | `contact_form_handoff.phrase`, `caller_id_policy.phone_capture_failure_phrase` | `response-planner.js`, `caller-id-callback-policy.js` | `contact_form_handoff_complex_details`, `invalid_spoken_phone_manual_review` | Current concise `DEFAULT_PHONE_CAPTURE_FAILURE_PHRASE` | **aligned and founder-approved** |
| Closing wording | §9 closing example | `closing_policy.phrases`, `closing_policy.response` | `response-planner.js`, `behavior-policy.js` (hardcoded when playbook off) | `closing_after_product_answer`, `closing_stop_with_thanks` | "Sehr gerne. Dann wünsche ich Ihnen noch einen schönen Tag. Auf Wiederhören." | **aligned** |
| Lead tiers | §4 Lead Policy | `lead_tiers.*` | `agent-behavior-decision.js` (advisory metadata), lead validators | (implicit in callback evals) | All five tiers defined with `lead_ready.requires` | **aligned** |
| Notification behavior | Implicit (post-call workflow) | `notification_policy` | Existing post-call pipeline (unchanged) | (documented expectation only) | email + telegram, idempotent, Mojtaba/team | **equivalent** (MD does not spell out channels; JSON documents existing workflow) |
| No email/URL/company capture by voice | §2–3 Do not | `contact_capture_policy.no_*` flags + redirect phrases | `response-planner.js`, `questionnaire-runtime.js` | `no_email_capture_by_voice`, `no_website_url_capture_by_voice` | Redirect to contact form; no voice capture | **aligned** |

---

## 2. Documentation drift analysis

Compared: `docs/TechnoloHit Product Playbook v1.md`, publish-candidate JSON, `callback-flow-policy.js`, `caller-id-callback-policy.js`, `behavior-policy.js`, `playbook-product-content.js`.

| # | Topic | Markdown | JSON playbook | Runtime (current prod defaults) | Classification |
|---|-------|----------|---------------|----------------------------------|----------------|
| 1 | Callback success confirmation | Updated to "Ich **habe** die Anfrage **aufgenommen**…" | `callback_policy.finalized_confirmation` in published v1 | Matches `CALLBACK_CONFIRMATION_TEXTS.finalized` | **resolved / approved** |
| 2 | Caller-ID permission phrase (available) | "…unter **dieser** Nummer zurückrufen?" | `caller_id_available_phrase` matches MD | `caller-id-callback-policy.js` default (playbook off): "…unter **Ihrer** Nummer zurückmelden?" | **runtime safety override** until playbook runtime binding |
| 3 | Phone capture failure / no valid phone | Updated to concise contact-form fallback | `caller_id_policy.phone_capture_failure_phrase` in published v1 | Matches `DEFAULT_PHONE_CAPTURE_FAILURE_PHRASE` | **resolved / approved** |
| 4 | Callback reassurance ("Hallo?") | "Ihre Rückrufanfrage ist aufgenommen. Unser Team prüft das…" | Not duplicated in JSON | `buildCallbackReassuranceText()` hardcoded variants | **equivalent/non-blocking** (same intent; minor wording) |
| 5 | Botinteg product | Not in founder MD v1 | Excluded from published v1; retained only in draft/candidate history | Not in required product IDs | **resolved: excluded from published v1** |
| 6 | Smart Website `pricing_answer` vs `approved_phrase` | Single approved phrase | `pricing_answer` shorter generic; `price_policy.approved_phrase` matches MD | Resolver prefers approved phrase when playbook on | **equivalent/non-blocking** |
| 7 | `behavior-policy.js` hardcoded closing | Matches MD closing response | `closing_policy.response` identical | Used in production today | **aligned** |
| 8 | Playbook product content loading | N/A | Full product corpus | `playbook-product-content.js` only active when `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=true` (off) | **runtime safety override** (by design) |

**Do not silently resolve:** items 1, 3, and 5 require explicit Mojtaba decisions before treating the publish candidate as founder-approved content.

---

## 3. Publish candidate artifact

| Property | Value |
|----------|-------|
| Path | `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.publish-candidate.json` |
| `playbook_version` | `technolohit-playbook-v1-20260620-candidate` |
| `status` | `draft` (validator does not allow `review_candidate`; candidate metadata carries review state) |
| `runtime_binding.active` | `false` |
| `approval.approved_for_runtime` | `false` |
| `approval.founder_approval` | `pending` |
| `publish_candidate.source_commit_sha` | `389e0d0254797857b389677e7a5c3b9633355729` |
| `publish_candidate.generated_date` | `2026-06-20` |
| Prior version | `technolohit-playbook-v1-20260611` |

The candidate preserves business/product policy content from the Phase 9/10 consolidation baseline while adding governance metadata and expanded eval mappings. It is not byte-identical to the draft.

### Published artifact

| Property | Value |
|----------|-------|
| Path | `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.published.json` |
| `playbook_version` | `technolohit-playbook-v1-20260622-published` |
| `status` | `published` |
| `approval.approved_for_runtime` | `true` (content approval only) |
| `approval.founder_approval` | `approved` |
| `approval.approval_date` | `2026-06-22` |
| `runtime_binding.active` | `false` |
| `approval.canary_approval` | `pending` |

---

## 4. Publish validation tooling

| Component | Path |
|-----------|------|
| Validator module | `voice-bridge/src/v4/playbook-publish-validator.js` |
| CLI script | `voice-bridge/scripts/playbook-publish-validate.js` |
| Candidate command | `npm run playbook:publish-validate` |
| Published command | `npm run playbook:publish-validate:published` |

The CLI requires an explicit mode and artifact path. It fails closed on candidate/published mismatch, active runtime binding, wrong approval metadata, duplicate versions, eval failure/pending results, unapproved published-v1 content, or privacy-unsafe output.

---

## 5. Approval workflow (two-step)

### Step A — Candidate (complete)

1. Run `npm run playbook:publish-validate` → must output `playbook_publish_validation=pass`.
2. Confirm eval green: playbook 33/0/0, decision 13/0/0.
3. Confirm `runtime_binding.active=false` and `approved_for_runtime=false`.
4. Mojtaba reviewed this report + matrix + drift list.
5. Founder decisions were recorded on 2026-06-22.

### Step B — Publish (complete, runtime inactive)

1. Created the immutable `technolohit.main_voice_sales.v1.published.json` artifact.
2. Set `status=published`, nested `approval.approved_for_runtime=true`, and recorded owner/date/resolved decisions.
3. Keep `runtime_binding.active=false` until a **separate** canary/runtime activation approval.
4. `npm run playbook:publish-validate:published` passes with the published-mode rules.

**Publishing content and activating runtime are separate decisions.**

---

## 6. Founder decisions recorded

1. Keep the live-tested finalized callback wording.
2. Keep the concise current no-valid-phone contact-form fallback.
3. Exclude Botinteg from published v1.

---

## 7. Verification (Phase 11 run)

Commands executed during this phase (see final report for results):

- `cd voice-bridge && npm test`
- `npm run playbook:publish-validate`
- `python -m pytest rag-api/tests`
- `node --check` on changed JS
- `git diff --check`
- `run-ci-dialogue-scenarios.ps1`

---

## 8. Boundaries confirmed

- No live planner behavior changes
- No production env / Docker / deploy / rag-api / live-canary script changes
- No v4 flags enabled
- No `runtime_binding.active=true`
- Candidate remains unapproved; published content approval does not activate runtime
- No git commit (awaiting Codex review)
