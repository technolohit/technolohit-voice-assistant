# Phase 10AK — Closing / Stop Intent Focused Fix Report

Date: 2026-06-09
Release: `voice-bridge-v1.34.12`
Production status: **v3 / RAG-off unchanged**. No production env, deployment, or Dockerfile changes.
Final status: **PASS / accepted** after supervised live closing canary.

## Goal

Implement Conversation Priority Contract #1 for the v4 live canary path: closing / stop intent
must have the highest priority after STT/final transcript and override RAG, fallback
clarification, product continuation, lead capture, and interrupt follow-up continuation.

## Root cause analysis (code paths confirmed)

Three independent gaps caused closing phrases to compete with other flows on the v1.34.11
Gate 3 canary:

1. **Intent detection gap** (`src/v4/transcript-intent.js`): the goodbye regex only matched
   strong phrases ("Tschüss", "Auf Wiederhören", "Das war's", ...). Soft closing phrases such
   as "Danke, das reicht erstmal.", "Passt so, danke.", "Danke, passt.", and
   "Ich habe keine weiteren Fragen." fell through to `unclear`/product paths, producing
   fallback clarification or a repeated product answer.
2. **RAG gate gap** (`src/v4/rag-orchestrator.js` `shouldUseRagForTurn`): when the state was
   `answering_product_question` (the state right after a product answer), RAG was allowed
   unconditionally (`reason=answering_product_question`). A closing phrase spoken after a
   product answer therefore still triggered live RAG retrieval.
3. **Planner order + state machine gap** (`src/v4/response-planner.js`,
   `src/v4/state-machine.js`): the closing branch was evaluated after the scoped product QA
   branch, and the state machine had no `answering_product_question -> completed`,
   `thinking -> completed`, or `waiting_for_interruption_followup -> completed` transitions, so
   a closing plan from those states transitioned to `error`.

## Behavior implemented

1. New helper module `voice-bridge/src/v4/closing-intent.js`:
   - `CLOSING_RESPONSE_TEXT` = "Sehr gerne. Dann wünsche ich Ihnen noch einen schönen Tag. Auf Wiederhören."
   - `isClosingIntent(transcript)` matches all required phrases:
     - strong goodbyes (pre-10AK set preserved): "Tschüss.", "Auf Wiederhören.", "Das war's.", ...
     - "Ich habe keine weiteren Fragen." (and "keine Fragen mehr" variants)
     - "Danke, das reicht erstmal." (guarded against "das reicht nicht")
     - "Passt so, danke." / "Danke, passt."
     - "Stopp"/"Stop" combined with danke/goodbye ("Stopp, danke, tschüss.")
   - Guards: announced follow-up questions ("kurze Frage", "noch eine Frage") and question
     words ("was", "wie", "kostet", "Preis", ...) prevent soft phrases from closing, so
     "Danke, und was kostet das?" stays a product/pricing turn.
   - `isBareStopWord(transcript)`: bare "Stopp" is never closing.
2. `transcript-intent.js`: `detectTranscriptIntent` resolves `closing` via `isClosingIntent`
   as the first check (highest priority, before interruption follow-up, product selection,
   sales qualification, and contact intents). `getWarmGoodbyeResponseText()` now returns the
   contract closing text.
3. `rag-orchestrator.js`: `shouldUseRagForTurn` returns
   `{ allowed: false, reason: "closing_intent" }` for closing turns in every state, including
   `answering_product_question`. No RAG retrieval, no `rag_retrieval_started` event, no
   retriever call on closing turns.
4. `response-planner.js`: the closing branch moved above scoped product QA / RAG / interrupt
   follow-up / lead capture. The closing plan now carries:
   - `response_type=closing`, `plan_reason=closing_intent`
   - `text=CLOSING_RESPONSE_TEXT`, `next_state=completed`
   - `rag_allowed=false`, `lead_transition_allowed=false`, `allowed_tools=[]`
   - memory patch: `call_closing=true`, `interruption_context=null`
5. `state-machine.js`: added `completed` to the allowed transitions of
   `thinking`, `answering_product_question`, and `waiting_for_interruption_followup`
   (closing may complete the call from any turn; all other transitions unchanged).
6. **Codex review fix** (`src/v4/live-dialogue-endpoint.js`,
   `src/v4/live-tts-playback-endpoint.js`): the live path now keeps closing turns in
   `completed` through dialogue commit and goodbye playback. This prevents the previous
   live-only state regression where `commitAssistantPlanWithoutPlayback()` reached
   `completed`, then `completeTurn()` or playback completion could move the runtime back to
   `listening`/`error`.

### Context-sensitive "Stopp"

- During assistant playback: unchanged. Barge-in detection, playback cancellation,
  `handleInterruption`, and interruption recovery (`recovery_action=interruption_followup`,
  wait-for-follow-up) behave exactly as before; bare "Stopp" still resolves to
  `interruption_recovery`, never `closing`.
