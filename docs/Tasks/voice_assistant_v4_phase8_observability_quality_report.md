# TechnoloHit Voice Assistant v4 — Phase 8 Observability And Quality Analytics Report

Date: 2026-06-01  
Status: **Ready for Codex review** (canary observability foundation; production remains v3)  
Blueprint: [voice_assistant_v4_realtime_tenant_ready_blueprint.md](./voice_assistant_v4_realtime_tenant_ready_blueprint.md)  
Prior phase: Phase 7 lead/post-call/privacy (tag `v1.10.0`)

## Objective

Build v4 **observability and quality analytics** so we can measure latency, errors, RAG usage, lead outcomes, barge-in, and STT/TTS performance with privacy-safe payloads — without enabling production v4.

## Files inspected

| File | Role |
|------|------|
| `voice-bridge/src/v4/quality-events.js` | Event builders + redaction validation |
| `voice-bridge/src/v4/quality-event-sink.js` | Memory buffer + flush |
| `voice-bridge/src/v4/audio-session.js` | Session timing (no transcript logging) |
| `voice-bridge/src/v4/dialogue-orchestrator.js` | Event buffering on turn/close |
| `voice-bridge/src/v4/canary-runtime-loop.js` | Canary harness + close flush |
| `voice-bridge/src/v4/post-call-bridge.js` | Post-call metadata for summary merge |
| `voice-bridge/src/db.js` | `insertCallQualityEvent` |
| `db/voice/migrations/009_v4_call_quality_events.sql` | Quality events table |

## Files changed / added

| File | Change |
|------|--------|
| `voice-bridge/src/v4/quality-persistence.js` | **New** — DB insert fn, enrich, orchestrator flush |
| `voice-bridge/src/v4/quality-analytics.js` | **New** — per-call summary, latency rollups, error classification |
| `voice-bridge/src/v4/quality-event-sink.js` | Fail-safe sequential flush; enrichment before insert |
| `voice-bridge/src/v4/canary-runtime-loop.js` | Optional DB insert fn; async close + flush + summary |
| `voice-bridge/tests/v4-phase8-observability-quality.test.js` | **New** (13 cases) |
| `voice-bridge/tests/v4-phase5-dialogue-orchestrator.test.js` | Async flush test fix |
| `voice-bridge/tests/v4-phase7-lead-postcall-privacy.test.js` | Async closeCanaryDialogueRuntime |
| `docs/Tasks/voice_assistant_v4_phase8_quality_analytics_queries.sql` | **New** SQL runbook |

**Not modified:** `turn-assistant.js`, production env files, `docs/Tasks/logs.txt`.

## Quality event persistence behavior

| Rule | Implementation |
|------|----------------|
| v4-only flush | `flushQualityEvents` returns `v3_path_no_flush` when `v4PathActive` is false |
| Redaction before insert | `redactQualityPayload` + `enrichQualityEventForPersistence` |
| Fail-safe inserts | Per-event try/catch; failures collected in `failures[]`; flush never throws |
| No crash on DB error | `createDbQualityEventInsertFn` returns `{ ok: false }` instead of throwing |
| Sequential insert | Events inserted one-by-one; partial success allowed |
| Canary default | Memory-only unless `insertFn` or `persistQualityToDb: true` |
| v3 path | No new DB writes; existing v3 post-call events unchanged |

## Analytics summary fields (`buildCallQualitySummary`)

**Identity / version**

- `tenant_id`, `agent_id`
- `runtime_version`, `agent_config_version`, `prompt_playbook_version`, `knowledge_version`

**Latency rollups** (`latencies.*`: count, sum, min, max, avg)

- `stt`, `tts`, `rag`, `barge_in_cancel`, `endpointing`, `vad`, `session`, `playback`, `dialogue`

**Counters**

- `turn_count`, `interruption_count`, `rag_used_count`, `rag_failed_count`, `lead_created_count`, `lead_skipped_count`

**Errors** (`classifyQualityError`)

- `stt_error`, `tts_error`, `rag_timeout`, `rag_unavailable`, `provider_rate_limited`, `post_call_error`, `runtime_error`

**Conversion / drop-off**

- `conversion.lead_created`, `conversion.lead_skipped`, `conversion.callback_ready`, `conversion.next_action`
- `drop_off.call_completed`, `drop_off.last_event_type`
- `lead_skip_reasons` map

**Privacy**

- `privacy_ok` — phone-like scan on summary object

## SQL / runbook

See [voice_assistant_v4_phase8_quality_analytics_queries.sql](./voice_assistant_v4_phase8_quality_analytics_queries.sql):

- Recent call quality (24h)
- Slow STT calls (p95)
- Failed RAG by reason
- STT/TTS/runtime errors
- Barge-in cancel latency
- Lead created/skipped by reason
- Per tenant/agent volume
- Drop-off proxy (turns without close)

All queries avoid full phone output.

## Default production behavior

**Unchanged.**

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_CANARY_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
```

## Rollback

1. Keep production defaults above.
2. Revert Phase 8 files; migration 009 is additive (no rollback required for v3).
3. Deploy prior image tag (e.g. `v1.10.0`).

## Test results

| Suite | Result |
|-------|--------|
| `cd voice-bridge && npm test` | **212/212 pass** |
| `python -m pytest rag-api/tests` | **6/6 pass** |
| `node --check` on changed JS | **pass** |
| `git diff --check` | **clean** |

## Remaining risks / blockers

- DB persistence active only when canary harness sets `persistQualityToDb: true` or custom `insertFn`; production v4 rollout still Phase 9.
- Migration 009 must be applied by operator before live queries return data.
- Live AudioSocket path does not auto-flush yet — wired on canary `closeCanaryDialogueRuntime`.
- LLM-specific latency metric not separately instrumented; dialogue rollup uses STT samples as proxy until live LLM wiring.

## Next phase

**Phase 9 — Production Rollout** (flag verification, v3 rollback test, internal live QA, supervised rollout).
