# Voice schema migrations

SQL source of truth for schema **`voice`** in database **`technolohit_growth`**.

| File | Purpose |
|------|---------|
| `migrations/001_voice_schema.sql` | Tables, indexes, triggers |
| `migrations/002_voice_grants.sql` | Grants for `VOICE_DB_USER` (psql variable `voice_db_user`) |
| `migrations/003_voice_bridge_session_fields.sql` | `language`, `duration_seconds`, status `active` |

Apply from your developer machine:

```bash
npm run db:migrate:voice
npm run db:test:voice
```

See [docs/voice-database.md](../../docs/voice-database.md).
