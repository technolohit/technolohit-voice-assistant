# Phase 9 — Product Playbook Consolidation Report

Date: 2026-06-11
Scope: v3 blueprint Phase 9 only (`docs/Tasks/voice_assistant_v3_semantic_sales_agent_blueprint.md`).
Result: consolidation, validation, tests, and documentation only. **No live behavior change. No runtime enablement. No env/Docker/rag-api/deploy changes.**

Source-of-truth rule applied:

```text
docs/TechnoloHit Product Playbook v1.md
  = human/founder-approved source

voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json
  = schema-validated runtime source (runtime-inactive draft)

playbook eval scenarios
  = quality gate before canary
```

New playbook version: `technolohit-playbook-v1-20260611` (status `draft`, `runtime_binding.active=false`, `approved_for_runtime=false`).

---

## 1. Founder-approved Markdown sections found

`docs/TechnoloHit Product Playbook v1.md` (654 lines) contains:

| # | Section | Content |
|---|---------|---------|
| 1 | Company Positioning | short/long German phone answers, default diagnostic follow-up, company role (AI Receptionist + Lead Router + First-Level Product Advisor + AI Business Automation Partner) |
| 2 | Global Conversation Rules | primary goal, tone, general answer pattern (answer → one qualification question → next step), "do not" rules incl. no email/URL/company-name capture by voice |
| 3 | Contact Capture Policy | Caller-ID-available (permission only), Caller-ID-missing (ask phone once), email → contact form, website URL/company name → contact form, contact form phrase |
| 4 | Lead Policy | tiers: `information_request`, `qualified_interest`, `callback_requested`, `manual_review`, `lead_ready` (+ lead_ready conditions) |
| 5 | Smart Website | product_id, priority high, positioning, founder meaning, 10s/25s/45s answers, best-for, not-ideal-for, pains, customer phrases, follow-up question, approved price phrase (scope-based), contact form guidance, lead-ready conditions |
| 6 | Voice Agent / KI-Telefonassistent | priority high, positioning, 10s/25s/45s answers, best-for/not-ideal-for/pains/phrases, follow-up question, approved price phrase (ab ca. 65 €/Monat), integrations note, lead-ready conditions |
| 7 | AiseoQ | priority medium-high, positioning, 10s/25s/45s answers, best-for/not-ideal-for/pains/phrases, follow-up question, approved price phrase (ab ca. 40 €/Seite/Monat), contact form guidance, lead-ready conditions |
| 8 | LokalKI | priority low / answer only if asked, short + longer answer, follow-up, do-not rules |
| 9 | Conversation Priority Contract | 8-level priority order, allowed callback flow response types, callback flow turn-by-turn examples |
| 10 | Questionnaire Strategy | one question max after answer, no questionnaire after callback flow, no email/URL by voice, prefer contact form |
| 11 | Eval Scenarios | company general, Smart Website explanation/price, Voice Agent explanation/price, AiseoQ explanation/price, callback request after product answer, contact form handoff, closing |

## 2. JSON playbook sections already represented (before Phase 9)

Already present in `technolohit.main_voice_sales.v1.json` (Phase 10AM draft, `technolohit-playbook-v1-20260609`):

- `schema_version`, `tenant_id`, `agent_id`, explicit `playbook_version`, `status`, `runtime_binding`, `approval`, `changelog`
- `role` (boundaries, not a general chatbot), `tone`, `allowed_topics`, `disallowed_topics`
- `products` with ids/aliases/short_explanation/pricing_answer for `smart_website`, `voice_agent`, `lokalki`, `aiseoq`, `botinteg`
- `product_answer_rules` (answer-first, combined inquiry, TTS limit, RAG fallback)
- `pricing_policy` (no invented fixed prices, scope-dependent)
- `questionnaire_policy` (Phase 10AQ: answer-before-intake, per-product questions, never_when)
- `lead_capture_policy`, `callback_policy` (valid phone + permission, no live transfer)
- `escalation_policy` (out-of-scope redirect, technical escalation), `closing_policy` (10AK contract), `fallback_policy`, `notification_policy`, `qa_criteria`
- 16 `eval_scenarios` (closing, interruption, out_of_scope, technical_escalation, pricing, product_question, fallback, callback, questionnaire)

