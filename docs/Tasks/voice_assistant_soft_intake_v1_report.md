# Voice Assistant Soft Intake v1 Report

Date: 2026-05-21

## Files Changed

- `voice-bridge/src/turn-assistant.js`
- `voice-bridge/src/persist.js`
- `voice-bridge/knowledge/technolohit.md`
- `voice-bridge/README.md`
- `docs/voice-database.md`
- `docs/Tasks/voice_assistant_soft_intake_v1_report.md`

No env/config file was changed because the feature is lightweight, local to the existing assistant state, and does not need an external service toggle.

## Intake State Design

Soft Intake uses the existing per-call in-memory object:

```text
ctx.assistantTurn.intake
```

State fields:

```js
{
  handoffRequested: false,
  callbackRequested: false,
  contactPreferenceAsked: false,
  contactPreference: null,
  contactPermissionRequested: false,
  contactPermissionGranted: null,
  contactDetailRequested: false,
  contactDetailAttempted: false,
  contactDetailType: null,
  declined: false
}
```

This state is per call only. It is not a lead row, not a CRM object, and not a post-call summary.

Important behavior:

- one question at a time
- contact preference first: email or phone
- then only the matching detail question
- then permission before passing information to the team
- short refusal fallback to `info@technolohit.com`
- short `ja/nein` answers are accepted while Soft Intake is waiting for permission

## Intents Added / Updated

Added or strengthened:

- `handoff_requested`
- `contact_preference_email`
- `contact_preference_phone`
- `email_provided`
- `phone_provided`
- `refuses_contact_details`

Existing intents now trigger Soft Intake when appropriate:

- `callback_request`
- `smart_website_interest`
- `pricing_question`
- `free_analysis_request`
- `email_campaign_caller`
- `voice_assistant_question`
- `website`

Examples covered:

- `Ich möchte mit jemandem sprechen.`
- `Ich möchte einen Mitarbeiter sprechen.`
- `Geben Sie das bitte weiter.`
- `Team soll sich melden.`
- `Per E-Mail bitte.`
- `Telefonisch bitte.`
- `Schreiben Sie mir.`
- `Ich möchte keine Daten angeben.`
- `Ich schreibe Ihnen selbst.`
- email-like spoken forms such as `punkt de`, `gmail`, `outlook`, `web.de`, `gmx`
- phone-like forms such as `017`, `015`, `016`, `plus vier neun`, `null eins`

## Templates Added / Updated

Soft Intake templates:

```text
Natürlich. Ich nehme nur kurz auf, wie unser Team Sie erreichen kann. Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?

Das hängt vom Umfang ab. Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?

Eine intelligente Website hilft bei Sichtbarkeit und Anfragen. Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?

Danke, dann geht es um die kostenlose Website-Ersteinschätzung. Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?

Welche E-Mail-Adresse dürfen wir für die Rückmeldung verwenden?

Welche Telefonnummer dürfen wir für den Rückruf notieren?

Danke. Darf ich diese Information an unser Team weitergeben, damit sich jemand bei Ihnen meldet?

Danke. Ich gebe Ihre Anfrage an unser Team weiter.

Kein Problem. Sie können uns auch direkt per E-Mail unter info@technolohit.com erreichen.
```

Founder decision applied: the assistant no longer asks for company, website, contact method, phone, and callback time together. It asks only the next useful question.

## Event / Metadata Persistence

No migration was added.

Soft Intake milestones are stored through existing JSONB paths:

- `voice.call_events.payload`
- `voice.call_transcripts.metadata`

New event types:

- `soft_intake_started`
- `contact_preference_requested`
- `contact_preference_detected`
- `contact_detail_requested`
- `contact_permission_requested`
- `contact_permission_granted`
- `contact_permission_denied`
- `soft_intake_declined`

Metadata/event fields include:

- `handoff_requested`
- `callback_requested`
- `contact_preference_asked`
- `contact_preference_detected`
- `contact_permission_requested`
- `contact_permission_granted`
- `contact_detail_attempted`
- `contact_detail_type`
- `soft_intake_state`

Sensitive contact values are not copied into separate structured lead fields. If a caller speaks an email or phone number, that text may naturally exist in the transcript, but this task does not duplicate it into `voice.leads` or a CRM object.

## Caller ID Decision

Caller ID capture was not implemented.

Current decision:

- voice-bridge does not reliably populate caller phone number into `voice.call_sessions`
- the assistant must not assume the current caller number is available
- if the caller chooses phone, the assistant asks: `Welche Telefonnummer dürfen wir für den Rückruf notieren?`
- future caller ID capture requires Asterisk/dialplan/runtime work and is intentionally deferred

