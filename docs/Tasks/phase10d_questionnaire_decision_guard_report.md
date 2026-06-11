# Phase 10D — Questionnaire Decision Guard Report

Date: 2026-06-11
Scope: v3 blueprint Phase 10D only. **Questionnaire attachment guard when decision flag is on.**

Prerequisite: Phase 10C pushed to `origin/main` at `8c2e898`.

---

## Problem (Phase 10C mismatch)

`questionnaire_eligible_after_product_answer`:

- **Decision:** `explicit_product_question`, `questionnaire_allowed=false`
- **Actual (before 10D):** `product_question_answer` with `questionnaire.used=true` when questionnaire runtime was enabled

---

## Fix summary

Added a narrow pre-attachment guard that runs only when **both**:

- `VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED=true`
- `VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED=true` (questionnaire runtime already evaluating attachment)
- v4 path active

### New module: `agent-behavior-decision-questionnaire-guard.js`

- `evaluateBehaviorDecisionQuestionnaireGuard()` calls `resolveAgentBehaviorDecision()` with `questionnaireEligible=false` (pre-attachment).
- If `questionnaire_allowed=false`, questionnaire runtime does not attach.
- Resolver failure or invalid playbook → fail closed (`behavior_decision_guard_failed` / `behavior_decision_questionnaire_disallowed`).
- No circular imports with `response-planner.js`.

### Wired in: `questionnaire-runtime.js`

- Guard runs at end of `evaluateQuestionnaireRuntimeEligibility()` after existing eligibility checks.
- New block reasons: `behavior_decision_questionnaire_disallowed`, `behavior_decision_guard_failed`.
- **Does not change** `response_type`, `next_state`, or base product answer text (only skips follow-up append).

### Default behavior unchanged

When `VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED=false` (production default), questionnaire runtime behavior is identical to Phase 10AR.

---

## Eval result after fix

| Metric | Count |
|---|---|
| Total | 13 |
| Pass | 10 |
| Fail | 0 |
| Pending | 3 |

`questionnaire_eligible_after_product_answer` passes with both flags enabled in the eval harness.

---

## Tests

| File | Tests |
|---|---|
| `voice-bridge/tests/v4-phase10d-questionnaire-decision-guard.test.js` | 8 new |
| `voice-bridge/tests/v4-phase10c-agent-behavior-decision-eval.test.js` | Updated (suite 10/0/3, questionnaire pass) |

Coverage:

1. Flag off → questionnaire still attaches
2. Both flags on → questionnaire blocked on explicit product answer
3. `response_type` / `next_state` / base answer text unchanged
4. Closing/callback still block questionnaire
5. Invalid playbook + decision flag → fail closed
6. Privacy-safe questionnaire metadata
7. Default production flags unchanged

---

## Boundaries confirmed

- Questionnaire guard only — no planner/RAG/callback/product response switching
- No response text change for product answers when decision flag off
- `VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED` remains default `false`
- No production env, Docker, deploy, rag-api, live-canary, or `logs.txt` changes
- `turn-assistant.js` untouched

---

## Files changed

| File | Change |
|---|---|
| `voice-bridge/src/v4/agent-behavior-decision-questionnaire-guard.js` | New guard module |
| `voice-bridge/src/v4/questionnaire-runtime.js` | Guard integration |
| `voice-bridge/src/v4/agent-behavior-decision-eval.js` | Harness enables decision flag for questionnaire scenario |
| `voice-bridge/tests/v4-phase10d-questionnaire-decision-guard.test.js` | New tests |
| `voice-bridge/tests/v4-phase10c-agent-behavior-decision-eval.test.js` | Updated expectations |
| `docs/Tasks/phase10d_questionnaire_decision_guard_report.md` | This report |
| `docs/Tasks/phase10c_agent_behavior_decision_eval_report.md` | Post-10D eval summary |
| `docs/Tasks/voice_assistant_v3_semantic_sales_agent_blueprint.md` | Phase 10D checklist |
