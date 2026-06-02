# TechnoloHit Voice Assistant v4 — Phase 10G Live Quality DB Flush Report

Date: 2026-06-01  
Status: **Phase 10G implemented in repo** — v4 live canary quality events flush on call end; **production v4 NOT enabled**  
Prior: [Phase 10F live barge-in report](./voice_assistant_v4_phase10f_live_barge_in_report.md)

## Objective

Persist buffered v4 live canary quality events to `voice.call_quality_events` (migration 009) on call end, using existing quality sink/persistence modules. Fail-safe, privacy-safe, v4-only — v3 calls unchanged.

## Files changed

| File | Change |
|------|--------|
| `voice-bridge/src/v4/live-quality-flush-endpoint.js` | **New** — flush gate, insert resolution, summary build |
| `voice-bridge/src/v4/live-audiosocket-handler.js` | `finishLiveCanaryCall` awaits quality flush |
| `voice-bridge/src/v4/quality-analytics.js` | `buildLiveCanaryCallQualitySummary` |
| `voice-bridge/src/v4/canary-runtime-loop.js` | Phase `phase10g_live_quality_flush` |
| `voice-bridge/src/audiosocket.js` | Await async `finishLiveCanaryCall` |
| `voice-bridge/tests/v4-phase10g-quality-flush.test.js` | **New** — Phase 10G suite |
| `docs/Tasks/voice_assistant_v4_phase8_quality_analytics_queries.sql` | Live canary summary query |
| Phase 10 test files | Phase string updates |

**Not changed:** `turn-assistant.js`, production env, `docs/Tasks/logs.txt`, migration 009 schema.

## Behavior

| Case | Result |
|------|--------|
| v3 call end | No quality flush |
| v4_canary + empty buffer | No-op (`buffer_empty`), runtime cleared |
| v4_canary + events + no DB/insertFn | Memory-only flush, safe logs |
| v4_canary + events + insertFn | Enriched insert per event + summary + `audio_session_closed` |
| DB/table/insert failure | `[v4-live] quality_flush_failed`, call/post-call continue |
| Missing `call_session_id` | Fail closed, warn, no throw |

## Enrichment (every persisted event)

Via `enrichQualityEventForPersistence`:

- `tenant_id`, `agent_id` (columns)
- `runtime_version`, `agent_config_version`, `prompt_playbook_version`, `knowledge_version` (payload)
- `call_session_id` (column)

## Per-call summary event

`live_call_quality_summary` includes:

- `live_counters`: endpoints, STT/TTS/playback/barge-in counts, duration
- `counters`, `latencies`, `errors` rollups from buffered events
- `privacy_ok` flag (no raw phone in summary payload)

## Safe logs

- `[v4-live] quality_flush_started event_count=... db_enabled=...`
- `[v4-live] quality_flush_completed inserted_count=...`
- `[v4-live] quality_flush_failed reason=...`

No secrets, raw transcript, assistant text, or full phone numbers.

## Supervised live-call QA readiness

| Phase | Requirement |
|-------|-------------|
| **10G** | Quality events persisted on canary call end |
| **10H** | Live QA runbook |

**Human PSTN QA** should start only after **10H**, with all gates + allowlist on a dedicated QA route.

## Production v4 status

**Not enabled.** Default route remains **v3**. Quality flush runs only on gated `v4_canary` path when DB insert function is available.
