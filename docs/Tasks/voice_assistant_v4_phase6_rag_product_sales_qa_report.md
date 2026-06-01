# TechnoloHit Voice Assistant v4 — Phase 6 RAG Product/Sales Q&A Report

Date: 2026-06-01  
Status: **Ready for Codex review** (canary RAG integration; production remains v3)  
Blueprint: [voice_assistant_v4_realtime_tenant_ready_blueprint.md](./voice_assistant_v4_realtime_tenant_ready_blueprint.md)  
Prior phase: Phase 5 dialogue orchestrator (tag `v1.8.0`)

## Objective

Integrate bounded **product/sales RAG** into the v4 canary dialogue orchestrator with tenant/agent-scoped requests, state gating, fail-closed retrieval, and sales-safe fallbacks — without enabling production v4 or changing v3 behavior.

## Files inspected

| File | Role |
|------|------|
| `voice-bridge/src/v4/rag-scope.js` | Existing tenant/agent payload builder, host-local URL constant |
| `voice-bridge/src/rag-client.js` | HTTP `/v1/retrieve` client |
| `voice-bridge/src/rag-sales-answerer.js` | v3 reference (not wired to canary) |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Turn lifecycle; RAG hook point |
| `voice-bridge/src/v4/response-planner.js` | Plan shaping, post-contact product Q&A |
| `voice-bridge/src/v4/lead-validator.js` | RAG must not create leads |
| `voice-bridge/src/v4/canary-runtime-loop.js` | Harness simulation |
| `voice-bridge/src/v4/quality-events.js` | Quality event builders |
| `voice-bridge/src/config.js` | RAG URL defaults (unchanged defaults) |

## Files changed / added

| File | Change |
|------|--------|
| `voice-bridge/src/v4/rag-orchestrator.js` | **New** — `shouldUseRagForTurn`, `buildV4RagQuery`, `retrieveV4RagAnswer`, `validateRagAnswerSafety`, `fallbackToPlaybook`, `summarizeRagEvidence` |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Async RAG retrieval in `decideNextAction`; quality events; injectable `ragRetriever` |
| `voice-bridge/src/v4/response-planner.js` | RAG gate integration; post-contact product/pricing branch; pricing intent |
| `voice-bridge/src/v4/canary-runtime-loop.js` | Async harness turns; `ragRetriever` adapter passthrough |
| `voice-bridge/src/v4/quality-events.js` | `buildRagRetrievalFailedEvent` |
| `voice-bridge/tests/v4-phase6-rag-product-sales-qa.test.js` | **New** Phase 6 tests (16 cases) |
| `voice-bridge/tests/v4-phase5-dialogue-orchestrator.test.js` | Async harness updates for Phase 5 compatibility |

**Not modified:** `turn-assistant.js`, production env files, `docs/Tasks/logs.txt`.

## RAG production URL reality

In the current **host-network** deployment, `voice-bridge` reaches RAG at:

```text
http://127.0.0.1:8080
```

Docker service DNS `http://technolohit-rag-api:8080` is **not** valid from voice-bridge in this setup. `rag-scope.js` documents `V4_RAG_HOST_LOCAL_BASE_URL`; configured `VOICE_RAG_API_URL` overrides when set.

## Allowed vs forbidden RAG states

**Allowed (product/sales Q&A only):**

- `answering_product_question`
- `collecting_sales_context` (pricing/product questions)
- `thinking` / `listening` with product or pricing intent
- Post-contact product/pricing questions while contact fields remain in memory

**Forbidden:**

- `collecting_contact_preference`
- `collecting_callback_permission`
- `validating_contact` (except post-contact product/pricing)
- `lead_ready`, `closing`, `completed`, `greeting`, `idle`

RAG never creates leads, validates phone/email, grants callback permission, or overrides lead policy.

## Fail-closed behavior

`retrieveV4RagAnswer` falls back to sales playbook when:

- RAG API URL missing
- HTTP/timeout/unavailable
- Miss or zero hits
- Score below `min_score` (default 0.72)
- Empty, unsafe, or forbidden-claim answer
- State gate denies RAG

## Default production behavior

**Unchanged.**

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_CANARY_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_RAG_ENABLED=false
```

Live calls route to **v3**; canary dialogue + RAG run only with explicit test harness and v4/canary flags.

## Rollback

1. Keep production defaults above.
2. Revert Phase 6 files if needed; no DB migrations.
3. Deploy prior image tag (e.g. `v1.8.0`) — v3 path unaffected.

## Test results

| Suite | Result |
|-------|--------|
| `cd voice-bridge && npm test` | **181/181 pass** |
| `python -m pytest rag-api/tests` | **6/6 pass** |
| `node --check` on changed JS | **pass** |
| `git diff --check` | **clean** |

## Remaining risks

- RAG integration is **canary/harness only** — no live AudioSocket PCM path yet.
- Playbook fallback is deterministic; live KB quality depends on rag-api content and ops URL config.
- Quality events buffered in memory; DB persistence remains Phase 8.
- End-to-end live RAG latency under real STT/TTS not measured in this phase.

## Next phase

**Phase 7 — Lead Policy, Post-Call Reliability, And Privacy** (live v4 lead validators, email vs callback paths, post-call summary tenant fields).
