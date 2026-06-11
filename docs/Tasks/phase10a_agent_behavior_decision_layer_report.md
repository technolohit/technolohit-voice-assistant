# Phase 10A — Agent Behavior Decision Layer Skeleton Report

Date: 2026-06-11
Scope: v3 blueprint Phase 10A only. Pure decision logic + tests + docs. **No live runtime wiring.**

Prerequisite: Phase 9 pushed to `origin/main` at `611f4e78a32c5a01d4cbc2562a266e370a78b22a`.

---

## What was implemented

### New module: `voice-bridge/src/v4/agent-behavior-decision.js`

Pure deterministic resolver:

```javascript
resolveAgentBehaviorDecision({
  transcript,
  memory,
  state,
  playbook,
  config,
  intent,
  productContext,
  callbackFlowState,
  roleBoundaryIntent,
  closingIntent,
  productAnswered,
  pricingAnswered,
  questionnaireEligible,
})
```

Returns a frozen decision object:

```json
{
  "priority": "callback_flow",
  "response_type": "collect_callback_permission",
  "product_id": "smart_website",
  "playbook_version": "technolohit-playbook-v1-20260611",
  "playbook_valid": true,
  "rag_allowed": false,
  "questionnaire_allowed": false,
  "lead_tier": "callback_requested",
  "next_action": "continue_callback_flow",
  "reason": "active_callback_flow:callback_permission_pending",
  "suppressed_intents": ["rag", "questionnaire", "product_context_continuation"],
  "source": "agent_behavior_decision"
}
```

### Priority contract (enforced in order)

1. `closing` — RAG/questionnaire suppressed
2. `callback_flow` — active callback/contact continuation; RAG/questionnaire suppressed
   - Exception: explicit `product_question` / `product_selection` overrides callback when clearly explicit
3. `role_boundary` — `out_of_scope`, `technical_escalation`; before product Q&A
4. `explicit_product_question` — may allow RAG; questionnaire not yet
5. `product_context_continuation` — `scoped_product_qa`; may allow RAG
6. `product_qualification` — sales context collection
7. `questionnaire` — only when `questionnaireEligible` / `productAnswered` / memory flags; never during closing/callback/role-boundary
8. `fallback` — lowest priority unclear intent

### Helpers

- `formatAgentBehaviorDecisionSnapshot(decision)` — privacy-safe JSON (no transcript/phone/email)
- `isAgentBehaviorDecisionRuntimeEnabled()` — always `false` in Phase 10A

### Playbook handling

- Valid playbook → `playbook_version` + `playbook_valid: true`; RAG/questionnaire gates may be enabled per priority rules
- Missing/invalid playbook → fail closed (`playbook_valid: false`, reason suffix `playbook_missing` / `playbook_validation_failed`); priority classification still resolves, but **`rag_allowed` and `questionnaire_allowed` are always `false`** regardless of intent

---

## Tests

New file: `voice-bridge/tests/v4-phase10a-agent-behavior-decision.test.js` (16 tests)

Categories covered:

- closing priority
- callback flow priority + callback request start
- role boundary (out-of-scope + technical escalation)
- explicit product question (with callback override)
- product context continuation + RAG allowance
- questionnaire eligibility (allowed / blocked by callback/closing/role-boundary)
- fallback lowest priority
- playbook_version traceability
- missing/invalid playbook safe fallback
- privacy (no raw transcript/phone/email in output or snapshot)
- runtime flag disabled

---

## What was NOT changed

- `response-planner.js` — unchanged
- `rag-orchestrator.js` — unchanged
- `questionnaire-runtime.js` — unchanged
- `callback-flow-policy.js` — unchanged (imported read-only)
- Production env files, Docker, deploy workflows, `rag-api`, live canary scripts, `turn-assistant.js`, `docs/Tasks/logs.txt`
- No git tag, no Docker publish, no deploy

---

## Remaining work (Phase 10 runtime wiring)

1. Add opt-in flag (e.g. `VOICE_V4_BEHAVIOR_DECISION_ENABLED`, default false)
2. Wire planner, RAG gate, questionnaire runtime, and callback flow to consume the same decision metadata
3. Surface safe decision fields in quality events
4. Move pending Phase 9 eval scenarios to `pass` when runtime matches
5. Canary only after eval gate passes
