# Voice Lead Notification Implementation Report v1

Date: 2026-05-29

## Summary

Implemented the async post-call notification consumer in n8n workflow `Tech-Voice-notif` on `https://wf.automobil-agent.de`. The workflow receives `voice_post_call_outcome_v1` payloads from `voice-bridge`, classifies outcomes, deduplicates retries, and sends Telegram plus email alerts for callback and manual-review cases.

No `voice-bridge` code changes were required for the first release. The webhook payload still does not include `callback_phone`; see [Recommended next improvement](#recommended-next-improvement).

## What Changed

| Area | Change |
|------|--------|
| n8n workflow `Tech-Voice-notif` (ID `3uWYMhQ6JfCqKmHv`) | Added normalize, validate, dedupe, classify, route, Telegram, email, mark-sent, and log paths |
| Repo export | `workflows/n8n/Tech-Voice-notif.workflow.json` |
| Deploy script | `scripts/n8n-voice-notif-deploy.cjs` |
| Test script | `scripts/test-voice-lead-notification.cjs` |
| Blueprint | Checklist updated in `technolohit_voice_lead_notification_blueprint_v1.md` |
| Formatting hotfix | `Classify Notification` now builds `telegram_text`, `email_subject`, and `email_text`; send nodes use those resolved fields |

## n8n Workflow Node List

| Order | Node | Purpose |
|-------|------|---------|
| 1 | Webhook | POST `voice/post-call` entry (unchanged path) |
| 2 | Normalize Payload | Flatten body/summary/lead; build `idempotency_key` |
| 3 | Validate Payload | Require `type`, `call_session_id`, `summary_id` |
| 4 | Dedupe Check | Claim or reject `voice-lead-notif:{session}:{summary}:{lead_action}` |
| 5 | Is New Notification | Stop duplicates before classify/send |
| 6 | Classify Notification | Set `notification_type` = `callback` / `review` / `ignore`; build readable Telegram/email content |
| 7 | Route Notification | Switch to callback, review, or ignore |
| 8a | Send Telegram Callback | High-priority mobile alert |
| 8b | Send Email Callback | High-priority email |
| 8c | Mark Notification Sent | Record sent/partial state in workflow static data |
| 9a | Send Telegram Review | Medium-priority manual review alert |
| 9b | Send Email Review | Review email (not labeled as urgent callback) |
| 9c | Mark Review Sent | Same mark logic as callback path |
| 10 | Log Ignored | Non-actionable outcomes (no Telegram/email) |
| — | Log Duplicate | Retry-safe stop path |
| — | Log Invalid Payload | Malformed webhook stop path |

## Notification Routing Rules

### High priority (`callback`)

All must be true:

- `type === voice_post_call_outcome_v1`
- `next_action === team_callback`
- `permission === granted`
- `lead_action` in `created`, `updated`

### Review (`review`)

Any of:

- `next_action === manual_review`
- `confidence === low`
- `lead_action === failed`

Callback wins when both callback and review rules match (classify order).

### Ignore (`ignore`)

Example: `next_action === await_customer_email` and `lead_action === skipped` → `Log Ignored` only.

## Dedupe Strategy

- Key: `voice-lead-notif:{call_session_id}:{summary_id}:{lead_action}`
- Store: n8n workflow **global static data** (`$getWorkflowStaticData('global').sentKeys`)
- **Claim-before-send**: key is written as `pending` in `Dedupe Check` before notifications, so overlapping webhook deliveries do not double-send.
- **Mark-after-send**: `Mark Notification Sent` / `Mark Review Sent` sets `status: sent` and `delivery_status` (`sent` / `partial` / `failed`).
- Limitation: static data is per workflow instance; workflow reset/reinstall clears history. For multi-instance n8n, prefer a shared store later.

## Credentials (names only)

| Node | Credential name |
|------|-----------------|
| Telegram nodes | `TechnoloHit Telegram Bot` |
| Email nodes | `Ionos-Email-Tech` |

Telegram `chatId` and email `toEmail` are configured in the workflow nodes (not stored in this repo as secrets).

## Webhook URL

Production (workflow active):

```text
https://wf.automobil-agent.de/webhook/voice/post-call
```

Set in voice-bridge:

```env
VOICE_POST_CALL_NOTIFY_ENABLED=true
VOICE_POST_CALL_NOTIFY_WEBHOOK_URL=https://wf.automobil-agent.de/webhook/voice/post-call
```

## Test Results

Executed via `node scripts/test-voice-lead-notification.cjs` against production webhook.

| Case | Execution IDs (sample) | Nodes executed | Result |
|------|------------------------|----------------|--------|
| A Callback | `4967044` | … → Telegram Callback → Email Callback → Mark | Pass |
| B Review | `4967045` | … → Telegram Review → Email Review → Mark | Pass |
| C Ignore | `4967046` | … → Log Ignored | Pass |
| D Duplicate replay | `4967073`, `4967074` | … → Log Duplicate | Pass (after claim-before-send fix) |

Telegram and email nodes on callback test `4967044` both reported `success`.

### Formatting Hotfix

After the first real production call test, Telegram/email delivery worked but the message body contained raw n8n expressions such as:

```text
{{ $('Classify Notification').item.json.product_interest }}
```

Root cause: the notification node body fields were saved as fixed text instead of expression-backed values.

Fix:

- `Classify Notification` now creates fully rendered fields:
  - `telegram_text`
  - `email_subject`
  - `email_text`
- Telegram nodes send `={{ $json.telegram_text }}`.
- Email nodes read from `Classify Notification` directly:
  - subject: `={{ $('Classify Notification').first().json.email_subject }}`
  - body: `={{ $('Classify Notification').first().json.email_text }}`
- Test payload IDs now include a timestamp so repeated test runs are not blocked by dedupe.

Verification after hotfix:

| Case | Execution ID | Nodes executed | Result |
|------|--------------|----------------|--------|
| Callback formatting | `4967492` | ... -> Telegram Callback -> Email Callback -> Mark | Pass |
| Review formatting | `4967509` | ... -> Telegram Review -> Email Review -> Mark | Pass |
| Email undefined fix | `4967679` | ... -> Telegram Callback -> Email Callback -> Mark | Pass |

The `Classify Notification` output for execution `4967492` rendered a readable subject:

```text
[HIGH] Voice callback lead - Smart Website
```

and a readable body beginning with:

```text
CALLBACK LEAD - TechnoloHit Voice Assistant
```

Follow-up issue found after this formatting hotfix: the Email node receives the Telegram node output as its input, so `={{ $json.email_text }}` evaluated to `undefined`. The Email node expressions were updated to read from `Classify Notification` directly. Execution `4967679` verified `email_node_error=null` and a rendered email body.

## How to Test

```bash
node scripts/test-voice-lead-notification.cjs callback
node scripts/test-voice-lead-notification.cjs review
node scripts/test-voice-lead-notification.cjs ignore
node scripts/test-voice-lead-notification.cjs duplicate
```

Optional:

```env
VOICE_NOTIF_WEBHOOK_URL=https://wf.automobil-agent.de/webhook/voice/post-call
```

## How to Troubleshoot

1. n8n → workflow `Tech-Voice-notif` → Executions: open latest run and inspect last node.
2. Duplicate: expect `Log Duplicate` and no Telegram/email nodes.
3. Invalid payload: expect `Log Invalid Payload`.
4. Partial delivery: execution still succeeds; check `delivery_status` in `Mark Notification Sent` output and failed child nodes (nodes use `continueOnFail`).
5. voice-bridge: `docker logs technolohit-voice-bridge` for `[post-call] notification processed`.
6. DB: `post_call_notification_processed` events per `docs/Tasks/sysadmin_voice_bridge_notification_dashboard_v1.md`.

## Rollback

1. Disable Telegram/Email nodes or deactivate workflow in n8n.
2. Or redeploy previous workflow JSON from git history / n8n version history.
3. Stop upstream events: `VOICE_POST_CALL_NOTIFY_ENABLED=false` on voice-bridge and redeploy.

Redeploy current workflow from repo:

```bash
node scripts/n8n-voice-notif-deploy.cjs deploy
```

Requires n8n API access via `~/.cursor/mcp.json` (`n8n-mcp` server env: `N8N_API_URL`, `N8N_API_KEY`). Do not commit API keys.

## Known Limitations

- Webhook response is async (`Workflow was started`); tests must inspect n8n executions, not HTTP body alone.
- Callback phone number is **not** in the webhook payload today; notifications include call IDs only.
- Workflow static dedupe resets if static data is cleared or workflow is cloned without static data.
- Email `fromEmail` / `toEmail` are set in the workflow; adjust in n8n UI if Ionos requires a specific sender.
- Production live-call delivery was confirmed by a real callback test on 2026-05-29. Formatting was then improved and verified with webhook test executions.

## Recommended Next Improvement

Extend `voice-bridge/src/post-call-notify.js` to emit contact/priority fields when a callback number is known from call session / lead persistence:

```json
{
  "contact": {
    "callback_phone": "+49...",
    "phone_source": "caller_id|voice|unknown",
    "phone_present": true
  },
  "priority": {
    "level": "high",
    "reason": "callback_requested_permission_granted"
  }
}
```

Then map these fields in `Normalize Payload` and Telegram/email templates.
