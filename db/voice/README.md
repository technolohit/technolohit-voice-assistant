# Voice schema migrations

SQL source of truth for schema **`voice`** in database **`technolohit_growth`**.

| File | Purpose |
|------|---------|
| `migrations/001_voice_schema.sql` | Tables, indexes, triggers |
| `migrations/002_voice_grants.sql` | Grants for `VOICE_DB_USER` (psql variable `voice_db_user`) |
| `migrations/003_voice_bridge_session_fields.sql` | `language`, `duration_seconds`, status `active` |
| `migrations/004_call_transcript_post_call_fields.sql` | Post-call transcript fields |
| `migrations/005_lead_dashboard_tables.sql` | Lead dashboard support tables |
| `migrations/006_v4_tenant_agent_session_fields.sql` | v4 `tenant_id`, `agent_id`, version fields on `call_sessions` |
| `migrations/007_v4_tenant_agent_transcripts_events.sql` | v4 tenant/agent/version on transcripts, events, summaries |
| `migrations/008_v4_leads_custom_fields.sql` | v4 `tenant_id`, `agent_id`, `custom_fields` on leads |
| `migrations/009_v4_call_quality_events.sql` | v4 usage/quality events table |

Apply from your developer machine:

```bash
npm run db:migrate:voice
npm run db:test:voice
```

See [docs/voice-database.md](../../docs/voice-database.md).
