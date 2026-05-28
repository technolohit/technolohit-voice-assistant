# TechnoloHit Voice Assistant

This repository is the standalone source of truth for the live TechnoloHit phone assistant.

It contains:

- `asterisk/` - Easybell/Asterisk image inputs and production override.
- `voice-bridge/` - AudioSocket TCP service, assistant runtime, recording, STT/TTS, post-call processing.
- `rag-api/` - optional pgvector-backed retrieval service.
- `db/voice/` - PostgreSQL schema `voice` migrations.
- `db/knowledge/` - PostgreSQL schema `knowledge` migrations for RAG.
- `scripts/docker/` - voice-bridge image build/push/release helpers.

It intentionally does not contain n8n Growth Console workflows, Google Places prospect research, Google Sheet automation, LinkedIn/content workflows, or outreach-preparation schemas.

## Runtime Boundary

Live call path:

```text
Easybell SIP -> Asterisk -> AudioSocket TCP -> voice-bridge -> PostgreSQL schema voice
```

The realtime phone path must not depend on n8n. n8n or CRM integrations may only be added later as async post-call consumers, never as a required live-call dependency.

The production database may still be named `technolohit_growth`, but this project owns only these schemas:

- `voice`
- `knowledge`

The `growth` schema belongs to the separate Growth Console project.

## Common Commands

```bash
npm run check:db-env
npm run db:migrate:voice
npm run db:test:voice
npm run db:migrate:knowledge
npm run docker:release:voice-bridge
npm run docker:release:rag-api
```

Run `voice-bridge` locally:

```bash
cd voice-bridge
npm install
npm start
```

Run the RAG API locally:

```bash
cd rag-api
python -m venv .venv
. .venv/Scripts/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8080
```

## Safety Rules

- Do not commit `.env`, recordings, API keys, DB passwords, SSH keys, or Docker credentials.
- Do not run destructive `growth` schema operations from this project.
- Keep `VOICE_RAG_ENABLED=false` in production until RAG QA is explicitly green.
- Pin production voice-bridge deploys to immutable Docker image tags, not only `latest`.

Operational docs:

- `voice-bridge/README.md`
- `rag-api/README.md`
- `asterisk/README.md`
- `docs/release-and-cicd.md`
- `docs/voice-database.md`
- `docs/asterisk-easybell-registration.md`
- `docs/dockerhub-voice-deploy.md`
