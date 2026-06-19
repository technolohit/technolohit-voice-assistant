# Phase 10F — Playbook-driven company and product content

Status: **implemented in repo, not committed** (awaiting Codex review)  
Prior: [Phase 10E contact form handoff report](./phase10e_contact_form_handoff_report.md)  
Flag: reuses `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=false` (no new content flag)

## Goal

Runtime consumers for playbook-eval categories `company_general`, `product_explanation`, and `product_pricing` using the validated Product Playbook, behind the existing playbook runtime flag.

## Files inspected

- `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json`
- `voice-bridge/src/v4/playbook-loader.js`, `behavior-policy.js`, `playbook-eval-scenarios.js`
- `voice-bridge/src/v4/response-planner.js`, `transcript-intent.js`, `dialogue-orchestrator.js`
- `voice-bridge/src/v4/agent-behavior-decision.js`, `rag-orchestrator.js`
- `voice-bridge/tests/v4-phase9-product-playbook-consolidation.test.js`, `v4-phase10ao-playbook-eval-scenarios.test.js`
- `docs/Tasks/voice_assistant_v3_semantic_sales_agent_blueprint.md`, `phase9_product_playbook_consolidation_report.md`

## Files changed

| File | Change |
|---|---|
| `voice-bridge/src/v4/playbook-product-content.js` | **New** — pure resolvers + runtime eligibility helpers |
| `voice-bridge/src/v4/company-general-intent.js` | **New** — narrow TechnoloHit company-general detection |
| `voice-bridge/src/v4/response-planner.js` | Company-general path; playbook product/pricing in `resolveRagAwareProductAnswer`; LokalKI filter |
| `voice-bridge/src/v4/transcript-intent.js` | `company_general` intent when playbook content runtime active |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Pass `playbookProductContentEnabled` into intent detection |
| `voice-bridge/src/v4/agent-behavior-decision.js` | `COMPANY_GENERAL` priority + decision metadata |
| `voice-bridge/src/v4/playbook-eval-scenarios.js` | Move categories to runtime pass; harness enables playbook for content eval |
| `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json` | Eval expectation alignment (`aiseoq_explanation`, `aiseoq_price`) |
| `voice-bridge/tests/v4-phase10f-playbook-product-content.test.js` | **New** — focused Phase 10F suite |
| `voice-bridge/tests/v4-phase9-product-playbook-consolidation.test.js` | Expect `pending === 0` |
| `docs/Tasks/voice_assistant_v3_semantic_sales_agent_blueprint.md` | Phase 10F checklist |
| `docs/Tasks/phase9_product_playbook_consolidation_report.md` | Gap status update |
| `docs/Tasks/phase10e_contact_form_handoff_report.md` | Pending categories cleared |
| `docs/voice-bridge-runtime-env.md` | Clarify playbook runtime scope includes company/product content |

Not changed: production `.env`, Docker/deploy, `rag-api/`, live-canary scripts, `turn-assistant.js`, `docs/Tasks/logs.txt`.

## Runtime binding behavior

Activation requires **all** of:

1. `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=true`
2. Active v4 path (or eval harness override for the category)
3. `resolveBehaviorPolicy()` returns `source: "playbook"` (eligible validated playbook; draft only with `VOICE_V4_PLAYBOOK_ALLOW_DRAFT=true`)
4. `loadPlaybookForProductContent()` succeeds (full validation + runtime eligibility)

When active:

| Path | Source fields | Planner outcome |
|---|---|---|
| Company general | `company.positioning_short` + `diagnostic_follow_up` | `response_type: company_general`, `plan_reason: company_ecosystem_answer` |
| Product explanation | `phone_answers.short_10s` / `medium_25s` | `product_question_answer`, `plan_reason: playbook_product_explanation` |
| Product pricing | `price_policy.approved_phrase` | `product_question_answer`, `plan_reason: product_pricing_fallback` |
| Combined inquiry | `combined_inquiry_answer` or composed explanation + pricing | `plan_reason: combined_product_inquiry` |
| LokalKI | Same resolvers, but `filterPlaybookProductMatch` blocks unless transcript explicitly mentions LokalKI (`answer_only_when_asked`, `priority: low`) |

Conversation priority unchanged: closing → role boundary → contact form (10E flag) → company general → callback → scoped product QA / RAG / questionnaire gates.

