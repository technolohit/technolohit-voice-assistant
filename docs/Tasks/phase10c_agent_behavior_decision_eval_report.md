# Phase 10C — Agent Behavior Decision vs Planner Eval Harness Report

Date: 2026-06-11
Scope: v3 blueprint Phase 10C only. **Non-live eval harness. No runtime behavior change.**

Prerequisite: Phase 10B pushed to `origin/main` at `e28d0b5`.

---

## What was implemented

### New module: `voice-bridge/src/v4/agent-behavior-decision-eval.js`

Non-live harness that:

1. Resolves **expected** behavior via `resolveAgentBehaviorDecision()` (same inputs as Phase 10A/10B).
2. Runs **actual** v4 planner/orchestrator via `decideNextAction()` (same harness pattern as `playbook-eval-scenarios.js`).
3. Compares decision metadata vs planner output and returns privacy-safe per-scenario results.

Exports:

- `DECISION_EVAL_SCENARIOS` — 13 synthetic scenarios (10 implemented + 3 pending)
- `runDecisionEvalScenario()` / `runDecisionEvalSuite()`
- `compareDecisionToActual()` / `responseTypesAligned()`
- `formatDecisionEvalSnapshot()` — JSON without caller text
- `summarizeDecisionEvalMismatches()` — fail-only summary for Phase 10D

### Privacy-safe result shape

```json
{
  "scenario_id": "explicit_product_question",
  "playbook_version": "technolohit-playbook-v1-20260611",
  "decision_priority": "explicit_product_question",
  "decision_response_type": "product_question_answer",
  "actual_response_type": "product_question_answer",
  "decision_rag_allowed": true,
  "actual_rag_used": false,
  "decision_questionnaire_allowed": false,
  "actual_questionnaire_used": false,
  "status": "pass",
  "failures": []
}
```

Only `caller_chars` is retained from caller input — no raw transcript, phone, or email.

### Comparison rules

| Check | Rule |
|---|---|
| `response_type` | Strict match, with callback-flow family alignment and product-answer aliases |
| `rag_allowed` | Fail if decision disallows RAG but planner used RAG |
| `questionnaire_allowed` | Fail if decision disallows questionnaire but planner attached questionnaire |
| Pending scenarios | `status: "pending"` — no fake pass |

### Scenario coverage

| Scenario ID | Category | Status |
|---|---|---|
| `closing_after_product_answer` | closing | pass |
| `callback_request_after_product_answer` | callback | pass |
| `callback_permission_continuation` | callback | pass (callback family alignment) |
| `callback_attention_reassurance` | callback | pass |
| `out_of_scope_general_question` | out_of_scope | pass |
| `technical_escalation` | technical_escalation | pass |
| `explicit_product_question` | product_question | pass |
| `product_context_continuation` | product_continuation | pass |
| `questionnaire_eligible_after_product_answer` | questionnaire | **fail** (documented mismatch) |
| `fallback_unclear` | fallback | pass |
| `contact_form_handoff` | contact_form_handoff | pending |
| `no_email_capture_by_voice` | voice_capture_restriction | pending |
| `no_website_url_capture_by_voice` | voice_capture_restriction | pending |

---

## Eval result summary (local run, 2026-06-11)

| Metric | Count |
|---|---|
| Total | 13 |
| Pass | 9 |
| Fail | 1 |
| Pending | 3 |

Suite `ok: false` because one documented mismatch is expected until Phase 10D runtime switching.

---

## Mismatches found (for Phase 10D)

### 1. `questionnaire_eligible_after_product_answer`

- **Decision:** `explicit_product_question`, `questionnaire_allowed=false`
- **Actual:** `product_question_answer` with `questionnaire.used=true` (when `questionnaireRuntimeEnabled=true`)
- **Failures:** `questionnaire_used_when_decision_disallows`, `questionnaire_attached_same_turn_while_decision_blocks`
- **Phase 10D action:** Align decision layer questionnaire eligibility with questionnaire-runtime attachment rules, or gate questionnaire attachment on decision when runtime switching is enabled.

### Informational (not failures by design)

- **`callback_permission_continuation`:** Decision `collect_callback_permission` vs actual `callback_finalized` — passes via callback-flow response-type family alignment (permission already granted + phone on file).

---

## Tests

`voice-bridge/tests/v4-phase10c-agent-behavior-decision-eval.test.js` (8 tests)

- Privacy-safe snapshot (no transcript/phone/email)
- Pending scenarios explicit
- `compareDecisionToActual` mismatch reasons
- Callback-flow type alignment helper
- Full suite category coverage
- Implemented pass candidates
- Questionnaire mismatch recorded as fail
- Default config: `VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED=false`

---

## Boundaries confirmed

- No planner/RAG/questionnaire/callback runtime behavior changes
- `VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED` remains default `false`
- No production env, Docker, deploy, rag-api, live-canary, or `docs/Tasks/logs.txt` changes
- `turn-assistant.js` untouched
- No tag, no Docker publish, no deploy

---

## Files changed (Phase 10C)

| File | Change |
|---|---|
| `voice-bridge/src/v4/agent-behavior-decision-eval.js` | New eval harness |
| `voice-bridge/tests/v4-phase10c-agent-behavior-decision-eval.test.js` | New tests |
| `docs/Tasks/phase10c_agent_behavior_decision_eval_report.md` | This report |
| `docs/Tasks/voice_assistant_v3_semantic_sales_agent_blueprint.md` | Phase 10C checklist |
