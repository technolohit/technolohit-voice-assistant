# Phase 10B — Agent Behavior Decision Metadata Plumbing Report

Date: 2026-06-11
Scope: v3 blueprint Phase 10B only. **Observability/metadata plumbing. No response behavior change.**

Prerequisite: Phase 10A pushed to `origin/main` at `cddeba0`.

---

## What was implemented

### Config flag (default off)

```env
VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED=false
```

Added to `voice-bridge/src/config.js` as `config.v4.agentBehaviorDecisionEnabled`, plus `voice-bridge/.env.example`, root `.env.example` pointer, and `docs/voice-bridge-runtime-env.md`.

### Runtime adapter: `voice-bridge/src/v4/agent-behavior-decision-runtime.js`

- `isAgentBehaviorDecisionEnabled(config)` — gate check
- `buildAgentBehaviorDecisionMetadata(...)` — calls `resolveAgentBehaviorDecision()`, never throws
- `behaviorDecisionQualityPayload(...)` — flat fields for quality events; returns `{}` when disabled or v4 inactive
- `resetAgentBehaviorDecisionPlaybookCache()` — test helper

### Metadata attachment point

`dialogue-orchestrator.js` → `commitAssistantPlanWithoutPlayback()` → `response_plan_created` event payload.

When `VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED=true` **and** `v4PathActive=true`, attaches `behavior_decision_*` fields. The existing plan (`response_type`, `text`, `next_state`, RAG flags on plan) is unchanged.

`decideNextAction()` stores `orchestrator.lastResolvedIntent` for metadata only.

### Privacy-safe payload fields

| Field | Purpose |
|---|---|
| `behavior_decision_enabled` | `true` when metadata plumbing ran |
| `behavior_decision_ok` | resolver succeeded |
| `behavior_decision_failure_reason` | safe reason when resolver throws |
| `behavior_decision_priority` | decision layer priority |
| `behavior_decision_response_type` | advisory response type (not used by planner) |
| `behavior_decision_product_id` | product context |
| `behavior_decision_playbook_version` | traceability |
| `behavior_decision_playbook_valid` | schema validation result |
| `behavior_decision_rag_allowed` | advisory gate (metadata only in 10B) |
| `behavior_decision_questionnaire_allowed` | advisory gate (metadata only in 10B) |
| `behavior_decision_lead_tier` | advisory tier |
| `behavior_decision_next_action` | advisory next action |
| `behavior_decision_reason` | decision reason |
| `behavior_decision_suppressed_intents` | suppressed intent list |
| `behavior_decision_source` | `agent_behavior_decision` |

Never includes: raw transcript, phone, email, RAG query, lead details, assistant full text.

### Fail-closed in metadata

Invalid/missing playbook: `behavior_decision_playbook_valid=false`, `behavior_decision_rag_allowed=false`, `behavior_decision_questionnaire_allowed=false`. Resolver throws: `behavior_decision_ok=false`, `behavior_decision_failure_reason=resolver_error`.

---

## Tests

`voice-bridge/tests/v4-phase10b-agent-behavior-decision-metadata.test.js` (13 tests)

- default flag off
- flag off → no metadata fields
- flag on → metadata on `response_plan_created`
- plan unchanged with flag on vs off
- closing metadata
- callback-flow metadata gates
- invalid/missing playbook fail-closed
- valid playbook + product_question → `rag_allowed=true` in metadata
- resolver failure safe metadata
- privacy
- v4 inactive → no metadata
- v3 defaults unchanged

---

## What was NOT changed

- Planner response selection logic
- RAG orchestrator gating
- Questionnaire runtime attachment
- Callback flow policy/runtime
- Production env files, Docker, deploy, `rag-api`, live canary scripts, `turn-assistant.js`, `docs/Tasks/logs.txt`

---

## Remaining work (Phase 10 runtime behavior switching)

Wire decision metadata into actual planner/RAG/questionnaire/callback gates behind a separate rollout flag after review; surface decision fields in additional quality events; move pending eval scenarios to pass when runtime behavior matches.
