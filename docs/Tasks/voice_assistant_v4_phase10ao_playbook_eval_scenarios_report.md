# Phase 10AO — Eval Scenarios From Playbook Report

Date: 2026-06-10
Commit: `4f358c1`
Production status: **v3 / RAG-off unchanged**. Playbook runtime remains **opt-in/default-off**. Draft playbook **not production-active**.

> Phase 10AO introduces a non-live eval scenario layer from the structured playbook.
> It does **not** make the draft playbook production-active.

## Goal

Regression-check future playbook edits before publish/runtime binding by loading
`eval_scenarios` from the tenant playbook and running implemented categories through
the existing v4 planner/orchestrator harness — no live STT/TTS/RAG/network calls.

## Eval runner

Module: `voice-bridge/src/v4/playbook-eval-scenarios.js`

| Export | Purpose |
|---|---|
| `loadPlaybookEvalScenarios(playbook)` | Extract valid scenarios from playbook JSON |
| `validatePlaybookEvalScenarios(playbook)` | Require all seven category groups + `expected` blocks |
| `runEvalScenario({ scenario, ... })` | Run one scenario (planner, orchestrator, or interruption handler) |
| `runPlaybookEvalSuite({ playbook, ... })` | Run all scenarios; return summary + per-scenario results |
| `formatEvalSuiteSnapshot(suiteResult)` | Privacy-safe JSON keyed by `playbook_version` (no caller text) |
| `loadDefaultPlaybookEvalSuite()` | Load the TechnoloHit draft playbook from `config/playbooks/` |

### Runtime support matrix

| Category | Harness | Status |
|---|---|---|
| `closing` | `decideNextAction` orchestrator (RAG retriever stubbed) | **pass** when expectations met |
| `interruption` | `handleInterruption` (bare "Stopp" barge-in wait) | **pass** |
| `pricing` | `buildResponsePlan` | **pass** |
| `product_question` | `buildResponsePlan` (combined inquiry) | **pass** |
| `fallback` | `buildResponsePlan` (generic unclear → fallback clarification) | **pass** |
| `out_of_scope` | documentation check vs `behavior-policy` + playbook | **pending** — runtime consumer not wired |
| `technical_escalation` | documentation check vs policy + playbook | **pending** — runtime consumer not wired |
| `callback` | documentation check vs `callback_policy` | **pending** — runtime consumer not wired |

Pending scenarios use status `pending` and reason
`documented_playbook_ready_runtime_consumer_pending`. They are **not** faked as pass.

Observed runtime gaps (why pending):

- **Out-of-scope** ("Wer hat die Relativitätstheorie entwickelt?") → low-confidence product
  clarification, not role-boundary redirect.
- **Technical escalation** (LokalKI + SAP middleware) → product selection intro, not team
  escalation wording.
- **Callback** ("Können Sie mich zurückrufen lassen?") → low-confidence clarification, not
  lead-capture flow.

### Default TechnoloHit playbook suite snapshot (hardcoded defaults)

With `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=false`:

```json
{
  "playbook_version": "technolohit-playbook-v1-20260609",
  "summary": { "total": 9, "pass": 6, "pending": 3, "fail": 0 }
}
```

Implemented passes: closing ×2, interruption, pricing, combined product inquiry, fallback.
Pending: out_of_scope, technical_escalation, callback.

## Playbook change

Added one eval scenario to `technolohit.main_voice_sales.v1.json`:

- `fallback_clarification_unclear` (`category=fallback`) — generic unclear utterance →
  fallback clarification via planner.

## Env documentation hygiene

Documented Phase 10AN playbook flags (defaults off/empty) in:

- `voice-bridge/.env.example` (commented defaults)
- `.env.example` (pointer to voice-bridge template)
- `docs/voice-bridge-runtime-env.md` (table + safety notes)

| Variable | Default |
|---|---|
| `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED` | `false` |
| `VOICE_V4_PLAYBOOK_PATH` | empty |
| `VOICE_V4_PLAYBOOK_ALLOW_DRAFT` | `false` |

## Files inspected

- `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json`
- `voice-bridge/src/v4/playbook-loader.js`
- `voice-bridge/src/v4/behavior-policy.js`
- `voice-bridge/src/v4/dialogue-orchestrator.js`
- `voice-bridge/src/v4/response-planner.js`
- `voice-bridge/src/v4/transcript-intent.js`
- `voice-bridge/tests/v4-phase10ak-closing-stop-intent.test.js`
- `voice-bridge/tests/v4-phase10an-playbook-runtime-increment1.test.js`

## Files changed

| File | Change |
|---|---|
| `voice-bridge/src/v4/playbook-eval-scenarios.js` | **New** — eval runner + privacy-safe snapshot |
| `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json` | Added `fallback_clarification_unclear` eval scenario |
| `voice-bridge/tests/v4-phase10ao-playbook-eval-scenarios.test.js` | **New** — 8 tests |
| `voice-bridge/tests/v4-phase10am-structured-playbook.test.js` | Require `fallback` eval category |
| `voice-bridge/.env.example` | Document playbook runtime flags (commented, default off) |
| `.env.example` | Pointer to voice-bridge template for playbook flags |
| `docs/voice-bridge-runtime-env.md` | Playbook flag table + safety notes |
| `docs/Tasks/voice_assistant_v4_phase10ao_playbook_eval_scenarios_report.md` | **New** — this report |
| `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` | Phase 10AO checklist/status |

Not changed: production env files, Dockerfiles, deploy workflows, `turn-assistant.js`,
`docs/Tasks/logs.txt`.

## Production behavior changed?

**No.** Default env is unchanged; eval runner is test/eval-only and does not alter live
routing. Pending categories explicitly avoid faking runtime passes.

## Verification results

| Check | Result |
|---|---|
| `cd voice-bridge && npm test` | **PASS** — 524/524 (8 new 10AO tests) |
| `python -m pytest rag-api/tests` | **PASS** — 7/7 |
| `node --check` changed JS | **PASS** |
| `git diff --check` | **PASS** |
| `run-ci-dialogue-scenarios.ps1` | **PASS** — 26/26 |

## Confirmations

- Production v4 and RAG defaults remain **off**; playbook runtime flags default off.
- `docs/Tasks/logs.txt` untouched.
- Draft playbook not production-active.
- No Docker tag created.

## Recommendation for next phase

**Phase 10AP — Questionnaire Generator** (later) or an incremental runtime consumer phase
that wires out-of-scope redirect, technical escalation, and callback lead-capture paths so
the three pending eval scenarios can move from `pending` to `pass` without changing the
eval contract.
