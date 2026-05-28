# Sysadmin Guide - Voice Bridge Soft Intake Turn Budget v1

## Release Image
- Docker repo: `thnhit/technhvoice`
- Immutable release tag: `voice-bridge-soft-intake-turn-budget-v1-20260521-005742`
- Convenience tag: `voice-bridge-latest`
- SHA tag: `voice-bridge-85dbb09`
- Digest: `sha256:5563cf362ee7417c340ec45a07cc7d23b60f8c9609387f069b8ba514845a1d4c`

Recommended production pin:
- `thnhit/technhvoice@sha256:5563cf362ee7417c340ec45a07cc7d23b60f8c9609387f069b8ba514845a1d4c`

## Deploy (Cloud Server)
```bash
cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE='thnhit/technhvoice@sha256:5563cf362ee7417c340ec45a07cc7d23b60f8c9609387f069b8ba514845a1d4c'

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## Verify Running Image
```bash
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}} image_id={{.Image}}'
```

Expected:
- `running_image` should be the digest-pinned image (or the exact release tag if tag mode is used).
- `image_id` should match `sha256:5563cf362ee7417c340ec45a07cc7d23b60f8c9609387f069b8ba514845a1d4c`.

## Safe Log Viewing
Prefer scoped logs for fresh test windows; do not delete data volumes.

```bash
# Last 5 minutes live tail (recommended)
docker logs --since=5m -f technolohit-voice-bridge

# Snapshot of recent lines
docker logs --since=10m --tail=200 technolohit-voice-bridge
```

If you need a clean log window for a new test run, recreate only the service container:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate voice-bridge
```

## SQL QA Queries
Run in Postgres after test calls:

```sql
SELECT cs.external_call_id,
       ct.speaker,
       ct.sequence_number,
       ct.metadata->>'turn_index' AS turn_index,
       ct.metadata->>'detected_intent' AS intent,
       ct.metadata->>'soft_intake_state' AS soft_intake_state,
       ct.metadata->>'soft_intake_waiting_for' AS waiting_for,
       ct.metadata->>'contact_detail_type' AS detail_type,
       ct.metadata->>'contact_detail_attempted' AS detail_attempted,
       ct.metadata->>'contact_permission_requested' AS permission_requested,
       ct.metadata->>'contact_permission_granted' AS permission_granted,
       ct.metadata->>'max_turns_extended_for_intake' AS max_turns_extended,
       ct.metadata->>'max_turns_blocked_by_active_intake' AS max_turns_blocked,
       ct.metadata->>'used_template_response' AS template,
       ct.metadata->>'used_llm_response' AS llm,
       length(ct.text) AS text_len,
       left(ct.text, 250) AS text_preview,
       ct.created_at
FROM voice.call_transcripts ct
JOIN voice.call_sessions cs ON cs.id = ct.call_session_id
WHERE ct.metadata->>'transcript_scope' = 'turn'
ORDER BY ct.created_at DESC
LIMIT 60;
```

```sql
SELECT cs.external_call_id,
       ce.event_type,
       ce.payload,
       ce.occurred_at
FROM voice.call_events ce
JOIN voice.call_sessions cs ON cs.id = ce.call_session_id
WHERE ce.event_type IN (
  'soft_intake_started',
  'contact_preference_requested',
  'contact_preference_detected',
  'contact_detail_requested',
  'contact_permission_requested',
  'contact_permission_granted',
  'contact_permission_denied',
  'soft_intake_declined',
  'assistant_response_created',
  'conversation_finished'
)
ORDER BY ce.occurred_at DESC
LIMIT 80;
```

## Manual Live-Call Scenarios
1. **Email path waiting**
   - Caller: "Was kostet eine Website?" -> "Per E-Mail bitte."
   - Assistant should ask email and wait for next caller turn.
   - After caller gives email-like detail, assistant asks permission.

2. **Phone path waiting**
   - Caller: "Telefonisch bitte."
   - Assistant asks phone number and waits for next caller turn.
   - After phone-like detail, assistant asks permission.

3. **Permission protected**
   - After permission question, caller says "Ja, gerne."
   - Assistant: "Danke. Ich gebe Ihre Anfrage an unser Team weiter."
   - Must not jump to generic max-turn close before this answer.

4. **Refusal**
   - Caller: "Ich möchte keine Daten angeben."
   - Assistant gives `info@technolohit.com` fallback, no pressure.

5. **Turn-cap protection**
   - Force scenario near turn 3 while intake is still active.
   - Assistant must not end with callback-time ask before detail/permission handling.

## Success Criteria
- After email question, next caller turn is treated as detail answer turn.
- After phone question, next caller turn is treated as detail answer turn.
- Permission question always receives one answer turn before closure.
- Active soft intake is protected from normal `max_turns=3` cutoff.
- Intake-safe close texts are used if detail/permission remains missing.
- DB metadata shows intake waiting fields and max-turn intake flags.

## Failure Criteria
- Assistant asks for email/phone and immediately closes before caller can answer.
- Generic callback-time close appears while detail/permission is still missing.
- Permission answer turn is skipped.
- No intake metadata/flags appear in transcript/event payloads.

## Rollback
Use previous known-good immutable image:

```bash
cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE='thnhit/technhvoice:<PREVIOUS_IMMUTABLE_TAG_OR_DIGEST>'

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge

docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}} image_id={{.Image}}'
```

Do not delete recordings, DB rows, or volumes for rollback.
