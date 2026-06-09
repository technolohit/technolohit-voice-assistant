# Phase 10AR — Opt-In v4 Questionnaire Runtime Wiring Report

Date: 2026-06-10
Commit: `TBD`
Production status: **v3 / RAG-off unchanged**. Questionnaire runtime remains **opt-in/default-off**. Draft playbook **not production-active**.

> Phase 10AR wires the Phase 10AQ questionnaire generator into the v4 planner/orchestrator
> only behind `VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED=false` (default). Production behavior
> is unchanged with default env.

## Goal

After a safe product/pricing answer on an active v4 path, optionally attach at most one
soft project-context follow-up — without bypassing lead-validator rules, without blind
append on every response, and without exceeding live TTS length limits.

## Flag

| Variable | Default | Purpose |
|---|---|---|
| `VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED` | `false` | Master switch for post-answer questionnaire follow-up in v4 planner/orchestrator |

Requires active v4 path (`orchestrator.v4PathActive`). Does **not** enable v4 globally.

## Runtime module

`voice-bridge/src/v4/questionnaire-runtime.js`

| Export | Purpose |
|---|---|
| `isQuestionnaireRuntimeEnabled(config)` | Flag check |
| `evaluateQuestionnaireRuntimeEligibility({...})` | Deterministic gate before generation |
| `applyQuestionnaireRuntimeToPlan(plan, options)` | Attach follow-up; flag off returns plan unchanged |
| `questionnaireQualityPayload(plan)` | Safe fields for `response_plan_created` |

When flag is **off**, `applyQuestionnaireRuntimeToPlan` returns the plan unchanged (no new fields).

When flag is **on** but blocked, plan gains `questionnaire` metadata with `block_reason` only.

When flag is **on** and eligible:
- `follow_up_question` on plan (evidence)
- `questionnaire.used=true`, `questionnaire.spoken_attached` when combined text fits limit
- Spoken `text` appended only if within `max_spoken_chars` / `COMBINED_LIVE_TTS_CHAR_LIMIT` (160)

## Block conditions

- Closing, out-of-scope, technical escalation intents
- Callback contact-preference flow (separate planner path)
- Not a product/pricing answer (`product_selection_intro`, low-confidence clarification, etc.)
- RAG unsafe fallback (`rag_unsafe_or_empty`, `rag_filter_rejected`)
- No product context
- Duplicate response vs `lastAssistantText`
- Combined answer + question exceeds TTS limit (question kept in `follow_up_question` only)

## Quality evidence (`response_plan_created`)

Safe payload fields (no raw question text unless preview-redacted):

- `questionnaire_enabled`
- `questionnaire_used`
- `questionnaire_mode`
- `questionnaire_question_count`
- `questionnaire_block_reason`
- `questionnaire_product_id`
- `questionnaire_follow_up_preview` (max 80 chars, redacted)
- `questionnaire_spoken_attached`

## Files changed

| File | Change |
|---|---|
| `voice-bridge/src/v4/questionnaire-runtime.js` | **New** — opt-in runtime wiring |
| `voice-bridge/src/v4/response-planner.js` | Wrap planner with `applyQuestionnaireRuntimeToPlan` |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Pass config/v4PathActive/lastAssistantText; quality fields |
| `voice-bridge/src/config.js` | `questionnaireRuntimeEnabled` config field |
| `voice-bridge/tests/v4-phase10ar-questionnaire-runtime-wiring.test.js` | **New** — 15 tests |
| `voice-bridge/.env.example` | Document flag (commented, default off) |
| `.env.example` | Pointer to voice-bridge template |
| `docs/voice-bridge-runtime-env.md` | Phase 10AR flag table |
| `docs/Tasks/voice_assistant_v4_phase10ar_questionnaire_runtime_wiring_report.md` | **New** — this report |
| `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` | Phase 10AR checklist/status |

Not changed: production env files, `turn-assistant.js`, `docs/Tasks/logs.txt`, Docker/deploy.

## Production behavior changed?

**No.** Default env leaves `VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED=false`; v4 remains not globally enabled; playbook runtime default off.

## Verification results

| Check | Result |
|---|---|
| `cd voice-bridge && npm test` | **PASS** — 566/566 |
| `python -m pytest rag-api/tests` | **PASS** — 7/7 |
| `node --check` changed JS | **PASS** |
| `git diff --check` | **PASS** |
| `run-ci-dialogue-scenarios.ps1` | **PASS** — 26/26 |
| Playbook eval suite | **PASS** — 16/16 |

## Confirmations

- Lead validator not bypassed; `lead_transition_allowed` stays false on questionnaire plans.
- No raw transcript/phone/email in quality/eval payloads.
- `docs/Tasks/logs.txt` untouched.
- No Docker tag created.

## Recommendation for next phase

Supervised v4 canary with questionnaire flag on for a single allowlisted call after review; keep production v3/RAG-off until explicitly approved.
