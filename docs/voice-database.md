# TechnoloHit Voice Assistant — PostgreSQL foundation

This document describes the **voice** schema inside the existing **`technolohit_growth`** database on **`central_postgres`**. It is separate from the Growth Console **`growth`** schema and does not modify Growth n8n workflows.

## Architecture (approved)

| Item | Value |
|------|--------|
| Postgres container | `central_postgres` (existing) |
| Database | `technolohit_growth` (existing — **no new database**) |
| New schema | `voice` |
| App DB role | From `.env`: `VOICE_DB_USER` / `VOICE_DB_PASSWORD` |
| Growth schema | **Not modified** by voice migrations |
| Redis | Not used |
| Repo on production server | **Not required** — SQL runs from your dev machine via SSH |

Connection path for the voice app (later): same host as n8n over WireGuard (`10.20.0.1:5432`), database `technolohit_growth`, schema `voice`, user `VOICE_DB_USER`.

Infra (Docker Compose, firewall, WireGuard) stays in **infra-ansible**; DDL stays in **this repo**.

## Repository layout

| Path | Purpose |
|------|---------|
| `db/voice/migrations/001_voice_schema.sql` | Schema, tables, indexes, `updated_at` triggers |
| `db/voice/migrations/002_voice_grants.sql` | Least-privilege grants only (no `CREATE ROLE`, no passwords) |
| `db/voice/migrations/003_voice_bridge_session_fields.sql` | `language`, `duration_seconds`, status `active` |
| `db/voice/migrations/004_call_transcript_post_call_fields.sql` | Post-call transcript compatibility fields (`text`, `sequence_number`, `is_final`, `metadata`) |
| `db/voice/migrations/005_lead_dashboard_tables.sql` | Internal Lead Dashboard audit and follow-up status tables |
| `voice-bridge/` | AudioSocket service + runtime persistence (`src/db.js`) |
| `scripts/db-migrate-voice-postgres.js` | Create/update role + apply migrations remotely |
| `scripts/db-test-voice-postgres.js` | Smoke test (DML + grant check) |

## Tables (schema `voice`)

| Table | Purpose |
|-------|---------|
| `call_sessions` | One row per call / voice session (`external_call_id` unique; voice-bridge uses `bridge:<uuid>` generated in Node, with Asterisk AudioSocket UUID in `metadata.audiosocket_uuid`) |
| `call_events` | Timeline events for a session |
| `call_transcripts` | Transcript segments |
| `leads` | Captured leads with match keys for future CRM / `growth.prospects` |
| `call_summaries` | Post-call summaries |
| `lead_access_audit` | Internal Lead Dashboard audit events for reveal/status actions |
| `lead_followup_status` | Internal Lead Dashboard callback follow-up state |

### Lead matching (future linking)

`voice.leads` includes optional `growth_prospect_id` (text, no FK yet) plus:

- `normalized_domain`
- `normalized_phone`
- `email`
- `company_name`
- `city`
- `country` (`DE` / `AT` / `CH`)

These align with Growth prospect identity fields so a later job can link or merge without schema changes today.

## Security model

1. **Committed SQL never contains passwords** or `CREATE ROLE ... PASSWORD '...'`.
2. **`npm run db:migrate:voice`** creates or updates the role using `VOICE_DB_USER` / `VOICE_DB_PASSWORD` from `.env` (admin session over SSH only).
3. **`002_voice_grants.sql`** grants **only** schema `voice` and explicitly **revokes** access to schema `growth`.

## Environment variables

Add to `.env` on your developer machine (see `.env.example`):

```env
DB_SSH_HOST=85.215.211.72
DB_SSH_USER=moji
DB_SSH_PORT=22
DB_SSH_KEY_PATH=~/.ssh/id_ed25519
DB_DOCKER_CONTAINER=central_postgres
DB_NAME=technolohit_growth
DB_ADMIN_USER=postgres

VOICE_DB_USER=technolohit_voice_app
VOICE_DB_PASSWORD=<strong-secret>
```

Validate SSH settings (no voice password printed):

```bash
npm run check:db-env
```

## Commands

