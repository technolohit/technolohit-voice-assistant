# Voice Bridge Docker Hub Cloud Test Sysadmin Report

Date: 2026-05-20

## Purpose

Deploy and test the new TechnoloHit `voice-bridge` Docker image from Docker Hub on the cloud server, using the exact image built for the live-call runtime quality fix.

This is a voice-bridge-only test. Do not change Asterisk, Easybell SIP credentials, dialplan, Postgres schema, n8n, monitoring rules, CRM, Botinteg, or notification workflows.

## Image Built And Pushed

Docker Hub repository:

```text
thnhit/technhvoice
```

Latest image for the v1.1 live-call quality retest:

```text
thnhit/technhvoice:voice-bridge-live-call-runtime-fix-v1-1-20260520-234814@sha256:c2381081685cb5ad24575d89bc01325daadff3b1135a6d58bc0d444992987dc5
```

Use this v1.1 image for the next cloud test. It includes improved callback, telephone-assistant, human/AI matching, shorter technology response, and less repetitive max-turn closing.

Latest image for the Soft Intake v1 retest:

```text
thnhit/technhvoice:voice-bridge-soft-intake-v1-20260521-002303@sha256:3be22736a5ededab0a66fa6a5d0e5a44ab070cfa2aa66972364b026ad002a9ba
```

Use this Soft Intake image when testing the email/phone contact-preference handoff flow.

Recommended exact image for cloud testing:

```text
thnhit/technhvoice:voice-bridge-live-call-runtime-fix-v1-20260520-232203@sha256:dff8ae7db08974bbd5446087fd3e638806191735c904499258df1fe90cecf56d
```

The older v1 image above is kept for reference and rollback comparison.

Tags pushed:

```text
thnhit/technhvoice:voice-bridge-live-call-runtime-fix-v1-20260520-232203
thnhit/technhvoice:voice-bridge-85dbb09
thnhit/technhvoice:voice-bridge-latest
```

All three tags point to this digest:

```text
sha256:dff8ae7db08974bbd5446087fd3e638806191735c904499258df1fe90cecf56d
```

Use the recommended tag with digest for this test so the server pulls exactly the intended image.

## What This Image Contains

Main runtime changes:

- short greeting
- regenerated `/app/audio/greeting.slin`
- adaptive caller turn listening
- deterministic templates for pricing, SEO guarantee, smart website, voice assistant, email campaign caller, human/AI, callback, free assessment, technology, and English
- less aggressive LLM fallback
- privacy-safe QA metadata and redacted transcript previews by default

Container sanity check already performed locally:

```text
node --check src/config.js PASS
node --check src/index.js PASS
node --check src/turn-assistant.js PASS
/app/audio/greeting.slin present, about 94.5K
/app/audio/greeting.wav present, about 283.6K
/app/knowledge/technolohit.md present
BUILD_VERSION=85dbb09
```

## Server Prerequisites

Expected server compose directory:

```bash
/opt/technolohit-voice/asterisk
```

Expected container name:

```text
technolohit-voice-bridge
```

Expected compose files:

```text
docker-compose.yml
docker-compose.prod.yml
```

`docker-compose.prod.yml` should make `voice-bridge` use an image instead of a local build, similar to:

```yaml
services:
  voice-bridge:
    image: ${VOICE_BRIDGE_IMAGE:-thnhit/technhvoice:voice-bridge-latest}
    build: null
```

Runtime secrets must stay on the server in env files, Docker secrets, or the server environment. Do not put secrets into the image or into this repo.

## Step 1: Record Current State

Run on the cloud server before changing anything:

```bash
cd /opt/technolohit-voice/asterisk

docker inspect technolohit-voice-bridge --format 'current_image={{.Config.Image}} image_id={{.Image}}' || true
docker ps --filter name=technolohit-voice-bridge
docker logs --tail=80 technolohit-voice-bridge || true
```

Save the current image value somewhere safe for rollback.

## Step 2: Confirm Required Runtime Env

Check the effective runtime env without printing secrets:

```bash
docker exec technolohit-voice-bridge sh -lc 'printenv | sort | egrep "^(VOICE_ASSISTANT|VOICE_TURN|VOICE_GREETING|VOICE_LOG_TRANSCRIPT_PREVIEW|BUILD_VERSION|IMAGE_TAG)=" || true'
```

