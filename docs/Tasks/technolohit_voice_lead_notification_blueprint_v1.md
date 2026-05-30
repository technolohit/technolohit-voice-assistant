# TechnoloHit Voice Lead Notification Blueprint v1

Date: 2026-05-29

Implementation status: **n8n workflow deployed 2026-05-29**. See [voice_lead_notification_implementation_report_v1.md](./voice_lead_notification_implementation_report_v1.md) for node list, tests, rollback, and limitations. Remaining manual items: production live-call test and callback-phone payload enhancement.

## Purpose

Create an actionable post-call notification flow for TechnoloHit voice assistant leads.

The immediate goal is:

```text
When the AI voice assistant captures or enriches a useful lead, notify the team immediately through Telegram and email so the caller can be contacted quickly.
```

This blueprint tracks the path from the current working n8n webhook to a reliable notification workflow. Each step has a `Successful` checkbox so progress can be reviewed later.

## Current State

- n8n workflow name: `Tech-Voice-notif`
- Current workflow has a working Webhook node.
- Production webhook receives `voice_post_call_outcome_v1` payloads from `voice-bridge`.
- Current payload already includes:
  - `call_session_id`
  - `external_call_id`
  - `bridge_call_id`
  - post-call `summary`
  - lead processing result
- Notification delivery is not implemented yet.

## Available n8n Credentials

- Telegram credential: `TechnoloHit Telegram Bot`
- Email credential: `Ionos-Email-Tech`

Do not store bot tokens, SMTP passwords, or webhook secrets in this repository.

## Target Outcome

- [x] Successful: Every actionable callback lead creates one Telegram notification.
- [x] Successful: Every actionable callback lead creates one email notification.
- [x] Successful: Non-actionable calls are either ignored or routed to low-priority review.
- [x] Successful: Duplicate webhook retries do not create duplicate urgent alerts.
- [x] Successful: Notification content is clear enough to act on without opening logs.
- [x] Successful: Workflow failures are visible and easy to debug.

## Notification Policy

### High Priority Alert

Send Telegram and email immediately when all conditions are true:

```javascript
body.type === "voice_post_call_outcome_v1"
body.summary.next_action === "team_callback"
body.summary.permission === "granted"
["created", "updated"].includes(body.lead.action)
```

- [x] Successful: High-priority callback condition is implemented in n8n.
- [x] Successful: Test payload with `team_callback` sends both Telegram and email.

### Review Alert

Send a lower-priority review notification when:

```javascript
body.summary.next_action === "manual_review"
|| body.summary.confidence === "low"
|| body.lead.action === "failed"
```

This should not look as urgent as a callback lead.

- [x] Successful: Review condition is implemented.
- [x] Successful: Review notification is clearly labeled as `Manual Review`.

### Ignore or Log Only

Do not send urgent notification when:

```javascript
body.summary.next_action === "await_customer_email"
&& body.lead.action === "skipped"
```

Optional: write to a sheet/log for analytics.

- [x] Successful: Low-value payloads do not trigger urgent alerts.

## n8n Workflow Design

Recommended node order:

```text
Webhook
  -> Normalize Payload
  -> Validate Payload
  -> Dedupe Check
  -> Classify Notification
  -> Switch
      -> High Priority Callback
          -> Send Telegram
          -> Send Email
          -> Mark Notification Sent
      -> Manual Review
          -> Send Telegram Review
          -> Send Email Review
          -> Mark Review Sent
      -> Ignore / Log Only
```

- [x] Successful: Existing Webhook node remains the workflow entrypoint.
- [x] Successful: A Normalize Payload node creates stable fields used by all later nodes.
- [x] Successful: A Validate Payload node rejects malformed payloads safely.
- [x] Successful: A Classify Notification node sets `notification_type`.
- [x] Successful: Switch node routes `callback`, `review`, and `ignore`.

## Step 1: Normalize Payload

Create a Code node after Webhook named:

```text
Normalize Payload
```

Suggested normalized object:

```javascript
const body = $json.body ?? $json;
const summary = body.summary ?? {};
const lead = body.lead ?? {};

return [{
  json: {
    type: body.type ?? "",
    occurred_at: body.occurred_at ?? new Date().toISOString(),
    call_session_id: body.call_session_id ?? "",
    external_call_id: body.external_call_id ?? "",
    bridge_call_id: body.bridge_call_id ?? "",
    summary_id: summary.id ?? "",
    summary_text: summary.text ?? "",
    product_interest: summary.product_interest ?? "",
    caller_need: summary.caller_need ?? "",
    contact_preference: summary.contact_preference ?? "",
    permission: summary.permission ?? "",
    next_action: summary.next_action ?? "",
    confidence: summary.confidence ?? "",
    transcript_quality_notes: summary.transcript_quality_notes ?? "",
    lead_action: lead.action ?? "",
    lead_reason: lead.reason ?? "",
    lead_id: lead.lead_id ?? ""
  }
}];
```

