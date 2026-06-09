# Phase 10AQ — Playbook Questionnaire Generator / Lead Intake Design Report

Date: 2026-06-10
Production status: **v3 / RAG-off unchanged**. Playbook runtime remains **opt-in/default-off**. Draft playbook **not production-active**.

> Phase 10AQ introduces a deterministic, non-live questionnaire/lead-intake generator from
> playbook data. It does **not** wire the generator into production runtime or enable v4 globally.

## Goal

Collect useful project context only when appropriate — after a product/pricing answer or on
explicit callback/contact intent — without rigid sales scripting, premature lead capture, or
PII prompts unless the caller has requested contact.

## Generator module

Module: `voice-bridge/src/v4/playbook-questionnaire-generator.js`

| Export | Purpose |
|---|---|
| `generatePlaybookQuestionnaire({ productId, callerIntent, playbook, ... })` | Ordered phone-friendly questions |
| `evaluateQuestionnaireRules({ ... })` | Deterministic gate (allowed/blocked + reason) |
| `assertQuestionnaireExpectations(result, expected)` | Eval harness assertions |
| `formatQuestionnaireEvalSnapshot(result)` | Privacy-safe JSON (no question text / PII) |
| `HARDCODED_QUESTIONNAIRE_DEFAULTS` | Fallback when playbook has no `questionnaire_policy` |

### Deterministic rules

| Rule | Behavior |
|---|---|
| Answer first | No project-context question until product/pricing answer (`answer_before_intake`) |
| Closing (#1) | Blocks all questionnaire generation |
| Role boundary | Out-of-scope and technical escalation block intake |
| Callback | Contact preference question only; `lead_ready_allowed=false` (validator unchanged) |
| No PII prompts | Business context only unless explicit callback/contact intent |
| No exact price / live transfer | Forbidden wording patterns rejected in generator output |
| Phone-friendly | Questions capped at 120 chars (playbook-configurable) |

### Product-specific questions (playbook `questionnaire_policy`)

| Product | Question focus |
|---|---|
| Smart Website | New site vs relaunch, goals |
| Voice Agent / Digitale Rezeption | Call volume / use cases to handle |
| LokalKI | Internal documents vs local visibility |

Generic fallback when product data is missing.

## Playbook changes

Added optional `questionnaire_policy` and seven `questionnaire` eval scenarios to
`technolohit.main_voice_sales.v1.json`.

## Eval snapshot (default env)

```json
{
  "playbook_version": "technolohit-playbook-v1-20260609",
  "summary": { "total": 16, "pass": 16, "pending": 0, "fail": 0 }
}
```

Nine planner/orchestrator scenarios (Phase 10AO/AP) + seven questionnaire generator scenarios.

## Files changed

| File | Change |
|---|---|
| `voice-bridge/src/v4/playbook-questionnaire-generator.js` | **New** — generator + rules + eval helpers |
| `voice-bridge/src/v4/playbook-eval-scenarios.js` | Questionnaire category harness |
| `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json` | `questionnaire_policy` + eval scenarios |
| `voice-bridge/tests/v4-phase10aq-playbook-questionnaire-generator.test.js` | **New** — 16 tests |
| `voice-bridge/tests/v4-phase10am-structured-playbook.test.js` | Allow questionnaire scenarios without `caller` |
| `voice-bridge/tests/v4-phase10ao-playbook-eval-scenarios.test.js` | Minor pass-count comment |
| `docs/Tasks/voice_assistant_v4_phase10aq_playbook_questionnaire_generator_report.md` | **New** — this report |
| `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` | Phase 10AQ checklist/status |

Not changed: production env files, `dialogue-orchestrator.js` runtime wiring, `turn-assistant.js`,
`docs/Tasks/logs.txt`, Docker/deploy.

## Production behavior changed?

**No.** Generator is test/eval-only. Default env remains v3/RAG-off; playbook runtime flags default off.

## Verification results

| Check | Result |
|---|---|
| `cd voice-bridge && npm test` | **PASS** — 551/551 |
| `python -m pytest rag-api/tests` | **PASS** — 7/7 |
| `node --check` changed JS | **PASS** |
| `git diff --check` | **PASS** |
| `run-ci-dialogue-scenarios.ps1` | **PASS** — 26/26 |

## Confirmations

- Production v4 and RAG defaults remain **off**; playbook runtime flags default off.
- Lead validator not bypassed; questionnaire never marks `lead_ready` without validator approval.
- No PII/raw transcript in eval/quality payloads.
- `docs/Tasks/logs.txt` untouched.
- No Docker tag created.

## Recommendation for next phase

**Phase 10AR — Questionnaire runtime wiring** (when approved): connect generator output to
v4 response-planner after product answers, still guarded and opt-in.
