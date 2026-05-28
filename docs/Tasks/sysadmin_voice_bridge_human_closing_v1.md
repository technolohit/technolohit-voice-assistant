# Sysadmin Guide: Voice Assistant Human Closing v1

## Image Reference
- Repository: `thnhit/technhvoice`
- Version tag: `voice-bridge-human-closing-v1-20260521-162815`
- Digest: `sha256:f9f829df92fbcc66d2d1755d20ca8b8fa4540149a56636a50621a11059a7c5c2`

## Pull and Deploy
```bash
cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE='thnhit/technhvoice@sha256:f9f829df92fbcc66d2d1755d20ca8b8fa4540149a56636a50621a11059a7c5c2'

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## Verify Running Image
```bash
docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'
docker ps --filter name=technolohit-voice-bridge
```

## Safe Log View
```bash
TEST_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker logs --since="$TEST_START_ISO" technolohit-voice-bridge \
  | egrep -i 'turn transcribed|response created|conversation finished|soft_intake|closing|goodbye'
```

## SQL QA Queries
```bash
cd /srv/central-postgres
source .env
export QA_START_UTC="$(date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"

docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -P pager=off -c "
SELECT cs.external_call_id,
       ct.speaker,
       ct.sequence_number,
       ct.metadata->>'detected_intent' AS intent,
       ct.metadata->>'soft_intake_state' AS soft_intake_state,
       ct.metadata->>'closing_pending' AS closing_pending,
       ct.metadata->>'final_question_asked' AS final_question_asked,
       ct.metadata->>'final_goodbye_sent' AS final_goodbye_sent,
       left(ct.text, 200) AS text_preview,
       ct.created_at
FROM voice.call_transcripts ct
JOIN voice.call_sessions cs ON cs.id = ct.call_session_id
WHERE cs.created_at >= '$QA_START_UTC'::timestamptz
  AND ct.metadata->>'transcript_scope' = 'turn'
ORDER BY cs.created_at ASC, ct.sequence_number ASC;
"

docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -P pager=off -c "
SELECT cs.external_call_id,
       ce.event_type,
       ce.payload->>'soft_intake_state' AS soft_intake_state,
       ce.payload->>'closing_pending' AS closing_pending,
       ce.payload->>'final_question_asked' AS final_question_asked,
       ce.payload->>'final_goodbye_sent' AS final_goodbye_sent,
       ce.occurred_at
FROM voice.call_events ce
JOIN voice.call_sessions cs ON cs.id = ce.call_session_id
WHERE cs.created_at >= '$QA_START_UTC'::timestamptz
  AND ce.event_type IN (
    'soft_intake_started',
    'contact_preference_requested',
    'contact_preference_detected',
    'contact_detail_requested',
    'contact_permission_requested',
    'contact_permission_granted',
    'contact_permission_denied',
    'soft_intake_declined',
    'conversation_finished'
  )
ORDER BY cs.created_at ASC, ce.occurred_at ASC;
"
```

## Manual Live-Call Scenarios
1. Callback path with human closing
   - Caller asks about smart website.
   - Caller requests callback.
   - Caller provides phone and grants permission.
   - Assistant must ask: "Haben Sie noch eine weitere Frage?"
   - Caller says: "Nein, danke."
   - Assistant must say warm goodbye and end.

2. Email handoff with human closing
   - Caller asks pricing.
   - Caller says: "E-Mail, bitte."
   - Assistant must provide `info@technolohit.com` and ask final question.
   - Caller says: "Nein."
   - Assistant must say warm goodbye and end.

3. Permission declined with human closing
   - Callback path to permission question.
   - Caller says: "Nein."
   - Assistant must provide email fallback and ask final question.
   - Caller says: "Das war alles."
   - Assistant must say warm goodbye and end.

## Rollback Notes
- Revert `VOICE_BRIDGE_IMAGE` to the previous known-good digest/tag.
- Pull and restart:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```
- Verify rollback image:
```bash
docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'
```
