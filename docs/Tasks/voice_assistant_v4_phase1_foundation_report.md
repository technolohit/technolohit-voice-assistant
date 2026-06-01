# TechnoloHit Voice Assistant v4 — Phase 1 Foundation Report

Date: 2026-06-01  
Status: **Ready for review** (foundation implemented; production rollout not started)  
Blueprint: [voice_assistant_v4_realtime_tenant_ready_blueprint.md](./voice_assistant_v4_realtime_tenant_ready_blueprint.md)  
Phase 0 decision: [voice_assistant_v4_phase0_decision_report.md](./voice_assistant_v4_phase0_decision_report.md)

## Objective

Build tenant-ready data/config/runtime foundation for v4 **without changing production behavior by default**.

## Files inspected

| Area | Files |
|------|-------|
| Voice schema | `db/voice/migrations/001_voice_schema.sql` … `005_lead_dashboard_tables.sql` |
| Knowledge schema | `db/knowledge/migrations/001_knowledge_schema.sql`, `002_knowledge_grants.sql` |
| Persistence | `voice-bridge/src/db.js`, `voice-bridge/src/persist.js` |
| Config/runtime | `voice-bridge/src/config.js`, `voice-bridge/src/index.js` |
| RAG | `voice-bridge/src/rag-client.js`, `rag-api/app/models.py`, `rag-api/app/retrieval.py` |
| Phase 0 spikes | `playback-session.js`, `interruption-recovery.js` (unchanged behavior; not production v4 path) |

## Files changed / added

### Database migrations

| File | Purpose |
|------|---------|
| `db/voice/migrations/006_v4_tenant_agent_session_fields.sql` | Tenant/agent/version on `call_sessions` |
| `db/voice/migrations/007_v4_tenant_agent_transcripts_events.sql` | Tenant/agent/version on transcripts, events, summaries |
| `db/voice/migrations/008_v4_leads_custom_fields.sql` | `tenant_id`, `agent_id`, `custom_fields` on leads |
| `db/voice/migrations/009_v4_call_quality_events.sql` | New quality/usage events table |
| `db/knowledge/migrations/003_knowledge_agent_scope.sql` | `agent_id` on documents + retrieval logs |

### Agent config

| File | Purpose |
|------|---------|
| `voice-bridge/config/agents/technolohit.main_voice_sales.v4.json` | Versioned TechnoloHit agent seed (no secrets) |

### v4 runtime modules

| File | Purpose |
|------|---------|
| `voice-bridge/src/v4/agent-config.js` | Load/validate agent JSON |
| `voice-bridge/src/v4/runtime-router.js` | v3 vs v4 route selection (v4 stub only) |
| `voice-bridge/src/v4/rag-scope.js` | Tenant/agent RAG payload builder |
| `voice-bridge/src/v4/persist-metadata.js` | Session/version metadata helpers |
| `voice-bridge/src/v4/quality-events.js` | Quality event payload shape |
| `voice-bridge/src/v4/audio-session.js` | Phase 2 placeholder |
| `voice-bridge/src/v4/playback-controller.js` | Phase 3 placeholder |
| `voice-bridge/src/v4/vad-endpointing.js` | Phase 2 placeholder |
| `voice-bridge/src/v4/stt-adapter.js` | Phase 2 placeholder |
| `voice-bridge/src/v4/tts-adapter.js` | Phase 2 placeholder |
| `voice-bridge/src/v4/call-session-memory.js` | Phase 4 placeholder |
| `voice-bridge/src/v4/state-machine.js` | Phase 4 placeholder |

### Integration updates

| File | Change |
|------|--------|
| `voice-bridge/src/config.js` | v4 foundation flags (default off) |
| `voice-bridge/src/db.js` | `insertCallQualityEvent()` |
| `voice-bridge/src/index.js` | Startup runtime/agent-config logging |
| `voice-bridge/src/turn-assistant.js` | RAG payload via `buildRagRetrievePayload()` |
| `voice-bridge/src/rag-sales-answerer.js` | RAG payload via `buildRagRetrievePayload()` |
| `rag-api/app/models.py` | `agent_id` on retrieve/ingest requests |
| `rag-api/app/retrieval.py` | Agent-scoped retrieval + logs |

### Tests

| File | Coverage |
|------|----------|
| `voice-bridge/tests/v4-phase1-foundation.test.js` | Config, router, agent config, RAG scope, quality events, migrations |
| `rag-api/tests/test_contract_static.py` | `agent_id` contract |

### Docs / env

| File | Change |
|------|--------|
| `docs/voice-bridge-runtime-env.md` | v4 flags documented |
| `.env.example`, `voice-bridge/.env.example` | v4 placeholders |
| `db/voice/README.md` | Migration list updated |

## Feature flags added (all default off / v3)

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_V4_STREAMING_STT_ENABLED=false
VOICE_V4_STREAMING_TTS_ENABLED=false
VOICE_TENANT_ID=technolohit
VOICE_AGENT_ID=main_voice_sales
VOICE_AGENT_CONFIG_PATH=/app/config/agents/technolohit.main_voice_sales.v4.json
```

Phase 0B/0C spike flags remain **separate and QA-only**:

```env
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=false
VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED=false
```

Production v4 playback/interruption must use `VOICE_V4_BARGE_IN_ENABLED` / `VOICE_V4_REALTIME_ENABLED` in later phases — not spike flags.

## How to apply migrations

Voice schema (from developer machine with DB SSH access):

```bash
npm run db:migrate:voice
npm run db:test:voice
```

Knowledge agent scope (requires `PRODUCTION_PGVECTOR_READY=true`):

```bash
npm run db:migrate:knowledge
```

Migrations are **forward-only** with safe defaults (`technolohit`, `main_voice_sales`). v3 runtime continues if new columns/tables exist but are unused.

## Rollback strategy

1. Keep all v4 flags off (`VOICE_RUNTIME_VERSION=v3`, `VOICE_V4_REALTIME_ENABLED=false`).
2. Redeploy last known-good voice-bridge image if needed.
3. **Do not roll back SQL** — added columns/tables are nullable/default-safe and harmless to v3.
4. Phase 0B/0C spikes remain disabled outside QA.

## Default production behavior

**Unchanged.** With default env:

- Runtime router selects **v3**
- v4 realtime path is **not active** (stub only when explicitly requested + enabled)
- Existing turn-assistant v3 flow unchanged except RAG payloads now include tenant/agent scope (backward compatible with rag-api defaults)
- No migrations applied until operator runs migrate commands

## Agent config in Docker

The `voice-bridge/Dockerfile` copies `config/` to `/app/config`, so the image includes the default seed at:

```text
/app/config/agents/technolohit.main_voice_sales.v4.json
```

Production may override via `VOICE_AGENT_CONFIG_PATH` or mount a replacement file at that path.

## Remaining production rollout blockers

These do **not** block Phase 1 foundation review but **do** block production v4 rollout:

| Blocker | Owner / note |
|---------|----------------|
| Final retention approval | **Mojtaba, Founder of TechnoloHit** |
| Backup encryption confirmation | Sysadmin |
| Dedicated QA route | Sysadmin |
| Overload fallback destination | Sysadmin |
| OpenAI streaming/realtime limits | Sysadmin + provider confirmation |

## Not accepted in Phase 1

- Production v4 rollout
- Full v4 realtime audio
- Phase 2/3/4 implementation
- Full barge-in production implementation (Phase 0 proved feasibility; production flags still off)
- SaaS/multi-tenant UI, billing, public signup

## Ready for review/commit?

**Yes** — pending test run and checklist sign-off.
