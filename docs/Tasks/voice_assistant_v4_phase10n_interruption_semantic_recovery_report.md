# v4 Phase 10N — Interruption Semantic Recovery (post v1.24.0 canary)

Date: 2026-06-02  
Scope: **Code + tests + docs only** — no deploy, no production env edits, **production v4 not globally enabled**.

Reference: [Phase 10M report](./voice_assistant_v4_phase10m_live_summary_latency_closing_report.md), [Phase 10H runbook](./voice_assistant_v4_phase10h_live_qa_runbook.md).

---

## Live failure (v1.24.0 supervised canary)

Caller interrupted with **“Stopp, ich habe eine kurze Frage.”** during product playback. Assistant treated it as unclear/fallback (“nicht verstanden”) instead of a high-priority follow-up. Secondary issues: NULL latency fields despite TTS/playback; `barge_in_detected` skipped at quality flush (`validation_failed`).

---

## Root cause analysis

| Issue | Root cause | Fix |
|-------|------------|-----|
| Fallback after barge-in | `detectTopicOrProductSwitch` mapped bare **Stopp** to `topic_reset`; planner had no `interruption_followup` path → `FALLBACK_CLARIFICATION` | Follow-up phrase detection; `interruption_followup` recovery; `planInterruptionFollowUp` in `response-planner.js` |
| Lost product context | `topic_reset` / unclear intent dropped `selected_product_id` | Preserve `interrupted_product_id` on follow-up; playbook answers with product id |
| Topic switch | Already partially supported | **Stopp, ich meine …** + product alias → `product_switch` (unchanged, tests reinforced) |
| NULL latency metrics | Prior turn `currentTurnLatency` overwritten on next endpoint without finalize; `tts_first_chunk` not using synthesis offset | Stash partial metrics in `beginLiveTurnLatency`; explicit `tts_completed` / chunk timestamps |
| `barge_in_detected` flush skip | Phone validator scanned **numeric** JSON fields (`triggered_at` epoch ms matches `\d{8,}`) | Validate phone-like patterns on **strings only** |
| Weak goodbye | Soft “danke” used closing question | Definite goodbye phrases → warm **“Vielen Dank für Ihren Anruf. Auf Wiederhören.”** + `call_closing` |

---

## Files changed

| File | Change |
|------|--------|
| `voice-bridge/src/v4/transcript-intent.js` | Interruption follow-up / topic repair / expanded goodbye |
| `voice-bridge/src/v4/interruption-context.js` | `interruption_followup` recovery; preserve product; no bare-Stopp reset |
| `voice-bridge/src/v4/playbook-short-answer.js` | **New** — bounded playbook answers (RAG off) |
| `voice-bridge/src/v4/response-planner.js` | Interruption follow-up planner; playbook pricing; warm goodbye |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Pass `agentConfig` into intent detection |
| `voice-bridge/src/v4/quality-events.js` | String-only phone scan (fix barge-in timestamps) |
| `voice-bridge/src/v4/live-turn-latency.js` | Stash partial turns; `tts_completed_at`; playback fallback |
| `voice-bridge/src/v4/live-tts-playback-endpoint.js` | Accurate TTS chunk/completed marks |
| `voice-bridge/tests/v4-phase10n-interruption-semantic-recovery.test.js` | **New** regression tests |
| `voice-bridge/tests/v4-phase4-barge-in-runtime.test.js` | Expect `interruption_followup` for priced follow-up |
| `docs/Tasks/voice_assistant_v4_phase10h_live_qa_runbook.md` | Interruption + latency SQL notes |
| `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` | Phase 10N status |

---

## Default production behavior

**Unchanged.** v3 default; all v4 behavior behind existing canary flags only. `turn-assistant.js` not modified.

---

## Tests run

| Check | Result |
|-------|--------|
| `cd voice-bridge && npm test` | **326/326** pass |
| `python -m pytest rag-api/tests` | **6/6** pass |
| `node --check` (changed v4 JS) | OK |
| `git diff --check` | OK |
| Dialogue QA matrix | **25/25** pass |

---

## Sysadmin retry criteria (next image, e.g. v1.25.0)

After a **short supervised canary** with barge-in enabled:

### Conversation (required)

1. During product answer, say **“Stopp, ich habe eine kurze Frage.”**  
   **Pass:** Short acknowledgement (e.g. “Gerne. Zur digitalen Rezeption: Was möchten Sie genau wissen?”) — **not** “nicht verstanden”.
2. Ask **“Was kostet das?”** (same product).  
   **Pass:** Bounded pricing/playbook answer (no hallucination, no Rückruf wording).
3. Say **“Stopp, ich meine Smart Website.”**  
   **Pass:** Product switch acknowledged; answers refer to Smart Website.
4. Say **“Auf Wiederhören”** or **“Keine Frage mehr.”**  
   **Pass:** **“Vielen Dank für Ihren Anruf. Auf Wiederhören.”** — no new intake menu.

### SQL (required)

**Summary + latency (from 10M):**

```sql
SELECT
  payload->'turn_latency'->>'dialogue_plan_to_tts_started_ms',
  payload->'turn_latency'->>'endpoint_to_first_playback_ms'
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'live_call_quality_summary';
```

**Pass:** Summary row exists; on a successful STT→dialogue→TTS→playback turn, latency fields above are **not NULL**.

**Barge-in events:**

```sql
SELECT event_type, created_at
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'barge_in_detected';
```

**Pass:** ≥ 1 row if caller interrupted during playback (no `quality_flush_skip_event` for this type in logs).

### Logs (required)

- No `quality_flush_skip_event event_type=barge_in_detected`
- No full transcript / raw phone in quality payloads

---

## Production v4 status

**Still not globally enabled.** Phase 10N is canary stabilization only; ship next image after review and repeat short supervised QA.
