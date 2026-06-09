# Phase 10AM — First TechnoloHit Structured Playbook Report

Date: 2026-06-09
Production status: **v3 / RAG-off unchanged**. No runtime behavior change, no env, Dockerfile, or deploy workflow change.

## Goal

Create the first manual structured TechnoloHit playbook artifact as the first step toward
playbook-driven behavior (Agent Behavior Layer / Tenant Playbook direction in the blueprint).
The artifact is **draft, manually maintained, and not runtime-active**.

## Playbook artifact

Path: `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json`

- `schema_version`: `tenant-playbook-1`
- `tenant_id=technolohit`, `agent_id=main_voice_sales`
- `playbook_version`: `technolohit-playbook-v1-20260609`
- `status`: `draft`
- `runtime_binding.active=false` — the validator **rejects** any Phase 10AM playbook with
  `runtime_binding.active=true`, so the artifact cannot silently become runtime-active.

Content (all sourced from existing accepted behavior, not invented):

| Section | Source |
|---|---|
| Agent role + boundaries ("TechnoloHit AI Voice Reception / Sales Assistant", no general chatbot, no invented prices, no live-transfer claims) | Blueprint "Role Boundary & Conversation Behavior" |
| Allowed/disallowed topics, tone | Blueprint Role Boundary + Conversation Priority Contract |
| Products (Smart Website, Digitale Rezeption/`voice_agent`, LokalKI, plus AISeoQ and Botinteg) with aliases | `config/agents/technolohit.main_voice_sales.v4.json` |
| Product answer rules (answer first, combined inquiry = definition + value + scope pricing, TTS limit, RAG fallback to playbook) | Phases 10AB/10AC |
| Pricing policy (no invented fixed prices, scope-dependent, "Der Preis hängt vom Umfang ab.") | Phases 10AB/10AC + `forbidden_claims` |
| Lead capture policy (answer first; capture only when appropriate; never via RAG or after closing) | Blueprint Priority Contract #4 + lead validator behavior |
| Callback policy (valid phone + permission required, no live-transfer claims, preferred wording) | Agent config `handoff` + blueprint |
| Escalation policy (out-of-scope redirect, technical escalation wording) | Blueprint Priority Contract #2 |
| Closing policy (8 Phase 10AK phrases, contract response, highest priority, overrides, context-sensitive "Stopp") | Phase 10AK (`v4/closing-intent.js`) |
| Fallback policy | Blueprint Priority Contract #5 |
| Notification policy (post-call workflow, email/Telegram to Mojtaba/team, idempotent) | Blueprint role section + existing post-call workflow |
| QA criteria (9 items: closing override, combined-answer completeness, no fixed prices, privacy, barge-in preserved, ...) | Gate 2/Gate 3/10AK acceptance criteria |
| Initial eval scenarios (8: closing x2, interruption/bare-stop, out-of-scope, technical escalation, pricing, combined product inquiry, callback) | Blueprint Evaluation Scenario Direction |
| Changelog + approval metadata (`approved_for_runtime=false`, owner Mojtaba) | Blueprint Tenant Playbook / Versioning Direction |

## Loader/validator (non-runtime)

`voice-bridge/src/v4/playbook-loader.js`:

- `loadTenantPlaybook()` / `resolvePlaybookPath()` / `validatePlaybook()` /
  `PLAYBOOK_REQUIRED_TOP_LEVEL_FIELDS`.
- Validates required top-level fields, status enum (`draft|published|archived`), product
  shape (id/aliases/explanation), closing policy shape, eval scenario completeness, and
  rejects `runtime_binding.active=true`.
- **Not imported by any runtime module** — used only by the Phase 10AM tests. It does not
  alter live call behavior and does not replace `agent-config.js`, which remains the
  runtime source of truth.

## Files inspected

- `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` (Role Boundary,
  Conversation Priority Contract, Agent Behavior Layer, Tenant Playbook / Versioning
  Direction, Evaluation Scenario Direction, Phase 10AM checklist)
- `voice-bridge/config/agents/technolohit.main_voice_sales.v4.json`
- `voice-bridge/src/v4/agent-config.js` (loader pattern)
- `voice-bridge/src/v4/closing-intent.js` (Phase 10AK phrases + closing response)
- `voice-bridge/src/v4/playbook-short-answer.js` (combined/pricing answers)
- `voice-bridge/src/sales-policy.js` (product explanations)

## Files changed

| File | Change |
|---|---|
| `voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.json` | **New** — draft playbook artifact |
| `voice-bridge/src/v4/playbook-loader.js` | **New** — non-runtime loader/validator (tests only) |
| `voice-bridge/tests/v4-phase10am-structured-playbook.test.js` | **New** — 10 tests |
| `docs/Tasks/voice_assistant_v4_phase10am_technolohit_structured_playbook_report.md` | **New** — this report |
| `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` | Phase 10AM checklist/status updates only |

Runtime behavior changed: **none**. No existing source module was modified; the new loader is
not referenced by any runtime path.

## Tests added (`tests/v4-phase10am-structured-playbook.test.js`)

1. Playbook JSON exists and parses.
2. Required top-level fields exist; validator passes; tenant/agent/status/version correct.
3. Playbook is not runtime-active (`runtime_binding.active=false`,
   `approved_for_runtime=false`); validator rejects an active binding.
4. All three required products exist with aliases and explanations
   (`smart_website`, `voice_agent` = Digitale Rezeption, `lokalki`).
5. Closing policy includes all eight Phase 10AK phrases, each cross-checked against the
   runtime `isClosingIntent()` detection, plus the exact contract response, highest priority,
   required overrides, and context-sensitive "Stopp".
6. Role boundary disallows general chatbot behavior and invented prices; disallowed topics
   include general knowledge and legal advice.
7. Pricing policy forbids invented fixed prices and is scope-dependent.
8. Lead capture policy answers first and captures only when appropriate; never via RAG or
   after every product question; no live-transfer claims.
9. Eval scenarios cover closing, out_of_scope, technical_escalation, pricing, and callback,
   and every scenario has id/caller/expected.
10. Validator flags missing fields and invalid status values.

## Verification results

| Check | Result |
|---|---|
| `cd voice-bridge && npm test` | **PASS** — 502/502 tests (10 new 10AM tests included) |
| `python -m pytest rag-api/tests` (repo root) | **PASS** — 7/7 |
| `node --check` on new JS | **PASS** |
| `git diff --check` | **PASS** (no whitespace errors) |
| `voice-bridge/scripts/run-ci-dialogue-scenarios.ps1` | **PASS** — all 26 v3 dialogue QA scenarios |

## Confirmations

- **No runtime behavior changed**: only a new config artifact, a new non-runtime module, a
  new test file, and docs. No existing runtime source file modified.
- Production v4 and RAG defaults remain **off** (`VOICE_RUNTIME_VERSION=v3`,
  RAG disabled by default); no env/Dockerfile/deploy changes.
- `docs/Tasks/logs.txt` untouched.
- The playbook artifact is **draft/manual and not runtime-active**; `agent_config` stays the
  runtime source of truth until Phase 10AN.
- No Docker release tag needed: only docs/config/test artifacts changed and runtime behavior
  is unchanged.

## Recommendation for next phase

**Phase 10AN — Playbook-Driven Runtime Increment 1**: move only the safest repeated behavior
rules from code into the playbook, starting with the closing policy (phrases + response) and
the fallback response, behind an explicit opt-in flag, with equivalence tests asserting the
playbook-driven values match the current hardcoded Phase 10AK behavior exactly before any
runtime binding is activated.