## 3. Missing JSON fields (closed in Phase 9)

| Markdown content | Previously in JSON? | Phase 9 action |
|---|---|---|
| Company positioning (short/long), diagnostic follow-up, company role | missing | added `company` section |
| Product priorities | missing | added `priority` per product (`high`/`medium_high`/`medium`/`low`) |
| 10s/25s/45s phone answers | missing | added `phone_answers.short_10s/medium_25s/detailed_45s` per product |
| Positioning / founder meaning / best-for / not-ideal-for / pains / customer phrases | missing | added per product (smart_website, voice_agent, aiseoq; lokalki: positioning + do_not) |
| Product follow-up questions | missing | added `follow_up_question` per product |
| Approved price phrases (SW scope-based, VA ab ca. 65 €/Monat, AiseoQ ab ca. 40 €/Seite/Monat) | missing (only generic `pricing_answer`) | added `price_policy.approved_phrase` + `no_fixed_price` + `entry_price_note` |
| Contact capture policy (caller ID available/missing, ask-once) | missing | added `contact_capture_policy.caller_id_policy` with both approved phrases, `max_phone_asks: 1` |
| No email / website URL / company-name capture by voice | missing | added boolean rules + redirect phrases in `contact_capture_policy` |
| Contact form handoff phrase + use cases | missing | added `contact_capture_policy.contact_form_handoff` |
| Per-product contact form guidance (SW, AiseoQ) | missing | added `contact_form_guidance` |
| Lead tiers (5 tiers + lead_ready requirements) | missing | added `lead_tiers` |
| Per-product lead-ready conditions | missing | added `lead_ready_when` |
| LokalKI low priority / answer-only-when-asked / do-not rules | missing | added `priority: "low"`, `answer_only_when_asked: true`, `do_not` |
| Voice Agent integrations note | missing | added `integrations_note` |
| Conversation priority contract + allowed callback response types | missing (runtime-only in Phase 10AU code) | added `conversation_priority_contract` |
| General answer pattern | partially | added `product_answer_rules.general_answer_pattern` |
| Markdown↔JSON source-of-truth link | missing | added `source_of_truth` |
| Eval scenarios: company general, VA/AiseoQ explanation+price, contact form handoff, no-email/no-URL capture | missing | added 8 scenarios + `eval_coverage` traceability map |

## 4. Unsafe or incomplete JSON fields (found and addressed)

- **No product priorities** — without priorities, a future runtime consumer could over-promote LokalKI. Fixed: priorities added; validator enforces LokalKI `low` + `answer_only_when_asked`.
- **Generic AiseoQ/Voice Agent pricing answers diverged from founder-approved phrases** — the old generic "individuell nach Bedarf" answers remain (current runtime fixture wording) but the founder-approved phrases are now explicit in `price_policy.approved_phrase`. Runtime continues to use agent_config until Phase 10; wording reconciliation is a Phase 10 review item.
- **No machine-readable voice-capture restrictions** — `lead_capture_policy.required_fields` lists `company_name`/`email`/`phone`, which could be misread as "capture by voice". Added `voice_capture_note` and the explicit `contact_capture_policy` restrictions; validator now rejects playbooks without them.
- **`botinteg` is not in the founder-approved Markdown** — flagged via `source_note` in the product entry; requires founder review before runtime binding (kept because Phase 10AM/10AO tests rely on its presence and removal would be a content decision, not consolidation).
- **Callback wording divergence** — Markdown callback finalization wording ("Ich nehme die Rückrufanfrage auf …") differs slightly from the Phase 10AU runtime texts in `callback-flow-policy.js` ("Ich habe die Anfrage aufgenommen …"). Both are safe; exact wording binding is Phase 10 work. Documented, not changed (no live behavior change allowed in Phase 9).
- **No validation of approval/runtime-binding shape** — validator previously only checked field presence. Now `runtime_binding.active` must be boolean, `approval.state` non-empty, `approval.approved_for_runtime` boolean, and draft playbooks still must not be runtime-active.

## 5. Runtime modules that already consume playbook data

All consumption is opt-in/default-off or test-only; with default env nothing reads the playbook at call time.