- After an answer or combined with thanks/goodbye ("Stopp, danke, tschüss.",
  "Stopp, danke."): treated as closing.

### Quality events

- `response_plan_created` for a closing turn includes `response_type=closing` and
  `plan_reason=closing_intent` (existing `planContextQualityPayload` path; no new fields).
- No raw transcript, phone, email, or secret in any quality payload (asserted in tests).

## Files inspected

- `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` (Role Boundary,
  Conversation Priority Contract, Phase 10AK checklist)
- `voice-bridge/src/v4/transcript-intent.js`
- `voice-bridge/src/v4/response-planner.js`
- `voice-bridge/src/v4/rag-orchestrator.js`
- `voice-bridge/src/v4/state-machine.js`
- `voice-bridge/src/v4/dialogue-orchestrator.js`
- `voice-bridge/src/v4/interruption-context.js`
- `voice-bridge/src/v4/product-context-persistence.js`
- `voice-bridge/tests/v4-phase10m-summary-latency-closing.test.js`
- `voice-bridge/tests/v4-phase10n-interruption-semantic-recovery.test.js`
- `voice-bridge/tests/v4-phase10p-turn-taking.test.js`
- `voice-bridge/tests/v4-phase10ah-live-rag-path-equivalence.test.js`

## Files changed

| File | Change |
|---|---|
| `voice-bridge/src/v4/closing-intent.js` | **New** — closing phrase detection + canonical closing response text |
| `voice-bridge/src/v4/transcript-intent.js` | Closing intent resolved via `isClosingIntent` (highest priority); warm goodbye text now the contract text |
| `voice-bridge/src/v4/response-planner.js` | Closing branch moved before scoped product QA/RAG/interrupt/lead paths; `plan_reason=closing_intent` |
| `voice-bridge/src/v4/rag-orchestrator.js` | `shouldUseRagForTurn` refuses closing turns (`reason=closing_intent`) in every state |
| `voice-bridge/src/v4/state-machine.js` | `completed` allowed from `thinking`, `answering_product_question`, `waiting_for_interruption_followup` |
| `voice-bridge/src/v4/live-dialogue-endpoint.js` | Codex review fix — skip normal `completeTurn()` for closing plans so live closing does not enter `error` |
| `voice-bridge/src/v4/live-tts-playback-endpoint.js` | Codex review fix — goodbye playback keeps closing state `completed` instead of restoring normal listening |
| `voice-bridge/tests/v4-phase10ak-closing-stop-intent.test.js` | **New** — 10 focused Phase 10AK tests |
| `voice-bridge/tests/v4-phase10m-summary-latency-closing.test.js` | One assertion updated to new closing text (`/Sehr gerne/`) |
| `docs/Tasks/voice_assistant_v4_phase10ak_closing_stop_intent_fix_report.md` | **New** — this report |
| `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` | Status/checklist updates only |

Not changed: production env files, deployment files, Dockerfiles, `turn-assistant.js`
(v3 keeps its own `POST_CAPTURE_WARM_GOODBYE_TEXT`), `rag-api`, `docs/Tasks/logs.txt`.

## Tests added (`tests/v4-phase10ak-closing-stop-intent.test.js`)

1. All eight required closing phrases detect as closing intent.
2. Closing response text matches the contract exactly.
3. "Danke, das reicht erstmal." after a product answer (state `answering_product_question`,
   RAG env on): RAG retriever not called, `ragGate.reason=closing_intent`, plan is
   `closing`/`closing_intent` with the contract text, commit reaches `completed` without a
   state-machine error, `response_plan_created` carries safe metadata, and no raw
   transcript/phone/email appears in any quality payload.
4. "Passt so, danke." yields closing only — no `collect_sales_context`, no
   `fallback_clarification`, no allowed tools.
5. "Stopp, danke, tschüss." resolves to closing and completes the call.
6. Bare "Stopp" during playback keeps barge-in/interruption-wait behavior
   (`handleInterruption` → `recovery_action=interruption_followup`, plan is not closing,
   call not completed).
7. Closing overrides interrupt follow-up continuation
   (`waiting_for_interruption_followup` + `interruptionRecovery` still plans closing and
   clears `interruption_context`).
8. RAG gate refuses every required closing phrase even in `answering_product_question`.
9. Live dialogue + TTS/playback for "Danke, das reicht erstmal." keeps the v4 runtime in
   `completed` with no state-machine error after goodbye playback.
10. Follow-up/question phrases ("Stopp, ich habe noch eine kurze Frage.",
   "Danke, und was kostet das?", "Wie funktioniert Smart Website?", bare "Stopp") are not
   treated as closing.

## Verification results

