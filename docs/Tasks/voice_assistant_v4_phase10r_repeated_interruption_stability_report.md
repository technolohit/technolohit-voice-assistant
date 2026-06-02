# v4 Phase 10R — Repeated / Nested Interruption Stability

Date: 2026-06-02  
Scope: **Code + tests + docs** — no deploy, no production env edits.

References: [Phase 10Q report](./voice_assistant_v4_phase10q_single_stop_reliability_report.md), [10H runbook](./voice_assistant_v4_phase10h_live_qa_runbook.md), [10O plan](./voice_assistant_v4_phase10o_controlled_repeatability_and_rag_canary_plan.md).

---

## Context

- **Phase 10Q / v1.27.0:** Supervised canary **PARTIAL / IMPROVED** — first interrupt better, single “Stopp” improved, but **repeated/nested** interrupts degraded.
- **Symptoms:** Second/third “Stopp” during long explanations unreliable; stale `interruption_recovery` / `interruption_context`; `single_stop_detected=true` only on timeout/waiting path; product context drift after `voice_agent` → `smart_website` switch.
- **Transport:** STT/TTS/barge-in/flush OK — conversational state machine issue.

**Production v4:** still **not globally enabled**.  
**Phase 10O-B (RAG-on):** **blocked** until 10O-A passes on **v1.28.0+**.

---

## Root cause

1. **`single_stop_detected` not set on barge-in** — only flipped after marker-only STT, not on `interrupt_followup_started`.
2. **Stale follow-up cycle** — prior `interruptFollowup` / wait flags not reset before nested barge-in.
3. **Stale `memory.interruption_context`** — `Boolean(memory.interruption_context)` forced generic interruption recovery on later pricing turns.
4. **Product restore bug** — `resolveInterruptionRecovery` could re-apply `interrupted_product_id` over an explicit `selected_product_id` after switch.
5. **Privacy false positives** — epoch-ms timing fields in quality payloads matched broad digit regex.

---

## Fixes (Phase 10R)

### Interrupt cycle reset (`interrupt-followup-cycle.js`)

- `resetInterruptFollowupForNewBargeIn` — clean wait state before each barge-in.
- `finalizeInterruptFollowupAfterContinuation` — clear marker/wait after continuation STT.
- `clearStaleInterruptionRecovery` — clear runtime + memory `interruption_context` after interrupt dialogue.

### Single-stop reliability

- `singleStopDetected: true` on barge-in + `interrupt_followup_started`.
- `resolveSingleStopDetected()` for consistent marker-only detection.
- Marker-only STT still defers dialogue/TTS; continuation is high-priority.

### Response planning

- Removed `Boolean(memory?.interruption_context)` from global interruption-follow-up routing.
- **Interrupt-scoped** pricing/capability fast path when `interruptionRecovery` is active and product is known.
- Product switch memory no longer overwritten by stale `interrupted_product_id`.

### Privacy

- `TIMING_TELEMETRY_PAYLOAD_KEYS` exempt from phone scan in `validateQualityEventInput` (runtime still redacts raw phone/transcript fields).

---

## Key files

| File | Role |
|------|------|
| `interrupt-followup-cycle.js` | Cycle reset / stale recovery clear |
| `interrupt-followup-wait.js` | Barge-in reset, single_stop on started |
| `interrupt-marker-split.js` | `resolveSingleStopDetected` |
| `interruption-context.js` | Preserve selected product after switch |
| `response-planner.js` | Interrupt-scoped pricing; no stale context routing |
| `live-dialogue-endpoint.js` | Clear recovery after interrupt dialogue |
| `quality-events.js` | Timing telemetry exempt keys |
| `tests/v4-phase10r-repeated-interrupt.test.js` | Regression tests |

---

## Tests

| Check | Result |
|-------|--------|
| `voice-bridge` npm test | **363/363** |
| `rag-api` pytest | **6/6** |
| Dialogue QA matrix | **25/25** |

---

## Next steps

1. Ship image **`voice-bridge-v1.28.0`** (suggested) after review.
2. Re-run **Phase 10O-A** (3 supervised RAG-off calls) focusing on **repeated** Stop/Stopp during explanations.
3. Do **not** start **10O-B** until 10O-A passes.

---

## Sysadmin quick check (repeated interrupt)

```sql
SELECT event_type,
       payload->>'single_stop_detected',
       payload->>'interrupt_cycle',
       payload->>'marker_only'
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type LIKE 'interrupt_followup%'
ORDER BY created_at;
```

**Pass:** Each isolated “Stopp” → `interrupt_followup_started` with `single_stop_detected=true`; continuation or timeout follows; no second stop required; pricing after product switch stays on `smart_website`.
