# Voice Environment Setup

Copy `.env.example` to `.env` and fill only the values needed for the operation you are running.

## Developer DB Commands

Required for `npm run check:db-env`, `npm run db:migrate:voice`, `npm run db:test:voice`, and `npm run db:migrate:knowledge`:

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

Knowledge/RAG migrations also require:

```env
RAG_DB_USER=technolohit_rag_app
PRODUCTION_PGVECTOR_READY=true
```

## voice-bridge Runtime

Runtime secrets should live in the server environment, Docker Compose env files, Docker secrets, or local `voice-bridge/.env` for development.

Minimum production runtime values:

```env
VOICE_DB_HOST=10.20.0.1
VOICE_DB_PORT=5432
VOICE_DB_NAME=technolohit_growth
VOICE_DB_USER=technolohit_voice_app
VOICE_DB_PASSWORD=<strong-secret>
VOICE_DB_SSL=false
OPENAI_API_KEY=<secret>
```

Keep transcript previews off unless doing short QA:

```env
VOICE_LOG_TRANSCRIPT_PREVIEW=false
VOICE_QA_LOG_TRANSCRIPT_PREVIEW=false
```

Keep semantic RAG disabled until the RAG rollout gate is green:

```env
VOICE_RAG_ENABLED=false
```

## Not Part Of This Repo

Do not add n8n deploy secrets, Google Places keys, Google Sheet IDs, Telegram bot tokens, or Growth Console webhook secrets here. Those belong to the separate Growth/Content automation projects.
