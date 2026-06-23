# Phase 12E Live Playbook Provenance And Spoken Integrity Report

Date: 2026-06-20

Status: implemented; release recommendation **`voice-bridge-v1.36.2`** after Codex review. **Do not deploy, run live QA, or tag until review completes.**

## Phase 12D classification

**PARTIAL PASS / ACCEPTANCE FAIL**

Call session: `c411ccac-a282-4115-b883-aafd9d8bea3f`

| Area | Result |
|------|--------|
| Handler / binding preflights | Pass |
| Smart Website / pricing / callback routing / closing priority | Pass |
| RAG off | Pass |
| Quality flush / post-call / notification / privacy / rollback | Pass |
| Playbook provenance on `response_plan_created` | **Fail** — recorded legacy agent-config version |
| Company-general spoken answer | **Fail** — mid-sentence truncation before follow-up |
| Callback completion evidence | **Fail** — early close during contact preference (valid abandon; evidence incomplete) |

## Root cause: provenance overwrite

`enrichQualityEventForPersistence()` merged `prompt_playbook_version` from agent config (`technolohit-sales-v4-20260601` in `technolohit.main_voice_sales.v4.json`) into every flushed quality event. No separate runtime `playbook_version` field existed on `response_plan_created`, so QA and analytics treated the legacy prompt metadata as the active playbook.

`agent-behavior-decision-runtime.js` also loaded the draft tenant playbook via `loadTenantPlaybook(DEFAULT_PLAYBOOK_FILENAME)` when orchestrator did not pass a verified binding playbook — a second independent source.

## Fixes (Phase 12E)

### 1. Runtime playbook provenance

- New `playbook-provenance.js` builds fail-closed provenance from `resolveBehaviorPolicy()` / approved binding.
- `behavior-policy.js` exposes `playbook_binding_version` and `playbook_source=approved_runtime_binding` on verified policies.
- `response_plan_created` carries distinct fields:
  - `playbook_version` — checksum-verified published artifact only
  - `playbook_binding_version`
  - `playbook_source`
  - `agent_config_version`
  - `agent_config_playbook_version` — legacy prompt metadata, never overloaded as runtime version
- Fail closed when runtime is enabled but binding cannot be resolved (`playbook_provenance_ok=false`, safe reason code).

### 2. Single verified playbook instance

- `loadPlaybookForProductContent()` no longer reloads draft/agent-config paths when binding policy is active; consumers use `behaviorPolicy.playbook`.
- Agent Behavior Decision metadata uses orchestrator policy playbook only (no draft reload).

### 3. Company-general spoken integrity

`resolveCompanyAnswer()` now prefers complete sentences within `COMBINED_LIVE_TTS_CHAR_LIMIT` (160). When base + diagnostic follow-up exceed the limit, the first complete positioning sentence is used alone.

**Exact prepared live TTS text for “Was macht TechnoloHit?” (default `VOICE_ASSISTANT_MAX_RESPONSE_CHARS=160`):**

```text
TechnoloHit hilft Unternehmen dabei, KI praktisch im Alltag einzusetzen.
```

`prepareLiveAssistantSpeechText()` applies sentence-boundary trimming before ellipsis fallback.

### 4. Callback closing / abandon semantics

Closing priority unchanged. When closing occurs during `collecting_contact_preference`, `callback_permission_pending`, or `phone_number_pending`:

- `response_type=closing`, `next_state=completed`
- No `lead_ready`, no fabricated permission/contact preference
- Evidence on `response_plan_created`:
  - `callback_flow_abandoned=true`
  - `callback_abandon_stage`
  - `lead_skipped_reason=caller_closed_before_callback_completion`
  - `plan_reason=closing_intent_callback_abandoned`

### 5. Handler readiness observability

- Startup log clarifies `legacy_startup_router` vs `live_audiosocket_canary_configured` vs `live_handler_selection=per_call`.
- `npm run runtime:readiness` — non-live JSON readiness report.
- Per-call evidence remains: `call_handler selected=v4_canary reason=v4_live_canary_selected`.

### 6. Live QA script (Phase 10H runbook)

Supervised callback script now requires full multi-turn completion before closing. Early close during contact preference is classified as **test-protocol failure**, not callback-runtime failure.

## Changed files

| File | Change |
|------|--------|
| `voice-bridge/src/v4/playbook-provenance.js` | New provenance builder |
| `voice-bridge/src/v4/behavior-policy.js` | Binding metadata on policy |
| `voice-bridge/src/v4/persist-metadata.js` | Runtime + legacy fields |
| `voice-bridge/src/v4/quality-persistence.js` | Enrich flush payloads |
| `voice-bridge/src/v4/quality-events.js` | Version metadata exempt keys |
| `voice-bridge/src/v4/quality-analytics.js` | Summary provenance fields |
| `voice-bridge/src/v4/privacy-sanitize.js` | Safe version key handling |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Provenance on plan events |
| `voice-bridge/src/v4/playbook-product-content.js` | Company answer + single playbook |
| `voice-bridge/src/v4/response-planner.js` | Callback abandon on close |
| `voice-bridge/src/v4/callback-flow-policy.js` | Abandon evidence helpers |
| `voice-bridge/src/v4/agent-behavior-decision-runtime.js` | No draft playbook reload |
| `voice-bridge/src/v4/live-tts-playback-endpoint.js` | Sentence-aware trim |
| `voice-bridge/src/v4/runtime-router.js` | Readiness fields |
| `voice-bridge/src/v4/post-call-bridge.js` | Post-call provenance |
| `voice-bridge/src/v4/playbook-eval-scenarios.js` | Company TTS eval rule |
| `voice-bridge/src/index.js` | Startup readiness log |
| `voice-bridge/scripts/runtime-readiness.js` | Non-live readiness CLI |
| `voice-bridge/package.json` | `runtime:readiness` script |
| `voice-bridge/tests/v4-phase12e-*.test.js` | Phase 12E contract tests |
| Test adjustments | 10B/10F/10AT/wiring privacy assertions |

## Verification

| Check | Result |
|-------|--------|
| `cd voice-bridge && npm test` | **784 pass / 0 fail** (785 total, 1 skipped) |
| `playbook:publish-validate` | pass — eval 33/0/0, decision 13/0/0 |
| `playbook:publish-validate:published` | pass |
| `playbook:canary-artifact-validate` | pass |
| Phase 12A/12B binding tests | 28 pass / 0 fail |
| `python -m pytest rag-api/tests` | 7 passed |
| `node --check` (changed JS) | pass |
| `git diff --check` | pass (CRLF warnings only) |
| `run-ci-dialogue-scenarios.ps1` | **26/26 pass** |
| Phase 12E tests | 9/9 pass |

## Default-off confirmation

Unchanged without env overrides:

- `VOICE_RUNTIME_VERSION=v3`
- `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=false`
- RAG remains off by default
- Production v4 / RAG / env not modified

## Release recommendation

After Codex review: tag and publish **`voice-bridge-v1.36.2`**. Expected rag-api publication: **skip** (`rag_api_unchanged_since_v1.36.1`).

Do **not** run another supervised live QA until this build is deployed and provenance + TTS integrity are verified on a fresh call.
