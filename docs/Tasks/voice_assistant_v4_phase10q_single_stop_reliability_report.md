# v4 Phase 10Q — Hard Single-Stop Barge-In Reliability

Date: 2026-06-02  
Scope: **Code + tests + docs** — no deploy, no production env edits.

References: [Phase 10P report](./voice_assistant_v4_phase10p_turn_taking_interruption_wait_report.md), [Phase 10O plan](./voice_assistant_v4_phase10o_controlled_repeatability_and_rag_canary_plan.md), [10H runbook](./voice_assistant_v4_phase10h_live_qa_runbook.md).

---

## Context

- **Phase 10P / v1.26.0:** Turn-taking listen window shipped; barge-in cancel + marker-only defer implemented.
- **Phase 10O-A supervised canary (v1.26.0):** Still **failed** repeatability — caller had to say Stop/Stopp **twice** before assistant reacted reliably.
- **Evidence call:** `call_session_id=80fdee7f-4086-479c-bbd8-db40c24912cd` — STT captured “Stopp.”, barge-in and `waiting_for_interruption_followup` existed in logs, but human experience was unreliable.

**Production v4:** still **not globally enabled**.  
**Phase 10O-B (RAG-on):** **blocked** until 10O-A passes on v1.27.0+.

---

## Root cause

1. **Utterance buffer wiped on barge-in cancel** — `executeLiveBargeInCancel` called `resetUtteranceBuffer`, discarding audio from the speech that triggered cancel; caller had to repeat the stop.
2. **STT reset before follow-up decision** — `runLiveSttOnEndpoint` reset the buffer before `processInterruptFollowupAfterStt`, so marker-only “Stopp” could not keep listening for continuation.
3. **No hard marker split** — combined utterances (“Stopp. Was kostet das?”) were not split into marker + continuation in one pass.

---

## Fixes (Phase 10Q)

### Hard stop detector + split

Module: `voice-bridge/src/v4/interrupt-marker-split.js`

- `splitInterruptMarkerAndContinuation(transcript)` → `{ marker, continuation, marker_only, single_stop_detected }`
- Recognizes: Stopp, Stop, Halt, Moment, Warte, bitte variants, “Stopp, stopp”, “Stop, ich habe eine Frage”, combined marker + question.

### Preserve interrupt utterance on barge-in

- `ensureInterruptUtteranceAfterBargeIn` — keep frames or start capture + append trigger frame (replaces post-cancel buffer reset).
- `resetUtteranceBuffer` — no-op while `waitingForInterruptionFollowup`.
- After marker-only STT defer → `beginUtteranceCapture` for continuation (no dialogue/TTS).

### Wait state + quality events

- Marker-only: `single_stop_detected=true`, `wait_window_started_ms`, defer dialogue/TTS.
- Combined marker + content: process continuation immediately (pricing, product switch).
- PII-safe quality events: `interrupt_followup_started`, `interrupt_followup_waiting`, `interrupt_followup_continuation_received`, `interrupt_followup_timeout`.

### Timing metrics

Extended `interrupt-followup-latency.js`:

- `stop_detected_ms`, `playback_cancelled_ms`, `wait_window_started_ms`, `continuation_speech_started_ms`, `continuation_endpoint_ms`
- Derived: `stop_to_cancel_ms`, `stop_to_wait_window_ms`, `wait_window_to_continuation_ms`

---

## Key files

| File | Role |
|------|------|
| `interrupt-marker-split.js` | Hard stop marker detection + split |
| `interrupt-followup-wait.js` | Single-stop wait, quality buffering, continuation |
| `live-barge-in-endpoint.js` | Preserve utterance after cancel |
| `live-stt-endpoint.js` | Defer reset; re-open capture after marker-only |
| `interrupt-followup-latency.js` | Stop/wait/continuation timing |
| `quality-events.js` | Follow-up event builders |
| `tests/v4-phase10q-single-stop.test.js` | Regression tests |

---

## Tests

| Check | Result |
|-------|--------|
| `voice-bridge` npm test | **352/352** |

---

## Next steps

1. Ship image **`voice-bridge-v1.27.0`** (suggested) after review.
2. Re-run **Phase 10O-A** (3 supervised RAG-off calls) — single “Stopp” must cancel playback and enter follow-up listen without repeat.
3. Do **not** start **Phase 10O-B** until 10O-A passes.

---

## Sysadmin quick check (single-stop)

```sql
SELECT event_type,
       payload->>'single_stop_detected',
       payload->>'marker_only',
       payload->>'wait_window_started_ms',
       payload->>'stop_to_cancel_ms'
FROM voice.call_quality_events
WHERE call_session_id = '80fdee7f-4086-479c-bbd8-db40c24912cd'::uuid
   OR call_session_id = '<NEW_CANARY_SESSION_ID>'::uuid
ORDER BY created_at;
```

**Pass:** One “Stopp” → `interrupt_followup_started` + `interrupt_followup_waiting` with `single_stop_detected=true`; no TTS until continuation or timeout; no second stop required.
