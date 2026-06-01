# TechnoloHit Voice Assistant v4 — Phase 5 Dialogue Orchestrator Report

Date: 2026-06-01  
Status: **Ready for Codex review** (canary dialogue orchestrator; production remains v3)  
Blueprint: [voice_assistant_v4_realtime_tenant_ready_blueprint.md](./voice_assistant_v4_realtime_tenant_ready_blueprint.md)  
Phase 4: tagged `v1.7.0`

## Objective

Connect Phase 2 memory/state machine, Phase 3 media layer, and Phase 4 barge-in modules into a **coherent v4 dialogue runtime skeleton** — canary/test-harness only, no production activation.

## How orchestrator uses prior phases

| Layer | Module(s) | Role in Phase 5 |
|-------|-----------|-----------------|
| Phase 2 | `call-session-memory`, `state-machine`, `lead-validator`, `quality-events` | Turn memory updates, deterministic transitions, lead gating |
| Phase 3 | `audio-session`, STT/TTS adapter stubs, `quality-event-sink` | Session tracking; mock adapters only |
| Phase 4 | `playback-controller`, `barge-in-detector`, `interruption-context` | Interruption recovery during canary playback simulation |

## Implemented vs not live

| Area | Status |
|------|--------|
| Dialogue orchestrator | **Implemented** — turn lifecycle API |
| Response planner | **Implemented** — deterministic mock plans |
| Canary runtime loop | **Implemented** — harness simulation only |
| Quality event sink | **Implemented** — memory buffer; optional insert on v4 path |
| Live OpenAI STT/TTS/LLM | **Not wired** |
| Live AudioSocket production handler | **Not wired** |
| Quality event DB persistence (production) | **Deferred** → Phase 8 |
| Live RAG integration | **Deferred** → Phase 6 |

## Files changed / added

| File | Change |
|------|--------|
| `voice-bridge/src/v4/dialogue-orchestrator.js` | **New** orchestrator |
| `voice-bridge/src/v4/response-planner.js` | **New** deterministic plans |
| `voice-bridge/src/v4/canary-runtime-loop.js` | **New** harness simulation |
| `voice-bridge/src/v4/quality-event-sink.js` | **New** v4-only event buffer/flush |
| `voice-bridge/src/v4/runtime-router.js` | Dialogue canary routing |
| `voice-bridge/tests/v4-phase5-dialogue-orchestrator.test.js` | **New** Phase 5 tests |
| `voice-bridge/tests/v4-phase4-barge-in-runtime.test.js` | Route reason update |

## Flags and default behavior

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_CANARY_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
```

Canary dialogue requires **all** v4/canary flags + `harnessExplicit: true`. Live calls remain **handler v3**, **dropCall false**.

## Rollback

1. Keep defaults (`VOICE_RUNTIME_VERSION=v3`, all v4 flags off).
2. Deploy previous image tag (e.g. `voice-bridge-v1.7.0`) if needed.
3. No DB migrations in Phase 5.

## Production-rollout blockers (tracked, not Phase 5 blockers)

- Final retention approval — Mojtaba, Founder of TechnoloHit
- Backup encryption confirmation
- Dedicated QA route
- Overload fallback destination
- OpenAI streaming/realtime limits

## Risks

- Response planner is deterministic/mock — live LLM/RAG integration is Phase 6.
- Canary loop simulates transcripts/playback; full AudioSocket PCM orchestration awaits later phases.
- `turn-assistant.js` intentionally unchanged — v3 path unaffected.

## Test results

- `voice-bridge npm test`: **165/165 pass**
- `python -m pytest rag-api/tests`: **6/6 pass**
- `node --check` on changed JS files: **pass**
- `git diff --check`: clean

## Next phase

**Phase 6 — RAG Product/Sales Q&A Integration** (live v4 RAG in allowed states, grounded/bounded answers, fail-closed end-to-end).