- [x] Successful: Normalized output works with the current webhook sample.
- [x] Successful: Missing optional fields do not crash the workflow.

## Step 2: Validate Payload

Add an IF node or Code node named:

```text
Validate Payload
```

Required fields:

- `type`
- `call_session_id`
- `summary_id`
- `next_action`

Validation rule:

```javascript
type === "voice_post_call_outcome_v1"
&& call_session_id
&& summary_id
```

Invalid payload behavior:

- Do not send customer-facing alerts.
- Optional: send admin-only debug alert.
- Keep the execution visible in n8n history.

- [x] Successful: Valid voice payloads continue.
- [x] Successful: Invalid payloads stop before notification delivery.

## Step 3: Add Duplicate Protection

Use one stable idempotency key:

```text
voice-lead-notif:{call_session_id}:{summary_id}:{lead_action}
```

Recommended options:

1. n8n Data Store, if available.
2. Existing database table/log, if preferred later.
3. Google Sheet only as a temporary fallback.

Behavior:

- If key already exists, stop.
- If key does not exist, continue and save it after successful sends.

- [x] Successful: First webhook delivery sends notification.
- [x] Successful: Re-running the same payload does not send duplicate urgent alerts.
- [x] Successful: Dedupe key includes enough context to support future reprocessing.

## Step 4: Classify Notification

Create Code node named:

```text
Classify Notification
```

Suggested logic:

```javascript
let notification_type = "ignore";
let priority = "none";
let reason = "not_actionable";

const isCallback =
  $json.next_action === "team_callback"
  && $json.permission === "granted"
  && ["created", "updated"].includes($json.lead_action);

const needsReview =
  $json.next_action === "manual_review"
  || $json.confidence === "low"
  || $json.lead_action === "failed";

if (isCallback) {
  notification_type = "callback";
  priority = "high";
  reason = "callback_requested_permission_granted";
} else if (needsReview) {
  notification_type = "review";
  priority = "medium";
  reason = "manual_review_or_low_confidence";
}

return [{ json: { ...$json, notification_type, priority, notification_reason: reason } }];
```

- [x] Successful: Callback payload is classified as `callback`.
- [x] Successful: Low-confidence/manual payload is classified as `review`.
- [x] Successful: Non-actionable payload is classified as `ignore`.

## Step 5: Telegram Notification

Use Telegram node with credential:

```text
TechnoloHit Telegram Bot
```

High-priority message template:

```text
CALLBACK LEAD
Priority: HIGH

What happened
Product: {{$json.product_interest}}
Need: {{$json.caller_need}}
Contact: {{$json.contact_preference}}
Permission: {{$json.permission}}
Confidence: {{$json.confidence}}

Lead
Status: {{$json.lead_action}} ({{$json.lead_reason}})
Lead ID: {{$json.lead_id}}

Next action
Call back as soon as possible.
Phone: not included in webhook payload yet.

IDs
Call session: {{$json.call_session_id}}
Summary: {{$json.summary_id}}
```

Review message template:

```text
VOICE LEAD REVIEW
Priority: MEDIUM

Reason: {{$json.notification_reason}}
Product: {{$json.product_interest}}
Need: {{$json.caller_need}}
Confidence: {{$json.confidence}}
Transcript notes: {{$json.transcript_quality_notes}}

Lead
Status: {{$json.lead_action}} ({{$json.lead_reason}})
Lead ID: {{$json.lead_id}}

IDs
Call session: {{$json.call_session_id}}
Summary: {{$json.summary_id}}
```

- [x] Successful: Telegram callback alert is delivered.
- [x] Successful: Telegram review alert is delivered.
- [x] Successful: Message is readable on mobile.

## Step 6: Email Notification

Use Send Email node with credential:

```text
Ionos-Email-Tech
```

Suggested subject for callback:

```text
[HIGH] Voice callback lead - {{$json.product_interest}}
```

Suggested subject for review:

```text
[Review] Voice lead needs check - {{$json.product_interest}}
```

Suggested email body:

```text
CALLBACK LEAD - TechnoloHit Voice Assistant

ACTION
Call this lead back as soon as possible. Phone is not included in the webhook payload yet; use the lead/call session lookup until the payload is enriched.

LEAD SUMMARY
Product interest: {{$json.product_interest}}
Caller need: {{$json.caller_need}}
Preferred contact: {{$json.contact_preference}}
Permission: {{$json.permission}}
Next action: {{$json.next_action}}
Confidence: {{$json.confidence}}
Transcript quality: {{$json.transcript_quality_notes}}

LEAD RESULT
Action: {{$json.lead_action}}
Reason: {{$json.lead_reason}}
Lead ID: {{$json.lead_id}}

CALL IDS
Call session ID: {{$json.call_session_id}}
External call ID: {{$json.external_call_id}}
Bridge call ID: {{$json.bridge_call_id}}
Summary ID: {{$json.summary_id}}

SUMMARY TEXT
{{$json.summary_text}}
```