| Check | Result |
|---|---|
| `cd voice-bridge && npm test` | **PASS** — 492/492 tests (10 new 10AK tests included) |
| `python -m pytest rag-api/tests` (repo root) | **PASS** — 7/7 |
| `node --check` on all changed JS | **PASS** |
| `git diff --check` | **PASS** (CRLF conversion warnings only, no whitespace errors) |
| `voice-bridge/scripts/run-ci-dialogue-scenarios.ps1` | **PASS** — all 26 v3 dialogue QA scenarios |

## Confirmations

- v3 default behavior unchanged: no v3 modules touched; all 26 v3 CI dialogue scenarios pass;
  v3 goodbye text (`POST_CAPTURE_WARM_GOODBYE_TEXT` in `turn-assistant.js`) untouched.
- Production v4 and RAG defaults remain **off** (`VOICE_RUNTIME_VERSION=v3`,
  `VOICE_RAG_ENABLED` default false); no env/deployment/Dockerfile changes.
- `docs/Tasks/logs.txt` untouched.
- No Phase 10AM/10AN playbook runtime refactor started; `turn-assistant.js` not expanded.

## Gate status

- Gate 2: PASS (unchanged).
- Gate 3 RAG/content: PASS on v1.34.11 (unchanged).
- Phase 10AK closing fix: **PASS** on `voice-bridge-v1.34.12`.

## Supervised live canary result

Date: 2026-06-09

Release tested:

- `voice-bridge`: `thnhit/technhvoice:voice-bridge-v1.34.12`
- `rag-api`: unchanged (`thnhit/technhvoice:rag-api-gate5-semantic-lokalki-hotfix-v5-20260522-1212`)

Preflight:

- Baseline v3/RAG-off confirmed first.
- Asterisk active calls: 0.
- Gate 3 v4/RAG-on window enabled only for the supervised canary.
- compose/runtime preflight: PASS.
- `rag:canary-preflight`: PASS.
- `rag:retrieve-preflight`: PASS.
- `rag:live-path-preflight`: PASS.
- `used_rag=true`, `product_scope=smart_website`, `fallback_reason=none`, `failure_count=0`.

Call evidence:

- `gate3_marker_utc=2026-06-09 21:38:13+0000`
- Asterisk processed count: `198 -> 199` (`delta=1`)
- `new_session_count=1`
- `call_session_id=b18cd9c4-c427-4ffa-92f4-967f9b9aa713`
- `status=completed`
- `duration_seconds=55`

Human QA:

1. Caller asked: "Was ist Smart Website, was macht sie und was kostet sie?"
2. Assistant answered the Smart Website combined inquiry correctly with live RAG.
3. Caller said: "Danke, das reicht erstmal."
4. Assistant answered exactly the expected closing:

```text
Sehr gerne. Dann wünsche ich Ihnen noch einen schönen Tag. Auf Wiederhören.
```

Response plan evidence:

- First response:
  - `response_type=product_question_answer`
  - `plan_reason=combined_product_inquiry`
  - `current_product_context=smart_website`
  - `matched_product=smart_website`
  - `rag_enabled=true`
  - `rag_used=true`
  - `rag_fallback_used=false`
  - `response_chars=251`
- Closing response:
  - `response_type=closing`
  - `plan_reason=closing_intent`
  - `assistant_response_preview=Sehr gerne. Dann wünsche ich Ihnen noch einen schönen Tag. Auf Wiederhören.`

Blocking checks:

- No `fallback_clarification` after closing: PASS.
- No `collect_sales_context` after closing: PASS.
- No `product_question_answer` after closing: PASS.
- No `lead_ready` after closing: PASS.
- No RAG retrieval after closing: PASS.

RAG evidence:

- `rag_retrieval_started=1`
- `rag_retrieval_completed=1`
- `rag_product_scope=smart_website`
- `rag_result_count=1`
- `rag_latency_ms=215`
- `rag_used=true`
- `rag_attempt_count=1`
- `rag_timeout_count=0`
- `rag_success_count=1`

Post-call and privacy:

- `summary_count=1`
- `post_call_summary_created=1`
- `post_call_lead_processed=guard_not_met`
- `post_call_notification_processed=ok`
- `email_like_payload_rows=0`
- `phone_like_payload_rows=0`

Rollback:

- Runtime restored to `VOICE_RUNTIME_VERSION=v3`.
- RAG restored to disabled (`VOICE_RAG_ENABLED=false`, `VOICE_RAG_SALES_ANSWERER_ENABLED=false`).
- v4 live/canary/barge-in flags disabled.
- STT/TTS providers restored to `mock`.
- Asterisk active calls: 0.

### Optional follow-up

The call produced two closing `response_plan_created` rows (`turn_index=2` and `turn_index=3`).
This is **not** a Phase 10AK blocker because both rows contained the correct closing response,
no bad response plan occurred after the latest closing row, no RAG retrieval occurred after
closing, and human QA passed.

Track as a low-priority QA/observability improvement: dedupe duplicate closing plan rows if
that makes live evidence cleaner.

## Commit/tag status

Committed, tagged, pushed, and Docker-published as `voice-bridge-v1.34.12`.
