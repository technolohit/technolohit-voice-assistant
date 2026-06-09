# Phase 10AN — Playbook-Driven Runtime Increment 1 Report

Date: 2026-06-10
Production status: **v3 / RAG-off unchanged**. Default-env runtime behavior is identical to Phase 10AK.

> **Phase 10AN introduces a guarded resolver and tests only for safest repeated behavior.
> It does not make the draft playbook production-active.**

## Goal

First tiny playbook-driven runtime capability, limited to the safest repeated behavior:
closing phrases, closing response, fallback clarification response, and (resolver-only)
out-of-scope redirect / technical escalation response. Opt-in, default-off, fail-closed,
equivalence-tested against existing Phase 10AK behavior.

## Exact runtime binding behavior

### Resolver (`voice-bridge/src/v4/behavior-policy.js`, new)

`resolveBehaviorPolicy({ config, playbook, allowDraft })` returns a policy object with safe
accessors:

- `getClosingPhrases(policy)`
- `getClosingResponse(policy)`
- `getFallbackClarificationResponse(policy)`
- `getOutOfScopeRedirect(policy)`
- `getTechnicalEscalationResponse(policy)`
- `isClosingIntentForPolicy(transcript, policy)`

Decision order (fail-closed at every step):

1. `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED` false/unset → **hardcoded Phase 10AK defaults**,
   reason `playbook_runtime_disabled`. The playbook file is **never read** in this case.
2. Flag on, no injected playbook → load from `VOICE_V4_PLAYBOOK_PATH` (or the default
   `config/playbooks/technolohit.main_voice_sales.v1.json`). Missing file
   (`playbook_not_found`), broken JSON (`playbook_invalid_json`), or schema failure
   (`playbook_validation_failed`) → hardcoded defaults.
3. Runtime eligibility (`isPlaybookRuntimeEligible`): the playbook must be
   `status=published` **and** `approval.approved_for_runtime=true` **and**
   `runtime_binding.active=true`. A `draft` playbook is rejected
   (`draft_playbook_not_allowed`) unless the explicit override
   `VOICE_V4_PLAYBOOK_ALLOW_DRAFT=true` (or an explicit `allowDraft` argument in
   tests) is set — drafts are never silently treated as production-active.
4. Only then is a `source=playbook` policy returned; any missing individual field still
   falls back to the hardcoded default for that field.

Policy objects carry only behavior wording plus safe metadata (`source`, `reason`,
`playbook_version`) — no transcripts, phone numbers, emails, or secrets. Playbook problems
never crash a call; they only produce a hardcoded-default policy.

### Wiring (v4 only)

- `dialogue-orchestrator.js`: resolves the policy once per orchestrator
  (`behaviorPolicy ?? resolveBehaviorPolicy({ config })`, injectable for tests) and passes
  it to intent detection and response planning.
- `transcript-intent.js`: `detectTranscriptIntent(..., behaviorPolicy)` resolves closing via
  `isClosingIntentForPolicy` — the hardcoded 10AK detection **always applies**; playbook
  phrases can only **extend** it with exact normalized phrase matches. With no policy the
  function is identical to 10AK.
- `response-planner.js`: the closing plan text comes from `getClosingResponse(policy)` and
  the generic fallback clarification text from `getFallbackClarificationResponse(policy)`.
  `getClosingResponse(null)` equals `getWarmGoodbyeResponseText()`, so default behavior is
  byte-identical (asserted via `deepEqual` of full plans in tests).
- Out-of-scope redirect and technical escalation responses are **resolver accessors only**;
  no runtime path consumes them yet (no such hardcoded v4 path exists today).
- Not wired: lead capture, pricing, products, RAG answer synthesis, state machine —
  explicitly out of scope for increment 1. `agent_config` remains the runtime source of
  truth.

### Closing semantics preserved

- Bare "Stopp" during playback keeps barge-in/interruption-wait behavior in both modes
  (it is not a playbook phrase and the built-in guard stands).
- "Stopp, danke, tschüss." remains closing in both modes.
- All eight Phase 10AK phrases close in both modes.

### New config flags (`src/config.js`, all default-off/empty)

| Env | Default | Meaning |
|---|---|---|
| `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED` | `false` | Opt-in master switch for playbook-driven behavior |
| `VOICE_V4_PLAYBOOK_PATH` | `""` (resolver falls back to the repo default path) | Playbook file path (absolute or package-relative) |
| `VOICE_V4_PLAYBOOK_ALLOW_DRAFT` | `false` | Explicit test/canary-only draft override |

No production env files were modified; the flags simply default off.

## Files inspected

- `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` (Phase 10AN checklist,
  Agent Behavior Layer, Tenant Playbook direction)
- `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json`
- `voice-bridge/src/config.js`
- `voice-bridge/src/v4/playbook-loader.js`
- `voice-bridge/src/v4/closing-intent.js`
- `voice-bridge/src/v4/transcript-intent.js`
- `voice-bridge/src/v4/response-planner.js`
- `voice-bridge/src/v4/dialogue-orchestrator.js`
- `voice-bridge/tests/v4-phase10am-structured-playbook.test.js`