| Command | What it does |
|---------|----------------|
| `npm run db:migrate:voice` | SSH → `docker exec psql`: create/update `VOICE_DB_USER`, apply `db/voice/migrations/*.sql` in order |
| `npm run db:test:voice` | Smoke test: tables exist, role cannot read `growth`, insert/select/delete on `voice` |

Typical first-time flow:

```bash
npm run check:db-env
npm run db:migrate:voice
npm run db:test:voice
```

Optional: `DB_USE_SCP=true` pipes via remote `/tmp` like growth migrations.

## What the smoke test verifies

1. Role `VOICE_DB_USER` exists in Postgres.
2. Schema `voice` contains all five tables.
3. `has_schema_privilege` / `has_table_privilege` confirm the voice role has **no** access to schema `growth` or `growth.prospects`.
4. Under the same role: insert `call_sessions`, insert related `call_events`, join-select, delete session (cascade removes events).
5. No passwords or secrets in console output.

## Migration details

### `001_voice_schema.sql`

- `CREATE EXTENSION IF NOT EXISTS pgcrypto` (UUID generation)
- `CREATE SCHEMA IF NOT EXISTS voice`
- Tables + indexes + `voice.set_updated_at()` triggers on `call_sessions`, `leads`, `call_summaries`

### `002_voice_grants.sql`

- Uses psql variable **`voice_db_user`** (passed by the migrate script as `-v voice_db_user=<VOICE_DB_USER>`)
- `GRANT CONNECT` on database `technolohit_growth`
- DML on `voice` tables/sequences + default privileges
- `REVOKE` on `growth` schema/objects

Re-running `001` on an existing schema is mostly idempotent (`IF NOT EXISTS`). Re-running `002` is safe (grants are reapplied).

### `004_call_transcript_post_call_fields.sql`

Adds post-call transcription fields to `voice.call_transcripts` so post-call STT can store final caller transcripts and metadata without touching `growth` or n8n workflows.

## Assumptions

- PostgreSQL admin user `DB_ADMIN_USER` (default `postgres`) can `CREATE ROLE` and `CREATE SCHEMA`.
- Database `technolohit_growth` already exists (Growth Console).
- SSH access to the monitoring host and `docker exec` into `central_postgres` work (same as `npm run db:migrate:postgres`).
- Voice app runtime will use `VOICE_DB_USER` only — not the n8n `technolohit_growth_n8n` role.
- `crm`, `content`, and `analytics` schemas are **out of scope** for this phase.

## voice-bridge runtime

The **voice-bridge** service writes call lifecycle rows using `VOICE_DB_HOST` / `VOICE_DB_*` (not SSH). See [voice-bridge/README.md](../voice-bridge/README.md).

Production voice-bridge deploys should use Docker Hub image tags from `thnhit/technhvoice` instead of copying source folders. See [dockerhub-voice-deploy.md](./dockerhub-voice-deploy.md). Runtime DB credentials stay outside the image.

Each TCP call gets a unique `external_call_id` of the form `bridge:<randomUUID>` so duplicate Asterisk AudioSocket UUIDs (e.g. a static placeholder) do not violate the unique index. The wire UUID is stored separately as `metadata.audiosocket_uuid` (and in event payloads as `audiosocket_uuid`).

Turn-based assistant responses are stored as `voice.call_transcripts` rows with `metadata->>'transcript_scope' = 'turn'`. Assistant rows include safe JSONB metadata such as `detected_intent`, `transcript_quality`, `used_template_response`, `used_llm_response`, `response_chars`, `used_clarification_fallback`, `used_relevance_fallback`, product flow fields (`product_flow_state`, `product_interest`, `product_interest_name`), `knowledge_source`, `knowledge_version`, `assistant_model`, and `turn_index`; this uses the existing metadata column and requires no schema migration.

Soft Intake uses a reception-first lead marker. Milestones are stored in JSONB metadata/events, and one lightweight `voice.leads` row is written when the caller chooses direct email or when the caller requests a callback, provides a phone number, and grants permission. Email addresses are not captured by voice; email callers are directed to `info@technolohit.com`. After a final intake outcome (`email_direct`, permission granted, permission denied, or fallback), the assistant ends its turn loop instead of asking another max-turn callback question. No `voice.call_summaries`, n8n notifications, CRM writes, or caller-ID assumptions are added.