| Module | What it consumes | Gate |
|---|---|---|
| `src/v4/playbook-loader.js` | loads + validates the JSON | test-only by default |
| `src/v4/behavior-policy.js` | closing phrases/response, fallback clarification, out-of-scope redirect, technical escalation, callback lead-capture wording | `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=true` + published/approved/active (or explicit draft override) |
| `src/v4/playbook-questionnaire-generator.js` | `questionnaire_policy` (per-product questions, soft prefix, limits) | non-live generator; runtime path additionally behind `VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED` |
| `src/v4/playbook-eval-scenarios.js` | `eval_scenarios`, `escalation_policy`, `callback_policy`, and (new in Phase 9) `company`, product `phone_answers`/`follow_up_question`/`price_policy`, `contact_capture_policy` | non-live eval harness only |
| `src/v4/playbook-short-answer.js` | TTS char limit constant shared with eval | constant only |

## 6. Runtime modules that do not yet consume playbook data

These still use hardcoded/agent_config values; binding them is Phase 10 (Behavior Decision Layer):

- `src/v4/response-planner.js` — product answers, pricing answers, follow-up/qualification questions, priorities (uses `agent-config.js` + hardcoded texts)
- `src/v4/callback-flow-policy.js` — callback confirmation/manual-review/reassurance texts (hardcoded, Phase 10AU)
- `src/v4/transcript-intent.js` / `closed-domain-intent.js` — product aliases and intent hints (agent_config)
- `src/v4/lead-validator.js` / `lead-candidate.js` — lead tiers/lead-ready rules (deterministic code; playbook `lead_tiers` is advisory metadata only)
- `src/v4/questionnaire-runtime.js` — block conditions are code-driven; per-product questions come from generator defaults unless playbook runtime is opted in
- `src/v4/rag-orchestrator.js` — RAG gating is code-driven; playbook `conversation_priority_contract` is documentation
- `src/v4/dialogue-orchestrator.js`, `state-machine.js`, `post-call-summary.js` — no playbook input
- contact form handoff, caller-ID ask-once phrasing, company positioning answer — **no runtime consumer at all yet** (tracked as pending eval categories)

## 7. Validation strengthened (`playbook-loader.js`)

New exported constants: `REQUIRED_PLAYBOOK_PRODUCT_IDS` (`smart_website`, `voice_agent`, `aiseoq`, `lokalki`), `PRICING_POLICY_REQUIRED_PRODUCT_IDS` (`smart_website`, `voice_agent`, `aiseoq`), `REQUIRED_LEAD_TIERS` (5 tiers).

New validation errors (all specific):

- `playbook_version_empty`
- `runtime_binding_missing_active_flag`, `approval_missing_state`, `approval_missing_approved_for_runtime_flag`
- `missing_required_product:<id>`
- `product_missing_priority:<id>`, `product_invalid_priority:<id>:<value>`
- `product_missing_follow_up_question:<id>` (high-priority products)
- `product_missing_pricing_policy:<id>` (core sellable products)
- `contact_capture_missing_caller_id_policy`, `contact_capture_missing_contact_form_handoff`
- `contact_capture_missing_no_email_rule`, `contact_capture_missing_no_website_url_rule`, `contact_capture_missing_no_company_name_rule`
- `lead_tiers_missing:<tier>`
- `lokalki_must_be_low_priority`, `lokalki_must_be_answer_only_when_asked`
- `missing_field:contact_capture_policy`, `missing_field:lead_tiers` (new required top-level fields)

Existing checks kept: required top-level fields, status whitelist, draft-must-not-be-runtime-active, aliases/explanations, closing policy, eval scenario completeness. `product_missing_short_explanation` now also accepts `phone_answers` as a phone-safe explanation source.

## 8. Eval readiness (traceability only, no Phase 11)

New `eval_coverage` map in the playbook keys all 12 required Phase 9 categories to scenario ids:

| Required category | Scenario id(s) | Mode |
|---|---|---|
| company general question | `company_general_question` | pending (documentation check) |
| Smart Website explanation | `combined_product_inquiry_smart_website` | pass (live planner harness) |
| Smart Website price | `pricing_question_smart_website` | pass (live planner harness) |
| Voice Agent explanation | `voice_agent_explanation` | pending (documentation check) |
| Voice Agent price | `voice_agent_price` | pending (documentation check) |
| AiseoQ explanation | `aiseoq_explanation` | pending (documentation check) |
| AiseoQ price | `aiseoq_price` | pending (documentation check) |
| callback request after product answer | `callback_request` | pass (live planner harness) |
| contact form handoff | `contact_form_handoff_complex_details` | pending (documentation check) |
| no email capture by voice | `no_email_capture_by_voice` | pending (documentation check) |
| no website URL capture by voice | `no_website_url_capture_by_voice` | pending (documentation check) |
| closing | `closing_after_product_answer`, `closing_stop_with_thanks` | pass (orchestrator harness) |