## Files changed

| File | Change |
|---|---|
| `voice-bridge/src/v4/behavior-policy.js` | **New** — guarded resolver + accessors + policy-aware closing detection |
| `voice-bridge/src/config.js` | Three new `v4` playbook flags (default off/empty) |
| `voice-bridge/src/v4/playbook-loader.js` | `loadTenantPlaybookFromPath()`; active-binding rule now conditional (`draft_playbook_must_not_be_runtime_active` — active binding valid only for published + runtime-approved playbooks) |
| `voice-bridge/src/v4/transcript-intent.js` | Optional `behaviorPolicy` param; closing via `isClosingIntentForPolicy` |
| `voice-bridge/src/v4/response-planner.js` | Optional `behaviorPolicy` param; closing + generic fallback text via accessors |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Policy resolved per orchestrator (injectable); passed to intent detection and planner |
| `voice-bridge/tests/v4-phase10an-playbook-runtime-increment1.test.js` | **New** — 14 tests |
| `voice-bridge/tests/v4-phase10am-structured-playbook.test.js` | One assertion updated to the renamed validator error |
| `docs/Tasks/voice_assistant_v4_phase10an_playbook_runtime_increment1_report.md` | **New** — this report |
| `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` | Phase 10AN checklist/status updates only |

Not changed: production env files, Dockerfiles, deploy workflows, `turn-assistant.js`,
`rag-api`, `docs/Tasks/logs.txt`.

## Did production behavior change?

**No.** With the default env:

- `resolveBehaviorPolicy` returns hardcoded 10AK values without reading any file.
- The full closing plan is `deepEqual` to the plan produced with no policy (tested).
- The generic fallback clarification text is unchanged (tested).
- v3 route untouched (all 26 v3 CI dialogue scenarios pass; `VOICE_RUNTIME_VERSION=v3`).

## Tests added (`tests/v4-phase10an-playbook-runtime-increment1.test.js`, 14 tests)

1. Default env returns hardcoded policy; closing response equals the existing
   `getWarmGoodbyeResponseText()` / contract text; all accessors return hardcoded defaults.
2. Default env does not load the playbook at runtime (broken path + flag off → exits at the
   flag check with `playbook_runtime_disabled`).
3. Missing playbook with flag on fails closed (`playbook_not_found`).
4. Invalid playbook file with flag on fails closed (`playbook_validation_failed`).
5. Draft playbook is rejected without explicit override (`draft_playbook_not_allowed`).
6. Draft override loads the real Phase 10AM draft; closing behavior is equivalent to 10AK
   (same response text, all eight phrases close, bare "Stopp" does not).
7. Runtime eligibility matrix (missing / draft / draft+override / unapproved / inactive
   binding).
8. Injected valid (published/approved/active) playbook: playbook-only phrase
   "Wir sind fertig für heute." is recognized as closing end-to-end through the
   orchestrator, the playbook closing response is spoken, the RAG retriever is **not**
   called, and quality payloads contain no raw transcript/phone/email.
9. Playbook closing response is NOT used without the opt-in flag (injected playbook +
   flag off → hardcoded).
10. All eight 10AK phrases still close with and without a playbook policy; bare "Stopp"
    remains `interruption_recovery` in both modes; "Stopp, danke, tschüss." remains closing.
11. Closing plan with default env is **deepEqual** to the no-policy plan (byte-identical
    10AK behavior).
12. Fallback clarification default unchanged when flag off.
13. Playbook fallback clarification used only when opted in.
14. v3 default route unchanged (runtime v3, all playbook flags off/empty, RAG off).

## Verification results

| Check | Result |
|---|---|
| `cd voice-bridge && npm test` | **PASS** — 516/516 tests (14 new 10AN tests included) |
| `python -m pytest rag-api/tests` (repo root) | **PASS** — 7/7 |
| `node --check` on all changed JS | **PASS** |
| `git diff --check` | **PASS** (CRLF conversion warnings only) |
| `voice-bridge/scripts/run-ci-dialogue-scenarios.ps1` | **PASS** — all 26 v3 dialogue QA scenarios |

## Confirmations

- Production v4 and RAG defaults remain **off**; the new playbook flags default off; no
  env/Dockerfile/deploy changes.
- `docs/Tasks/logs.txt` untouched.
- The draft playbook is **not** production-active; it is rejected at runtime without the
  explicit draft override, and `agent_config` remains the runtime source of truth.
- No Docker tag created (per instruction; requires explicit Codex approval).

## Recommendation for next phase

**Phase 10AO — Eval Scenarios From Playbook**: generate non-live scenario tests from the
playbook's `eval_scenarios` section (closing, out-of-scope, technical escalation, pricing,
callback), run them through the existing planner/orchestrator test harness, and store
results keyed by `playbook_version` so future playbook edits are regression-checked
automatically before any publish/runtime binding.
