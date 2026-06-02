# v4 Phase 10P — Turn-Taking and Interruption Listen Window

Date: 2026-06-02  
Scope: **Code + tests + docs** — no deploy, no production env edits.

References: [Phase 10N report](./voice_assistant_v4_phase10n_interruption_semantic_recovery_report.md), [Phase 10O plan](./voice_assistant_v4_phase10o_controlled_repeatability_and_rag_canary_plan.md).

---

## Context

- **Phase 10N / v1.25.0:** Single supervised canary **PASS**.
- **Phase 10O-A:** Repeatability **failed** (Call 1 + retry) — conversational turn-taking, not transport.
- **Phase 10O-B (RAG-on):** **Blocked** until 10P re-validation.

**Production v4:** still **not globally enabled**.

---

## Problems addressed

| Symptom | Fix |
|---------|-----|
| “Gerne…” right after “Stopp” before user finished | `waiting_for_interruption_followup` + marker-only **defer** (no dialogue/TTS until continuation or timeout) |
| “Stopp” treated as full turn | `isInterruptMarkerOnly()` — marker phrases are not substantive |
| Unstable product context | Closed-domain fuzzy routing + preserve `interrupted_product_id` |
| Generic “nicht verstanden” | `closed-domain-intent.js` low-confidence clarifications |
| Post-interrupt delay opaque | `interrupt_followup_latency_metrics` quality events |

---

## Implementation summary

### Interrupt listen window

- State: `waiting_for_interruption_followup` (`V4_STATES.WAITING_FOR_INTERRUPTION_FOLLOWUP`)
- Env defaults:
  - `VOICE_V4_INTERRUPT_FOLLOWUP_WAIT_MS=2200`
  - `VOICE_V4_INTERRUPT_FOLLOWUP_MAX_MS=3000`
  - `VOICE_V4_INTERRUPT_MARKER_ONLY_MIN_CHARS=12`
- On barge-in: cancel playback, enter wait (no immediate answer on marker-only STT)
- Aggregate: `Stopp` + `Was kostet das?` → effective transcript `Was kostet das?`
- Timeout: short clarification via `interruptFollowupTimeout` plan (not spoken on marker STT)

### Closed-domain intent

Module: `voice-bridge/src/v4/closed-domain-intent.js`  
Quality fields (no raw transcript): `intent_confidence`, `product_confidence`, `matched_product`, `previous_product_context`, `current_product_context`, `interrupt_marker_detected`, `waiting_for_interruption_followup`, `effective_transcript_chars`.

### Latency metrics

Event type: `interrupt_followup_latency_metrics`  
Fields: `barge_in_detected_to_playback_cancelled_ms`, `barge_in_detected_to_followup_speech_start_ms`, `followup_endpoint_to_stt_completed_ms`, `followup_stt_completed_to_plan_ms`, `followup_plan_to_first_playback_ms`.

---

## Key files

| File | Role |
|------|------|
| `interrupt-followup-wait.js` | Marker detection, defer, aggregate, timeout |
| `interrupt-followup-latency.js` | Post-interrupt timing |
| `live-interrupt-followup-endpoint.js` | Timeout clarification path |
| `closed-domain-intent.js` | Fuzzy TechnoloHit domain routing |
| `live-barge-in-endpoint.js` | Begin wait on cancel |
| `live-stt-endpoint.js` | Defer dialogue on marker-only |
| `live-audiosocket-handler.js` | Timeout on inbound frames |
| `response-planner.js` | Timeout ack + low-confidence clarifications |
| `tests/v4-phase10p-turn-taking.test.js` | Regression tests |

---

## Tests

| Check | Result |
|-------|--------|
| `voice-bridge` npm test | **338/338** |

---

## Next steps

1. Ship image **`voice-bridge-v1.26.0`** (suggested) after review.
2. Re-run **Phase 10O-A** (3 supervised RAG-off calls).
3. Do **not** start **Phase 10O-B** until 10O-A passes on v1.26.0+.

---

## Sysadmin quick check (post-interrupt)

```sql
SELECT event_type, payload->>'waiting_for_interruption_followup', payload->>'intent_confidence'
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type IN ('turn_started', 'interrupt_followup_latency_metrics')
ORDER BY created_at;
```

**Pass:** No TTS plan immediately after marker-only barge-in in logs; `interrupt_followup_latency_metrics` present when follow-up completes.