Recommended values for this test:

```env
VOICE_ASSISTANT_ENABLED=true
VOICE_TURN_LISTEN_SECONDS=5
VOICE_ASSISTANT_MIN_LISTEN_MS=2500
VOICE_ASSISTANT_MAX_LISTEN_MS=10000
VOICE_ASSISTANT_END_SILENCE_MS=900
VOICE_ASSISTANT_MAX_RESPONSE_CHARS=180
VOICE_ASSISTANT_MAX_RESPONSE_SENTENCES=2
VOICE_ASSISTANT_MAX_TURNS=3
VOICE_ASSISTANT_END_ON_SILENCE=true
VOICE_ASSISTANT_MIN_TRANSCRIPT_CHARS=5
VOICE_LOG_TRANSCRIPT_PREVIEW=false
VOICE_GREETING_MODE=file
VOICE_GREETING_FILE=/app/audio/greeting.slin
```

Do not print or copy `OPENAI_API_KEY`, `VOICE_DB_PASSWORD`, or other secrets into tickets/reports.

## Step 3: Pull The Exact Image

Run:

```bash
cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE='thnhit/technhvoice:voice-bridge-live-call-runtime-fix-v1-20260520-232203@sha256:dff8ae7db08974bbd5446087fd3e638806191735c904499258df1fe90cecf56d'

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
```

For the latest v1.1 retest, use:

```bash
export VOICE_BRIDGE_IMAGE='thnhit/technhvoice:voice-bridge-live-call-runtime-fix-v1-1-20260520-234814@sha256:c2381081685cb5ad24575d89bc01325daadff3b1135a6d58bc0d444992987dc5'

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
```

Expected: Docker pulls `thnhit/technhvoice` and resolves digest `sha256:dff8ae7db08974bbd5446087fd3e638806191735c904499258df1fe90cecf56d`.

If the server Docker/Compose version has trouble with `tag@digest`, use the tag-only fallback:

```bash
export VOICE_BRIDGE_IMAGE='thnhit/technhvoice:voice-bridge-live-call-runtime-fix-v1-20260520-232203'
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
```

Then verify the digest after pull:

```bash
docker image inspect thnhit/technhvoice:voice-bridge-live-call-runtime-fix-v1-20260520-232203 --format '{{json .RepoDigests}}'
```

## Step 4: Restart Only voice-bridge

Run:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

Do not restart Asterisk unless there is a separate operational reason. This test is for the voice-bridge image only.

## Step 5: Verify The Running Container

Run:

```bash
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}} image_id={{.Image}}'
docker exec technolohit-voice-bridge sh -lc 'printenv BUILD_VERSION; ls -lah /app/audio /app/knowledge'
docker exec technolohit-voice-bridge sh -lc 'node --check src/config.js && node --check src/index.js && node --check src/turn-assistant.js'
docker logs --tail=160 technolohit-voice-bridge | egrep -i 'startup|voice-assistant|greeting|ERROR|WARNING' || true
```

Expected:

```text
BUILD_VERSION=85dbb09
/app/audio/greeting.slin about 94.5K
/app/audio/greeting.wav about 283.6K
/app/knowledge/technolohit.md present
[voice-assistant] assistant enabled ... min_listen_ms=2500 max_listen_ms=10000 end_silence_ms=900 ...
[voice-bridge] sending greeting (file: /app/audio/greeting.slin)
```

Expected privacy behavior:

```text
caller_transcript_preview=<redacted>
response_preview=<redacted>
```

unless `VOICE_LOG_TRANSCRIPT_PREVIEW=true` is intentionally enabled for controlled debugging.

## Step 6: Manual Live-Call Tests

Place real inbound calls and speak after the short greeting.

