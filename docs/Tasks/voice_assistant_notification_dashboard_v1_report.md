# Voice Assistant Notification/Dashboard v1 Report

Date: 2026-05-21

## Summary

Implemented Phase 7 (Notification/Dashboard v1) with an async post-call webhook notifier. Notifications are emitted only after post-call summary and lead extraction steps, outside realtime call handling.

## Files Changed

- `voice-bridge/src/config.js`
- `voice-bridge/src/post-call.js`
- `voice-bridge/src/post-call-notify.js` (new)
- `voice-bridge/src/persist.js`
- `voice-bridge/.env.example`
- `voice-bridge/README.md`
- `docs/Tasks/technolohit_voice_agent_productization_blueprint.md`

## Runtime Behavior

Post-call pipeline now:

1. summary generation
2. lead extraction/enrichment
3. optional webhook notification

Notification is controlled by:

```env
VOICE_POST_CALL_NOTIFY_ENABLED=false
VOICE_POST_CALL_NOTIFY_WEBHOOK_URL=
VOICE_POST_CALL_NOTIFY_TIMEOUT_MS=8000
```

When enabled and URL is set, the bridge sends one compact JSON payload containing:

- call IDs
- summary outcome fields (`product_interest`, `contact_preference`, `permission`, `next_action`, `confidence`)
- lead processing result (`created/updated/skipped`, reason, lead id)

## Observability

Added event:

- `post_call_notification_processed`

Payload fields:

- `action` (`sent`, `skipped`, `failed`)
- `reason`
- `status_code`
- `url`
- `error`

Runtime troubleshooting logs now use `[post-call]` prefix with:

- pipeline start
- summary created / skipped
- lead processed
- notification processed
- pipeline done / failed

## Scope/Guardrails

- No notification logic in realtime turn/audio path.
- No forced external dependency; webhook is optional and disabled by default.
- No DB schema migration required.
