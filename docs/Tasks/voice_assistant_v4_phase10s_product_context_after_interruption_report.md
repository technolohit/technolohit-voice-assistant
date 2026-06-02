# v4 Phase 10S — Post-Interruption Product Context Persistence

Date: 2026-06-02  
Scope: **Code + tests + docs** — no deploy, no production env edits.

References: [Phase 10R report](./voice_assistant_v4_phase10r_repeated_interruption_stability_report.md), [10H runbook](./voice_assistant_v4_phase10h_live_qa_runbook.md), [10O plan](./voice_assistant_v4_phase10o_controlled_repeatability_and_rag_canary_plan.md).

---

## Context

- **Phase 10R / v1.28.0:** Supervised canary **PARTIAL / STRONG IMPROVEMENT** — single-stop and repeated interrupts improved; privacy scan clean with timing exclusions.
- **Remaining blocker:** After `current_product_context=smart_website`, generic follow-ups (`Was kostet das?`, `Wie funktioniert das?`) sometimes returned `fallback_clarification` or `collect_sales_context` instead of scoped product Q&A.

**Production v4:** still **not globally enabled**.  
**Phase 10O-B (RAG-on):** **blocked** until 10O-A passes on **v1.29.0+**.

---

## Root cause

1. **No early scoped Q&A route** — generic deictic questions with `selected_product_id` still hit `unclear` → `fallback_clarification`.
2. **Product switch ack** used `COLLECTING_SALES_CONTEXT` instead of persisting context for follow-up Q&A.
3. **`interrupted_product_id` restore** could override explicit `current_product_context` after switch.
4. **Missing interrupt correlation** — no stable `interrupt_sequence_id` across follow-up events and `response_plan_created`.

---

## Fixes (Phase 10S)

### Product context persistence (`product-context-persistence.js`)

- `current_product_context` / `previous_product_context` on product switch (`persistProductContextSwitch`, `setSelectedProduct`).
- `isGenericScopedProductQuestion()` — deictic pricing/capability/explanation phrases scoped to active product.
- `isScopedProductQaTurn()` — early route to `PRODUCT_QUESTION_ANSWER` (playbook), not sales intake.

### Response planner

- Early `planScopedProductAnswer()` before fallback/sales paths when context is known.
- Product switch ack → `LISTENING` + `productContextMemoryPatch` (not `collect_sales_context`).
- Fallback clarification suppressed when scoped product Q&A applies.

### Interrupt telemetry

- `interrupt_sequence_id` = `interrupt-{cycle}` on started / waiting / continuation / timeout / `turn_started` / `response_plan_created`.
- `parent_single_stop_detected=true` on `interrupt_followup_continuation_received` when marker cycle had single stop.
- `response_plan_created` payload: `current_product_context`, `previous_product_context`, `matched_product`, `plan_reason` (no transcript/phone).

---

## Key files

| File | Role |
|------|------|
| `product-context-persistence.js` | Context resolve, generic Q&A detection, sequence id |
| `response-planner.js` | Scoped product Q&A + switch memory patch |
| `closed-domain-intent.js` | Match product from `current_product_context` |
| `transcript-intent.js` | Generic scoped → `product_question` |
| `interrupt-followup-wait.js` | Sequence id + parent_single_stop on continuation |
| `interrupt-followup-cycle.js` | Preserve sequence through finalize |
| `dialogue-orchestrator.js` | turn_started + response_plan_created context |
| `quality-events.js` | Privacy exempt for sequence/context fields |
| `tests/v4-phase10s-product-context.test.js` | Regression tests |

---

## Tests

| Check | Result |
|-------|--------|
| `voice-bridge` npm test | **374/374** |
| `rag-api` pytest | **6/6** |
| Dialogue QA matrix | **25/25** |

---

## Next steps

1. Ship image **`voice-bridge-v1.29.0`** (suggested) after review.
2. Re-run **Phase 10O-A** (3 supervised RAG-off calls) — verify generic follow-ups stay on `smart_website` after interrupt switch.
3. Do **not** start **10O-B** until 10O-A passes.

---

## Sysadmin quick check

```sql
SELECT event_type,
       payload->>'interrupt_sequence_id',
       payload->>'current_product_context',
       payload->>'response_type',
       payload->>'plan_reason'
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type IN ('interrupt_followup_started', 'interrupt_followup_continuation_received', 'response_plan_created', 'turn_started')
ORDER BY created_at;
```

**Pass:** After switch to `smart_website`, `response_plan_created.response_type=product_question_answer` for `Was kostet das?` / `Wie funktioniert das?` with `current_product_context=smart_website`.