| Scenario | Caller phrase | Expected assistant behavior |
|---|---|---|
| Greeting | wait for greeting | Short greeting only: `Hallo, hier ist der digitale Assistent von TechnoloHit. Wobei kann ich Ihnen helfen?` |
| Smart Website | `Ich interessiere mich für Ihre intelligente Website.` | Short explanation and asks business type |
| Pricing | `Was kostet eine Webseite?` | No exact price, says it depends on scope and offers first assessment |
| SEO guarantee | `Können Sie mich auf Platz eins bei Google bringen?` | No ranking guarantee template |
| Voice assistant | `Kann ich so einen Telefonassistenten bekommen?` | Says yes as part of the solution, no overpromise |
| Email campaign | `Ich habe Ihre E-Mail bekommen.` | Routes to email campaign template |
| Human/AI | `Sind Sie ein Mensch?` | `Ich bin der digitale Assistent von TechnoloHit.` |
| Partial STT | `Können Sie mich auf...` | Does not hallucinate; either asks short clarification or detects SEO signal |
| English | `Can you help me in English?` | German-only response asking for the concern in German |
| Voice assistant v1.1 | `Kann ich so einen Telefonassistenten wie du haben für mein Unternehmen?` | `voice_assistant_question`, template response, no LLM |
| Callback v1.1 | `Können Sie mich morgen zurückrufen?` | `callback_request`, asks when tomorrow fits, no LLM |
| Human/AI v1.1 | `Sehen Sie einen Mensch?` | `human_or_ai_question`, transparent digital assistant response |

Listen for:

- caller is not cut off at exactly 5 seconds
- assistant answers are short
- key intents use deterministic responses
- no long marketing paragraphs
- no exact prices
- no ranking guarantees
- email campaign caller is handled directly

## Step 7: Log Checks During Live Calls

Run:

```bash
docker logs -f technolohit-voice-bridge | egrep -i 'voice-assistant|greeting|turn timings|conversation finished|ERROR|WARNING'
```

Expected examples:

```text
[voice-assistant] listening for caller turn=1 min_listen_ms=2500 max_listen_ms=10000 end_silence_ms=900
[voice-assistant] response created ... used_template_response=true used_llm_response=false ...
[voice-assistant] turn timings ... speech_end_detected=... audio_bytes_captured=...
[voice-assistant] conversation finished reason=...
```

## Step 8: SQL QA Queries

Run against the existing `technolohit_growth` database.

Latest turn transcript pairs:

```sql
SELECT cs.external_call_id,
       ct.speaker,
       ct.sequence_number,
       ct.metadata->>'turn_index' AS turn_index,
       ct.metadata->>'detected_intent' AS intent,
       ct.metadata->>'transcript_quality' AS quality,
       ct.metadata->>'used_template_response' AS template,
       ct.metadata->>'used_llm_response' AS llm,
       ct.metadata->>'used_clarification_fallback' AS clarification,
       length(ct.text) AS text_len,
       left(ct.text, 250) AS text_preview,
       ct.created_at
FROM voice.call_transcripts ct
JOIN voice.call_sessions cs ON cs.id = ct.call_session_id
WHERE ct.metadata->>'transcript_scope' = 'turn'
ORDER BY ct.created_at DESC
LIMIT 30;
```

Timing/relevance events:

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
  'turn_failed',
  'conversation_finished'
)
ORDER BY ce.occurred_at DESC
LIMIT 30;
```

Greeting event check:

```sql
SELECT cs.external_call_id,
       ce.occurred_at,
       ce.payload->>'greeting_type' AS greeting_type,
       ce.payload->>'greeting_file' AS greeting_file,
       ce.payload->>'greeting_source' AS greeting_source,
       ce.payload
FROM voice.call_events ce
JOIN voice.call_sessions cs ON cs.id = ce.call_session_id
WHERE ce.event_type = 'greeting_played'
ORDER BY ce.occurred_at DESC
LIMIT 10;
```

## Rollback

Use the image recorded in Step 1.

Example:

```bash
cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE='<previous-image-from-step-1>'

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
docker logs --tail=120 technolohit-voice-bridge
```

No database rollback is required for this image-only change.

## Notes For Reporting Back

Please report:

- exact `running_image` from `docker inspect`
- whether `BUILD_VERSION=85dbb09`
- whether `/app/audio/greeting.slin` is about `94.5K`
- whether live greeting is short
- for each live-call scenario: pass/fail and the observed intent from SQL metadata
- any `ERROR` or `WARNING` log lines from `technolohit-voice-bridge`

Do not include secrets, full caller phone numbers, OpenAI keys, DB passwords, or sensitive caller data in reports.