`RUNTIME_PENDING_EVAL_CATEGORIES` now contains `company_general`, `product_explanation`, `product_pricing`, `contact_form_handoff`, `voice_capture_restriction`. Pending scenarios run documentation checks against the consolidated playbook (content exists, restrictions are `true`, approved phrases non-empty) and report `pending` — they move to `pass` only when Phase 10/11 wires real runtime consumers. No fake passes. Snapshot remains privacy-safe and keyed by `playbook_version`.

## 9. Files changed in Phase 9

- `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json` — consolidated content (see section 3); version bumped to `technolohit-playbook-v1-20260611`; changelog entry added; still draft/runtime-inactive
- `voice-bridge/src/v4/playbook-loader.js` — strengthened validation (section 7)
- `voice-bridge/src/v4/playbook-eval-scenarios.js` — pending categories + documentation checks (section 8); non-live eval harness only
- `voice-bridge/tests/v4-phase9-product-playbook-consolidation.test.js` — new focused Phase 9 test file (15 tests)
- `voice-bridge/tests/v4-phase10ao-playbook-eval-scenarios.test.js` — fixture alignment only: blanket `pending === 0` replaced by "pending only allowed for documented Phase 9 pending categories"; role-boundary scenarios still must pass live
- `docs/Tasks/phase9_product_playbook_consolidation_report.md` — this report
- `docs/Tasks/voice_assistant_v3_semantic_sales_agent_blueprint.md` — Phase 9 checklist updated

Not changed: production env files, Dockerfiles, deploy workflows, `rag-api/`, live canary scripts, `turn-assistant.js`, `docs/Tasks/logs.txt`, any planner/orchestrator/callback/RAG runtime module.

## 10. Exact remaining work for Phase 10 (Behavior Decision Layer)

1. Implement the Agent Behavior Decision object (`priority`, `response_type`, `product_id`, `playbook_version`, `rag_allowed`, `questionnaire_allowed`, `lead_tier`, `next_action`, `reason`, `suppressed_intents`) behind a disabled flag, fail-closed to current behavior.
2. Bind planner/RAG/questionnaire/callback flow to the same decision metadata; enforce the priority contract centrally instead of ad hoc planner branches.
3. Wire playbook product data (priorities, phone answers, follow-up questions, approved price phrases) into the planner path behind the flag; reconcile generic `pricing_answer` wording vs. founder-approved `price_policy.approved_phrase` (incl. 65 €/Monat and 40 €/Seite/Monat orientation prices) with founder review.
4. Add runtime consumers for the pending eval categories: company general answer, per-product explanation/pricing from playbook, contact form handoff response, no-email/no-URL voice-capture redirects, caller-ID ask-once phone question (`request_phone_once`).
5. Reconcile callback finalization wording between Markdown and `callback-flow-policy.js`; bind via playbook after review.
6. Decide botinteg's founder-approved status (add to Markdown or remove from JSON).
7. Move the Phase 9 pending eval scenarios from `pending` to `pass` only when actual runtime behavior matches; surface `playbook_version` in decision quality events.
8. Keep defaults off: `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=false`, `VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED=false`, production v3/RAG-off.

## 11. Verification

Commands run (results recorded in the final task report):

- `cd voice-bridge && npm test`
- `python -m pytest rag-api/tests`
- `node --check` on changed JS files
- `git diff --check`
- `./voice-bridge/scripts/run-ci-dialogue-scenarios.ps1`

Confirmation:

- No live behavior change: playbook stays draft + runtime-inactive; behavior policy default path untouched; no planner/orchestrator/runtime module logic changed (eval harness is non-live).
- `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED` and `VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED` remain default off.
- No Docker/env/rag-api/deploy/live-canary changes; `docs/Tasks/logs.txt` untouched.
