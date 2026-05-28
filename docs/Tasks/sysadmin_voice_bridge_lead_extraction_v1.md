# Sysadmin Guide: Voice Bridge Lead Extraction v1

Date: 2026-05-21

## Purpose

Verify Phase 6 lead extraction/enrichment behavior after post-call summary generation.

## Required Flags

```env
VOICE_POST_CALL_SUMMARY_ENABLED=true
VOICE_POST_CALL_LEAD_EXTRACTION_ENABLED=true
```

## Deploy

```bash
cd /opt/technolohit-voice/asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## Log Checks

```bash
docker logs --since=20m technolohit-voice-bridge \
| egrep -i 'voice-summary|voice-lead|post_call_summary|post_call_lead|ERROR|WARNING' || true
```

Expected lines:

```text
[voice-summary] post-call summary created summary_id=...
[voice-lead] post-call lead action=created|updated|skipped reason=... lead_id=...
```

## SQL Checks

### Recent post-call lead events

```bash
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -P pager=off -c "
SELECT cs.external_call_id,
       ce.event_type,
       ce.payload->>'action' AS action,
       ce.payload->>'reason' AS reason,
       ce.payload->>'lead_id' AS lead_id,
       ce.occurred_at
FROM voice.call_events ce
JOIN voice.call_sessions cs ON cs.id = ce.call_session_id
WHERE ce.event_type IN ('post_call_lead_processed','post_call_lead_failed')
ORDER BY ce.occurred_at DESC
LIMIT 30;"
```

### Lead rows with extraction metadata

```bash
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -P pager=off -c "
SELECT l.id::text AS lead_id,
       cs.external_call_id,
       l.status,
       l.source,
       l.metadata->>'post_call_lead_extraction_v1' AS extraction_v1,
       l.metadata->>'product_interest' AS product_interest,
       l.metadata->>'contact_preference' AS contact_preference,
       l.metadata->>'permission' AS permission,
       l.metadata->>'next_action' AS next_action,
       l.metadata->>'confidence' AS confidence,
       l.updated_at
FROM voice.leads l
LEFT JOIN voice.call_sessions cs ON cs.id = l.call_session_id
ORDER BY l.updated_at DESC
LIMIT 30;"
```

## Rollback

Disable extraction only:

```env
VOICE_POST_CALL_LEAD_EXTRACTION_ENABLED=false
```

Then redeploy `voice-bridge`.