## Knowledge Updates

Updated `voice-bridge/knowledge/technolohit.md` with Soft Intake rules:

- ask contact preference only when interest or handoff intent is clear
- do not collect unnecessary data
- do not pressure callers
- ask permission before passing information to the team
- offer `info@technolohit.com` if the caller declines
- do not claim DSGVO compliance
- do not assume caller ID

## Validation Results

Commands run:

```bash
node --check voice-bridge/src/config.js
node --check voice-bridge/src/index.js
node --check voice-bridge/src/turn-assistant.js
node --check voice-bridge/src/persist.js
npm run validate
```

Result: all passed.

## Docker Image

Built and pushed for cloud testing:

```text
thnhit/technhvoice:voice-bridge-soft-intake-v1-20260521-002303@sha256:3be22736a5ededab0a66fa6a5d0e5a44ab070cfa2aa66972364b026ad002a9ba
```

Also pushed by the release script:

```text
thnhit/technhvoice:voice-bridge-85dbb09
thnhit/technhvoice:voice-bridge-latest
```

Container sanity check passed:

```text
node --check src/config.js PASS
node --check src/index.js PASS
node --check src/turn-assistant.js PASS
node --check src/persist.js PASS
BUILD_VERSION=85dbb09
/app/audio/greeting.slin present
/app/knowledge/technolohit.md present
```

Sysadmin pull command:

```bash
cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE='thnhit/technhvoice:voice-bridge-soft-intake-v1-20260521-002303@sha256:3be22736a5ededab0a66fa6a5d0e5a44ab070cfa2aa66972364b026ad002a9ba'

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}} image_id={{.Image}}'
docker logs --tail=160 technolohit-voice-bridge | egrep -i 'startup|voice-assistant|soft_intake|contact_|greeting|ERROR|WARNING' || true
```

## Manual QA Matrix

| Scenario | Caller | Expected |
|---|---|---|
| Human handoff | `Ich möchte mit jemandem sprechen.` | Asks whether email or phone contact is preferred |
| Callback | `Können Sie mich zurückrufen?` | Asks whether email or phone contact is preferred |
| Email preference | `Per E-Mail bitte.` | Asks which email address may be used |
| Phone preference | `Telefonisch bitte.` | Asks which phone number may be noted |
| Contact detail | caller gives email/phone | Asks permission before passing information to team |
| Permission granted | `Ja, gerne.` | Thanks caller and says request will be passed to team |
| Refusal | `Ich möchte keine Daten angeben.` | Offers `info@technolohit.com` |
| Smart Website | `Ich interessiere mich für eine intelligente Website.` | Short answer plus email/phone preference question |
| Pricing | `Was kostet eine Website?` | No exact price plus email/phone preference question |
| Email campaign | `Ich habe Ihre E-Mail bekommen.` | Mentions free first assessment plus email/phone preference question |

Suggested SQL:

```sql
SELECT cs.external_call_id,
       ct.speaker,
       ct.sequence_number,
       ct.metadata->>'turn_index' AS turn_index,
       ct.metadata->>'detected_intent' AS intent,
       ct.metadata->>'used_template_response' AS template,
       ct.metadata->>'used_llm_response' AS llm,
       ct.metadata->>'contact_preference_detected' AS contact_preference,
       ct.metadata->>'contact_permission_granted' AS permission_granted,
       ct.metadata->>'soft_intake_state' AS soft_intake_state,
       length(ct.text) AS text_len,
       left(ct.text, 250) AS text_preview,
       ct.created_at
FROM voice.call_transcripts ct
JOIN voice.call_sessions cs ON cs.id = ct.call_session_id
WHERE ct.metadata->>'transcript_scope' = 'turn'
ORDER BY ct.created_at DESC
LIMIT 40;
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
LIMIT 40;
```

## Out-of-Scope Confirmed

Not implemented:

- lead extraction
- writes to `voice.leads`
- writes to `voice.call_summaries`
- post-call summaries
- n8n
- notifications
- Botinteg integration
- CRM integration
- calendar booking
- caller ID capture from Asterisk
- database migrations
- new deployment platform

## Deferred Follow-ups

- Add reliable caller ID only after Asterisk/dialplan design is explicit.
- Add lead extraction only after the team approves what data may be stored and where.
- Add notifications only after Soft Intake quality is proven in live calls.
- Consider increasing `VOICE_ASSISTANT_MAX_TURNS` later if Soft Intake needs one more turn, but keep `3` for now to avoid long calls.
- Consider post-call human review tooling before any automatic CRM write.
