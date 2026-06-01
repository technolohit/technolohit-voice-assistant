# TechnoloHit Voice Assistant v4 — Phase 2 Runtime Foundation Report

Date: 2026-06-01  
Status: **Ready for review** (runtime architecture; production remains v3)  
Blueprint: [voice_assistant_v4_realtime_tenant_ready_blueprint.md](./voice_assistant_v4_realtime_tenant_ready_blueprint.md)  
Phase 1: tagged `v1.4.0`

## Objective

Move from Phase 1 placeholders to a **testable v4 runtime architecture** (memory, state machine, lead validation, quality events, router) while **keeping production on v3**.

## Implemented vs stubbed

| Area | Status |
|------|--------|
| CallSessionMemory | **Implemented** — structured fields, pure updaters, redaction |
| State machine | **Implemented** — deterministic transitions + intent/memory routing |
| Runtime router | **Implemented** — v3 default; v4 context init when flagged (stub) |
| Quality event builders | **Implemented** — typed builders + redaction |
| Lead validator | **Implemented** — callback/email/RAG guards |
| RAG scope guardrails | **Implemented** — tenant/agent scope + no lead delegation |
| Agent config helpers | **Implemented** — product/claims/closing helpers |
| Audio session / VAD / STT / TTS | **Still stubbed** → Phase 3 media layer |
| Live v4 audio path | **Not wired** → Phase 3 (audiosocket/canary) |
| Quality event DB insert from v3 | **Not wired** → Phase 5 / Phase 8 |

## Files changed / added

| File | Change |
|------|--------|
| `voice-bridge/src/v4/call-session-memory.js` | Full memory model |
| `voice-bridge/src/v4/state-machine.js` | Expanded states + validation |
| `voice-bridge/src/v4/runtime-router.js` | `createRuntimeContext`, `routeIncomingCallToRuntime` |
| `voice-bridge/src/v4/quality-events.js` | Typed builders + redaction |
| `voice-bridge/src/v4/lead-validator.js` | **New** |
| `voice-bridge/src/v4/redaction.js` | **New** shared redaction |
| `voice-bridge/src/v4/rag-scope.js` | RAG purpose guardrails |
| `voice-bridge/src/v4/agent-config.js` | Product/claims helpers |
| `voice-bridge/tests/v4-phase2-runtime-foundation.test.js` | **New** Phase 2 tests |

## Flags and default behavior

Unchanged from Phase 1:

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_V4_STREAMING_STT_ENABLED=false
VOICE_V4_STREAMING_TTS_ENABLED=false
```

Even with `VOICE_RUNTIME_VERSION=v4` + `VOICE_V4_REALTIME_ENABLED=true`, router returns **stub** (`active: false`) and **`routeIncomingCallToRuntime` still delegates to v3**.

Phase 0B/0C spike flags remain QA-only.

## RAG

- Payloads always include `tenant_id` + `agent_id`.
- Lead/permission validation **must not** be delegated to RAG.
- Documented host-local base URL: `http://127.0.0.1:8080` (`V4_RAG_HOST_LOCAL_BASE_URL`).
- Fail-closed playbook behavior in `rag-sales-answerer.js` unchanged for v3.

## Rollback

1. Keep `VOICE_RUNTIME_VERSION=v3` and v4 flags off.
2. Deploy previous image tag (e.g. `voice-bridge-v1.4.0`) if needed.
3. No migration changes in Phase 2.

## Production-rollout blockers (tracked, not Phase 2 blockers)

- Final retention approval — Mojtaba, Founder of TechnoloHit
- Backup encryption confirmation
- Dedicated QA route
- Overload fallback destination
- OpenAI streaming/realtime limits

## Remaining work by blueprint phase

| Phase | Work |
|-------|------|
| **Phase 3** | Real audio session, VAD, streaming STT/TTS, TTS cache, audiosocket wiring (canary, default off) |
| **Phase 4** | Production barge-in via `VOICE_V4_BARGE_IN_ENABLED` (not spike flags) |
| **Phase 5** | Live dialogue orchestrator; memory/state in runtime; quality event persistence |
| **Phase 6–9** | Live RAG integration, post-call, observability, production rollout |

## Documentation status

- Blueprint phase plan **normalized** (2026-06-01): single Phase 2 for application layer; media → Phase 3; barge-in → Phase 4; orchestrator → Phase 5; rollout → Phase 9.
- Removed duplicate **Phase 4: CallSessionMemory** section — that work is recorded under **Phase 2** completed.
- **Next implementation phase:** Phase 3 — Realtime Audio Foundation / Media Layer.
- **No production v4 enablement** in Phase 2; production runtime remains v3.

## Test results

- `voice-bridge npm test`: **108/108 pass**
- `python -m pytest rag-api/tests`: **6/6 pass**
- Dialogue QA matrix: **25/25 pass**
- `git diff --check`: clean
