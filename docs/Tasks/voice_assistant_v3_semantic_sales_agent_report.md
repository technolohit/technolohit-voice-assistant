# TechnoloHit Voice Assistant v3 — Implementation Report

Date: 2026-05-30  
Blueprint: [voice_assistant_v3_semantic_sales_agent_blueprint.md](./voice_assistant_v3_semantic_sales_agent_blueprint.md)

## Summary

v3 introduces a modular semantic sales architecture behind feature flags. **Live dialogue behavior** is unchanged until `VOICE_SEMANTIC_INTENT_ENABLED` and `VOICE_CONVERSATION_REPAIR_ENABLED` are enabled. Local QA and CI run with v3 enabled in the text dialogue harness (`buildQaConfig`).

**Post-call lead policy** is intentionally **always on** by default via `VOICE_LEAD_POLICY_STRICT_CALLBACK=true` (blocks fake `team_callback` without a valid phone). This is separate from v3 sales flags and applies on every deploy unless explicitly rolled back.

The v1.2.1 live failure (Eigenunternehmen / Eigene Unternehmen customer-type loop) is fixed when v3 flags are on.

## Pre-production QA cleanup (2026-05-30)

- Updated legacy sales QA assertions for v3 explanation and new-prospect wording.
- Fixed phone handoff after product explanation (`Telefonisch bitte` no longer loops in customer-type repair).
- Added scenario `v3_explanation_then_phone_handoff`.
- Documented always-on lead policy; added `VOICE_LEAD_POLICY_STRICT_CALLBACK` (default `true`, legacy path when `false`).

## v3 stabilization pass (2026-05-30, live-call logs)

Based on v1.3.0 live-call evidence (`docs/Tasks/logs.txt`):

| Issue | Fix |
|-------|-----|
| Shallow sales — handoff after one need answer | `sales-dialogue-manager.js`: reflection + channel follow-up (`sales_need_discovery_followup`) before handoff; `wantsExplicitContactHandoff()` ignores channel answers like “Website und Telefon” |
| Product relation misclassified as `human_or_ai_question` | `product-intent-routing.js`: product/relation signals outrank identity; `turn-assistant.js` routes before human/AI template |
| Post-completion “Welche Frage?” loop | `post-completion-router.js` + early routing in `maybeCreateSoftIntakeResponse` when intake completed |
| Pricing after contact → generic website line | `buildPostCapturePricingAnswer()` + `business-fallback-policy.js` skips website redirect when `contactCaptured` |
| Channel answer reset to Smart Website pitch | `turn-assistant.js`: skip `setSelectedProduct` when `productDialogueState` is active sales stage |
| Wrong env file on server | `docs/voice-bridge-runtime-env.md`; deploy workflow optional `verify_v3_qa_env` |

New modules: `product-intent-routing.js`, `post-completion-router.js`.

New QA scenarios: `v3_sales_depth_before_handoff`, `v3_post_completion_product_question`, `v3_pricing_after_contact_capture`, `v3_email_contact_closing`.

**Email contact closing (2026-05-30):** `completeEmailDirectIntake` now appends a short follow-up/closing question via `email-intake-closing.js` so the E-Mail path does not end in silence after guidance.

Re-ran full CI dialogue list (**25 scenarios**) — all pass.

## Architecture delivered

```text
ASR diagnostics (optional)
  -> semantic-intent.js (deterministic + optional LLM hook placeholder)
  -> conversation-repair.js
  -> sales-dialogue-manager.js
  -> rag-sales-answerer.js (QA-flagged)
  -> lead-policy.js (post-call guards)
  -> turn-assistant.js (orchestration only)
```

## New modules

| Module | Role |
|--------|------|
| `voice-bridge/src/semantic-intent.js` | Structured intent JSON, noisy German customer-type mapping, confidence thresholds |
| `voice-bridge/src/conversation-repair.js` | Same-prompt loop prevention, repair/fallback wording |
| `voice-bridge/src/sales-dialogue-manager.js` | Sales stage transitions; customer-type / need / explanation turns |
| `voice-bridge/src/rag-sales-answerer.js` | RAG + playbook fail-closed product answers |
| `voice-bridge/src/lead-policy.js` | Stable customer_type metadata; strict callback-ready rules |
| `voice-bridge/src/asr-diagnostics.js` | QA diagnostic records + offline fixture eval |
| `voice-bridge/src/product-intent-routing.js` | Product/relation vs human/AI priority; post-capture pricing wording |
| `voice-bridge/src/post-completion-router.js` | Post-lead QA: prompt-only vs direct product/pricing answers |
| `voice-bridge/src/email-intake-closing.js` | E-Mail contact path: guidance + short closing/follow-up question |

## Environment flags (default: off)

```env
VOICE_SEMANTIC_INTENT_ENABLED=false
VOICE_SEMANTIC_INTENT_MODE=deterministic
VOICE_SEMANTIC_INTENT_MIN_ACCEPT=0.75
VOICE_SEMANTIC_INTENT_MIN_SOFT=0.45
VOICE_CONVERSATION_REPAIR_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
VOICE_ASR_DIAGNOSTICS_ENABLED=false
# Always-on post-call safety (not gated by v3 sales flags):
VOICE_LEAD_POLICY_STRICT_CALLBACK=true
```

Documented in `voice-bridge/.env.example` and repo root `.env.example`.

### Lead policy (always-on by default)

| Flag | Default | Effect |
|------|---------|--------|
| `VOICE_LEAD_POLICY_STRICT_CALLBACK` | `true` | `post-call-summary` / `post-call-lead` use `lead-policy.js` strict phone + `team_callback` guards |
| `false` | rollback | Restores legacy `next_action` derivation (pre-v3 strict phone check) |