## Flag-off equivalence

With `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=false` (production default):

- `isPlaybookProductContentRuntimeEnabled()` is false
- `company_general` intent is not detected
- `loadPlaybookForProductContent()` returns null
- Planner uses existing hardcoded / `agent_config` playbook short answers
- Verified by `10F: flag off leaves planner output unchanged` and full suite (688/688)

## Playbook eval summary

Harness: `runPlaybookEvalSuite({ playbook })` with per-scenario `playbookRuntimeEnabled` + `playbookAllowDraft` for content categories.

| Metric | Result |
|---|---|
| pass | all scenarios |
| fail | 0 |
| pending | 0 |

Categories moved from pending to runtime pass: `company_general`, `product_explanation`, `product_pricing`.

## RAG interaction

- RAG eligibility, retrieval, retry, filtering, and quality events unchanged
- If `ragResult.used_rag && ragAnswer`, RAG text wins in `resolveRagAwareProductAnswer`
- Playbook content applies only when RAG did not produce a used answer
- Verified: `10F: RAG success is preserved over playbook fallback`

## Pricing safety

- Only `price_policy.approved_phrase` (or legacy `pricing_answer` in resolver) — never invented prices
- Smart Website: scope-dependent (`Umfang`), no fixed euro amount
- Voice Agent: orientation “ab etwa 65 Euro pro Monat” with dependency language (`Anrufvolumen`, `Funktionen`, `Integrationen`)
- AiseoQ: orientation “ab etwa 40 Euro pro Seite und Monat” with `Anzahl der Seiten` / `Website` dependency
- No pricing for unsupported products unless documented in playbook

## LokalKI verification

- `filterPlaybookProductMatch` returns null without explicit LokalKI mention
- Direct “Was ist LokalKI?” returns playbook explanation
- “Was ist Smart Website?” does not mention LokalKI
- Validator still enforces `priority: low` and `answer_only_when_asked: true`

## Agent Behavior Decision

- New `COMPANY_GENERAL` priority (after contact form, before explicit product question)
- `rag_allowed: false`, `questionnaire_allowed: false`, `lead_tier: information_request`
- No global behavior switching beyond this scope; `VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED` remains default off

## Test commands and results

```text
cd voice-bridge && npm test          → 688 pass / 0 fail
python -m pytest rag-api/tests       → 7 passed
node --check (changed JS)            → OK
git diff --check                     → OK
voice-bridge/scripts/run-ci-dialogue-scenarios.ps1 → exit 0
```

## Production defaults unchanged

- `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=false`
- All other v4 opt-in flags remain off
- Playbook JSON `status: draft`, `runtime_binding.active: false`
- No env/Docker/deploy/rag-api/live-canary/logs.txt changes

## Remaining Phase 10 work

- Phase 10 (remaining): central behavior switching behind `VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED` for planner/RAG/questionnaire/callback (blueprint “Runtime behavior switching”)
- Reconcile callback finalization wording via playbook
- `request_phone_once` / caller-ID playbook consumer (if not already covered elsewhere)
- Phase 11: publish playbook version after human review

## Conversation priority fix (Codex review)

Mixed company-general + callback turns violated the priority contract because `company_general` was detected before explicit callback handling.

**Intent order (`transcript-intent.js`):**

1. closing  
2. post-decision callback attention  
3. **explicit callback/contact request** (new flow) — before role boundary and company-general  
4. role boundary (out-of-scope / technical escalation)  
5. contact-form handoff (when flag on)  
6. **active callback flow + company phrase** → `callback_flow_attention` (no product-style override)  
7. **company-general only** when not in callback flow and no callback phrase in the same turn  
8. product / continuation paths unchanged  

**Planner (`response-planner.js`):** `company_general` plan moved after `callback_request` / `callback_flow_attention`; guarded with `!isCallbackFlowActive(memory)`.

**Callback patterns:** extended `isCallbackLeadCaptureRequest` for “können Sie mich … anrufen” and STT/ASCII modals (`koennen`, `koennten`, `konnen`, `konnten`) via `normalizeCallbackRequestText()`; bounded `kann mich jemand … anrufen` pattern.

**Eval:** new scenario `company_general_with_callback_request` with `not_company_general` assertion.

## Commit / deploy

**No commit, tag, publish, or deploy** per task instructions (awaiting Codex review).
