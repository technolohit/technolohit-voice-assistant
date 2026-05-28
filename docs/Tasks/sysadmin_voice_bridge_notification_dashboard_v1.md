# Sysadmin Guide: Voice Bridge Notification/Dashboard v1

Date: 2026-05-21

## Purpose

Enable and verify async post-call webhook notifications.

## Env Configuration

```env
VOICE_POST_CALL_NOTIFY_ENABLED=true
VOICE_POST_CALL_NOTIFY_WEBHOOK_URL=https://<your-endpoint>/voice/post-call
VOICE_POST_CALL_NOTIFY_TIMEOUT_MS=8000
```

Keep summary/lead phases enabled:

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

## Logs

```bash
docker logs --since=20m technolohit-voice-bridge \
| egrep -i 'voice-summary|voice-lead|voice-notify|post_call_notification|ERROR|WARNING' || true
```

Expected notification log:

```text
[post-call] pipeline start call_session_id=...
[post-call] summary created summary_id=...
[post-call] lead processed action=...
[post-call] notification processed action=sent reason=ok status_code=200 call_session_id=...
[post-call] pipeline done call_session_id=...
```

## SQL Check

```bash
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -P pager=off -c "
SELECT cs.external_call_id,
       ce.payload->>'action' AS action,
       ce.payload->>'reason' AS reason,
       ce.payload->>'status_code' AS status_code,
       ce.payload->>'url' AS url,
       ce.payload->>'error' AS error,
       ce.occurred_at
FROM voice.call_events ce
JOIN voice.call_sessions cs ON cs.id = ce.call_session_id
WHERE ce.event_type = 'post_call_notification_processed'
ORDER BY ce.occurred_at DESC
LIMIT 30;"
```

Success criteria:

- `action=sent` when webhook is reachable.
- `action=skipped` with clear reason when feature/url is disabled.
- `action=failed` includes transport/HTTP reason for troubleshooting.
- `url`, `status_code`, and `error` are persisted for notification diagnostics.

## Rollback

Disable notification only:

```env
VOICE_POST_CALL_NOTIFY_ENABLED=false
```

Then redeploy `voice-bridge`.