Runtime QA event payloads include bounded timing and relevance fields such as `listen_duration_ms`, `speech_end_detected`, `audio_bytes_captured`, `response_chars`, and `playback_ms`. Transcript and response previews are redacted in logs/events by default unless `VOICE_LOG_TRANSCRIPT_PREVIEW=true`.

Inspect latest caller/assistant turn pairs:

```sql
SELECT cs.external_call_id,
       ct.speaker,
       ct.sequence_number,
       ct.metadata->>'turn_index' AS turn_index,
       ct.metadata->>'transcript_scope' AS scope,
       ct.metadata->>'detected_intent' AS intent,
       ct.metadata->>'transcript_quality' AS quality,
       ct.metadata->>'used_template_response' AS template,
       ct.metadata->>'used_llm_response' AS llm,
       ct.metadata->>'used_clarification_fallback' AS clarification,
       ct.metadata->>'contact_route' AS contact_route,
       ct.metadata->>'contact_preference_detected' AS contact_preference,
       ct.metadata->>'email_direct_offered' AS email_direct_offered,
       ct.metadata->>'contact_permission_granted' AS permission_granted,
       ct.metadata->>'soft_intake_lead_created' AS lead_created,
       ct.metadata->>'soft_intake_state' AS soft_intake_state,
       ct.metadata->>'product_flow_state' AS product_flow_state,
       ct.metadata->>'product_interest' AS product_interest,
       ct.metadata->>'product_interest_name' AS product_interest_name,
       length(ct.text) AS text_len,
       left(ct.text, 300) AS text_preview,
       ct.metadata,
       ct.created_at
FROM voice.call_transcripts ct
JOIN voice.call_sessions cs ON cs.id = ct.call_session_id
WHERE ct.metadata->>'transcript_scope' = 'turn'
ORDER BY ct.created_at DESC
LIMIT 30;
```

Inspect timing and relevance events:

```sql
SELECT cs.external_call_id,
       ce.event_type,
       ce.payload,
       ce.occurred_at
FROM voice.call_events ce
JOIN voice.call_sessions cs ON cs.id = ce.call_session_id
WHERE ce.event_type IN (
  'turn_transcribed',
  'assistant_response_created',
  'assistant_response_played',
  'soft_intake_started',
  'contact_preference_requested',
  'contact_preference_detected',
  'contact_detail_requested',
  'soft_intake_email_directed',
  'soft_intake_lead_created',
  'contact_permission_requested',
  'contact_permission_granted',
  'contact_permission_denied',
  'soft_intake_declined',
  'turn_failed',
  'conversation_finished'
)
ORDER BY ce.occurred_at DESC
LIMIT 30;
```

Inspect latest reception-first lead markers:

```sql
SELECT cs.external_call_id,
       vl.id AS lead_id,
       vl.source,
       vl.status,
       vl.normalized_phone,
       vl.metadata->>'contact_route' AS contact_route,
       vl.metadata->>'contact_preference' AS contact_preference,
       vl.metadata->>'email_direct_to' AS email_direct_to,
       vl.metadata->>'no_voice_email_capture' AS no_voice_email_capture,
       vl.metadata->>'contact_permission_granted' AS permission_granted,
       vl.created_at
FROM voice.leads vl
JOIN voice.call_sessions cs ON cs.id = vl.call_session_id
ORDER BY vl.created_at DESC
LIMIT 20;
```

No schema migration is required for assistant-quality metadata changes when `call_transcripts.metadata` already exists. For a fresh voice deployment, apply the normal voice migrations first:

```bash
npm run db:migrate:voice
```

## Related docs

- [db/README.md](../db/README.md) — Growth schema migrations
- [postgres-setup.md](./postgres-setup.md) — n8n Postgres credential
- [postgres-migration.md](./postgres-migration.md) — Growth Console cutover
- [voice-bridge/README.md](../voice-bridge/README.md) — deploy and test one call