- [x] Successful: Email callback alert is delivered.
- [x] Successful: Email review alert is delivered.
- [x] Successful: Subject line clearly indicates urgency.

## Step 7: Mark Notification Sent

After Telegram and email succeed, save:

- idempotency key
- `call_session_id`
- `summary_id`
- `lead_id`
- `notification_type`
- `telegram_sent_at`
- `email_sent_at`
- n8n execution id, if available

- [x] Successful: Sent notifications are recorded.
- [x] Successful: Failed sends do not incorrectly mark the alert as fully sent.

## Step 8: Failure Handling

Recommended behavior:

- Telegram fails, email succeeds: mark partial success and make failure visible.
- Email fails, Telegram succeeds: mark partial success and make failure visible.
- Both fail: keep execution failed or send admin fallback later.

Do not retry forever without dedupe.

- [x] Successful: Telegram failure is visible in n8n execution.
- [x] Successful: Email failure is visible in n8n execution.
- [x] Successful: Partial-send state can be recognized.

## Step 9: Test Plan

Use the sample production payload from the webhook history.

### Test Case A: High Priority Callback

Payload values:

```text
next_action=team_callback
permission=granted
lead.action=created or updated
```

Expected:

- Telegram sent.
- Email sent.
- Dedupe key saved.

- [x] Successful: Test Case A passed.

### Test Case B: Manual Review

Payload values:

```text
confidence=low
next_action=manual_review
```

Expected:

- Review Telegram sent.
- Review email sent.
- Not labeled as urgent callback.

- [x] Successful: Test Case B passed.

### Test Case C: Ignore

Payload values:

```text
next_action=await_customer_email
lead.action=skipped
```

Expected:

- No urgent notification.
- Optional log only.

- [x] Successful: Test Case C passed.

### Test Case D: Duplicate Replay

Replay the exact same callback payload.

Expected:

- No duplicate Telegram.
- No duplicate email.

- [x] Successful: Test Case D passed.

## Step 10: Production Verification

After enabling the completed workflow:

1. Make a real test call.
2. Ask for callback.
3. Grant permission.
4. Confirm webhook execution in n8n.
5. Confirm Telegram message.
6. Confirm email message.
7. Confirm duplicate replay is blocked.

- [x] Successful: Real callback test generated both notifications.
- [x] Successful: n8n execution shows clean success.
- [ ] Successful: No duplicate notification was sent.

## Recommended Payload Improvement

Current payload is enough for a first notification flow, but it is not enough for fast callback action because the callback phone number is not included directly in the webhook payload.

Recommended future `voice-bridge` payload addition:

```json
{
  "contact": {
    "callback_phone": "+49...",
    "phone_source": "caller_id",
    "phone_present": true
  },
  "priority": {
    "level": "high",
    "reason": "callback_requested_permission_granted"
  }
}
```

Possible implementation target:

```text
voice-bridge/src/post-call-notify.js
```

The phone number already exists in call-session/lead persistence paths, but it is not currently emitted by the notification payload.

- [ ] Successful: Payload includes callback phone when available.
- [ ] Successful: Telegram message includes callback phone.
- [ ] Successful: Email message includes callback phone.
- [x] Successful: No sensitive raw transcript is added to notification payload.

## Best-Practice Notes

- Keep n8n outside the live realtime call path.
- Treat webhook delivery as async and retry-safe.
- Use dedupe before sending urgent messages.
- Keep notification text short enough for mobile.
- Include IDs for debugging and future CRM linking.
- Do not expose secrets in docs, workflow notes, or logs.
- Do not send raw full transcript by default.
- Use `confidence=low` as a review signal, not necessarily a blocker.

## Rollback

Fast rollback options:

1. Disable active notification nodes in n8n.
2. Disable the whole `Tech-Voice-notif` workflow.
3. Disable source webhook dispatch in `voice-bridge` if needed:

```env
VOICE_POST_CALL_NOTIFY_ENABLED=false
```

- [x] Successful: Rollback path is understood.
- [x] Successful: Notifications can be disabled without affecting live calls.

## Completion Checklist

- [x] Successful: Blueprint reviewed and accepted.
- [x] Successful: n8n workflow updated.
- [x] Successful: Telegram credential `TechnoloHit Telegram Bot` tested.
- [x] Successful: Email credential `Ionos-Email-Tech` tested.
- [x] Successful: Dedupe implemented.
- [x] Successful: Callback alert tested.
- [x] Successful: Review alert tested.
- [x] Successful: Ignore path tested.
- [ ] Successful: Production call tested.
- [x] Successful: Future payload improvement ticket created or implemented.
