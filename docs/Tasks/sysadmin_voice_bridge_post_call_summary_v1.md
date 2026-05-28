# Sysadmin Guide: Voice Bridge Post-Call Summary v1

Date: 2026-05-21

## Purpose

Enable and verify deterministic post-call summary rows in `voice.call_summaries` after live calls.

## Required Runtime Flag

Set:

```env
VOICE_POST_CALL_SUMMARY_ENABLED=true
```

No DB migration is required (uses existing `voice.call_summaries` table).

## Deploy

Use the latest tested image from this branch/release and redeploy `voice-bridge`:

```bash
cd /opt/technolohit-voice/asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## Log Verification

```bash
docker logs --since=20m technolohit-voice-bridge \
| egrep -i 'voice-summary|post_call_summary|summary_created|summary_failed|ERROR|WARNING' || true
```

Expected success line:

```text
[voice-summary] post-call summary created summary_id=... call_session_id=...
```

## SQL Verification

```bash
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -P pager=off -c "
SELECT cs.external_call_id,
       s.summary_type,
       s.model,
       left(s.summary_text, 260) AS summary_preview,
       s.metadata->>'product_interest' AS product_interest,
       s.metadata->>'contact_preference' AS contact_preference,
       s.metadata->>'permission' AS permission,
       s.metadata->>'next_action' AS next_action,
       s.metadata->>'confidence' AS confidence,
       s.updated_at
FROM voice.call_summaries s
JOIN voice.call_sessions cs ON cs.id = s.call_session_id
ORDER BY s.updated_at DESC
LIMIT 20;"
```

Success criteria:

- New/updated `summary_type=auto` row appears for recent call.
- `summary_text` has five business lines (product, need, contact, permission, next action).
- Metadata fields are populated and deterministic.

## Rollback

If needed, disable summary generation without changing image:

```env
VOICE_POST_CALL_SUMMARY_ENABLED=false
```

Then redeploy `voice-bridge`.