Summary metadata includes `lead_policy_strict_callback: true|false` for auditability.

## Phase status

| Phase | Status | Notes |
|-------|--------|-------|
| 0 Freeze & baseline | Partial | v1.2.1 fixture added; production image/env not verified in this session |
| 1 Semantic intent | Done | Deterministic mode + tests |
| 2 Conversation repair | Done | No repeated menu; fallback path |
| 3 Sales dialogue manager | Done | Stages wired; `turn-assistant` delegates when v3 enabled |
| 4 RAG sales answerer | Done | Behind `VOICE_RAG_SALES_ANSWERER_ENABLED` + RAG flags |
| 5 ASR diagnostics | Done | Logging hook + `npm run eval:asr-fixture` |
| 6 Lead policy | Done | `post-call-summary` / `post-call-lead` use stricter guards |
| 7 CI QA matrix | Done | 25 dialogue scenarios green locally + eval in CI |
| 8 Controlled rollout | Pending | Requires sysadmin verification on target host |

## Live failure fixture

`voice-bridge/fixtures/live-call-failures/v1_2_1_customer_type_loop.json`

Replay:

```bash
cd voice-bridge
npm run eval:asr-fixture
node scripts/qa-dialogue-text.js --scenario v3_live_customer_type_loop
```

## Acceptance (local)

| Check | Result |
|-------|--------|
| `npm test` | Pass (46 tests) |
| `node --check` on changed JS | Pass |
| `npm run eval:asr-fixture` | Pass (7 semantic turns) |
| CI dialogue matrix (25 scenarios) | Pass (`scripts/run-ci-dialogue-scenarios.ps1`) |
| `v3_email_contact_closing` | Pass |
| `v3_sales_depth_before_handoff` | Pass |
| `v3_post_completion_product_question` | Pass |
| `v3_pricing_after_contact_capture` | Pass |
| `v3_explanation_then_phone_handoff` | Pass |
| Eigenunternehmen → new_prospect | Pass (semantic + dialogue) |
| No repeated customer-type menu | Pass |
| Kurze Erklärung → product answer | Pass |
| Callback without phone blocked | Pass (lead-policy tests) |

## Rollout procedure (recommended)

1. Merge with all v3 flags **false** → deploy (no behavior change).
2. On QA/staging host, enable:
   - `VOICE_SEMANTIC_INTENT_ENABLED=true`
   - `VOICE_CONVERSATION_REPAIR_ENABLED=true`
   - `VOICE_SEMANTIC_INTENT_MODE=deterministic`
3. Run live call matrix; then optionally enable RAG answerer in QA only:
   - `VOICE_RAG_ENABLED=true`
   - `VOICE_RAG_QA_MODE=true`
   - `VOICE_RAG_SALES_ANSWERER_ENABLED=true`

## Runtime env source of truth

See [docs/voice-bridge-runtime-env.md](../voice-bridge-runtime-env.md).

- Authoritative file for `technolohit-voice-bridge`: `<deploy>/voice-bridge/.env` (Compose `env_file`), **not** `asterisk/.env` alone.
- RAG remains **disabled** for rollout (`VOICE_RAG_ENABLED=false`, `VOICE_RAG_SALES_ANSWERER_ENABLED=false`).
- Deploy workflow: set `verify_v3_qa_env=true` to fail loudly if the running container image or v3 flags do not match expectations.

## Sysadmin verification still required

Before production-like QA with RAG/semantic:

```bash
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
docker logs --tail=120 technolohit-voice-bridge
docker exec technolohit-voice-bridge sh -lc 'getent hosts technolohit-rag-api || true'
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://technolohit-rag-api:8080/healthz || true'
docker exec technolohit-voice-bridge sh -lc 'printenv | sort | egrep "^(VOICE_SEMANTIC|VOICE_RAG|VOICE_CONVERSATION|VOICE_LEAD_POLICY|IMAGE_TAG|BUILD_VERSION)=" || true'
```

Alternate ASR provider integration was **not** implemented (per blueprint: diagnostics/evaluation hooks only).

## Privacy / lead guards preserved

- Deterministic phone validation, permission, and contact capture paths unchanged.
- `lead-policy.js` prevents `team_callback` when `phone_present` is false (**always-on** when `VOICE_LEAD_POLICY_STRICT_CALLBACK=true`, the default).
- After explanation, explicit phone preference routes to intake (`handoff_choice_requested`) with caller-ID permission flow unchanged.
- No full phone numbers in diagnostic log previews (redacted).

## Known limitations

- LLM semantic mode (`VOICE_SEMANTIC_INTENT_MODEL`) is reserved; only deterministic classification ships in this change.
- With v3 **disabled**, legacy `classifyCustomerType()` in `sales-policy.js` still runs (including the v1.2.1 loop risk).
- Turn 3 of `v3_live_customer_type_loop` advances to handoff because turn 2 already captured need-discovery stage (expected v3 behavior, not a menu loop).
- RAG sales answerer is implemented but off by default; post-completion product answers use deterministic playbooks until RAG is explicitly enabled in QA.

## Files touched (high level)

- New: 8 `src` modules, 8+ test files, 1 fixture, `scripts/eval-asr-fixture.js`, `docs/voice-bridge-runtime-env.md`
- Updated: `turn-assistant.js`, `sales-dialogue-manager.js`, `business-fallback-policy.js`, `config.js`, post-call modules, `qa-dialogue-text.js`, CI/deploy workflows, `.env.example` files
