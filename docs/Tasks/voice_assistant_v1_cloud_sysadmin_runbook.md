# Voice Assistant v1 Cloud Run/Test Runbook (Sysadmin)

## Purpose

Deploy and verify the latest `voice-bridge` conversation-quality update on the cloud server without changing Asterisk dialplan, DB schema, or external workflow integrations.

## Released Image

- Immutable tag: `thnhit/technhvoice:voice-bridge-85dbb09`
- Convenience tag: `thnhit/technhvoice:voice-bridge-latest`
- Digest: `sha256:22c4a3d9dc74fe8a530c668ca5931b29867378c74d4e8c6b59b6f71a5d65dce0`

Use the immutable tag for production pinning.

## Scope of This Release

- Improved German assistant knowledge base and safer phone wording.
- Improved deterministic template intents (pricing, SEO guarantee, identity, technology, callback, English caller handling).
- Added privacy-safe assistant log preview control:
  - `VOICE_LOG_TRANSCRIPT_PREVIEW=false` (recommended default).

No migration, no `voice.leads` writes, no `voice.call_summaries` writes, no n8n/Botinteg/CRM integration.

## Prerequisites

- Docker and Docker Compose working on server.
- Existing voice stack directory (example): `/opt/technolohit-voice/asterisk`
- Existing compose files:
  - `docker-compose.yml`
  - `docker-compose.prod.yml` (image override mode for `voice-bridge`)
- Runtime env for `voice-bridge` already present (DB/OpenAI settings as used today).

## 1) Deploy the New Image

```bash
cd /opt/technolohit-voice/asterisk

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-85dbb09 \
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-85dbb09 \
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## 2) Runtime Config Recommendation

In server env (do not commit):

```env
VOICE_LOG_TRANSCRIPT_PREVIEW=false
```

Recommended assistant settings if assistant mode is enabled:

```env
VOICE_ASSISTANT_ENABLED=true
VOICE_TURN_LISTEN_SECONDS=5
VOICE_ASSISTANT_MAX_TURNS=3
VOICE_ASSISTANT_MAX_RESPONSE_SENTENCES=2
VOICE_ASSISTANT_MAX_RESPONSE_CHARS=180
VOICE_ASSISTANT_END_ON_SILENCE=true
VOICE_ASSISTANT_MIN_TRANSCRIPT_CHARS=5
```

If you changed env values, restart the service:

```bash
VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-85dbb09 \
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## 3) Basic Post-Deploy Verification

```bash
docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'
docker logs --tail=120 technolohit-voice-bridge
docker exec technolohit-voice-bridge sh -lc 'ls -lah /app/knowledge /app/audio || true'
```

Expected:

- Running image equals `thnhit/technhvoice:voice-bridge-85dbb09`.
- Startup logs show normal bridge startup and assistant config line (including `log_preview=false` when configured).
- `knowledge/technolohit.md` exists in container.

## 4) Telephony Path Verification (Cloud)

Perform one inbound test call and verify:

1. Call reaches Asterisk/Easybell path as usual.
2. Greeting plays.
3. Assistant response style is short/natural German.
4. Pricing question does not return exact numbers.
5. SEO guarantee question is denied safely.
6. Identity question returns digital assistant disclosure.
7. For unknown technical/legal questions, assistant uses safe handoff fallback.

Check logs:

```bash
docker logs --tail=200 technolohit-voice-bridge
```

With `VOICE_LOG_TRANSCRIPT_PREVIEW=false`, assistant preview fields should be redacted (no caller text content in preview fields).

## 5) Suggested Manual Test Calls

Use these caller prompts:

1. `Ich interessiere mich für Ihre intelligente Website.`
2. `Was kostet so eine Website?`
3. `Können Sie mich auf Platz 1 bei Google bringen?`
4. `Kann ich so einen Telefonassistenten für mein Unternehmen bekommen?`
5. `Welche Technik steckt dahinter?`
6. `Can you help me in English?`
7. `Sind Sie ein Mensch?`

Expected patterns:

- Short, calm, German responses.
- No exact prices.
- No ranking guarantees.
- No claim to be human.
- Unknown details routed to team callback handoff.

## 6) Database Spot Check (Optional)

Run against `voice` schema to confirm call lifecycle still persists:

```sql
SELECT id, external_call_id, status, started_at, ended_at
FROM voice.call_sessions
ORDER BY created_at DESC
LIMIT 5;

SELECT ce.occurred_at, ce.event_type, ce.payload
FROM voice.call_events ce
JOIN voice.call_sessions cs ON cs.id = ce.call_session_id
WHERE cs.external_call_id LIKE 'bridge:%'
ORDER BY ce.occurred_at DESC
LIMIT 20;
```

## 7) Rollback

Use previous immutable tag:

```bash
cd /opt/technolohit-voice/asterisk

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-<previous-sha> \
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-<previous-sha> \
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

No DB rollback needed for this release.

## 8) Boundaries

For this release, do not change:

- Asterisk dialplan
- Easybell credentials
- Postgres schema/migrations
- n8n workflows
- CRM/Botinteg integrations

