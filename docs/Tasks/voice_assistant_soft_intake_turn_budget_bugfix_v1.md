# Voice Assistant Soft Intake Turn Budget Bugfix v1

## Goal

Fix the live-call Soft Intake issue where the assistant asks for an email address or phone number, but then ends the conversation or goes to max-turn wrap-up before the caller has a real chance to provide the contact detail.

This is a runtime conversation-flow bugfix.

The assistant already asks:

```text
Welche E-Mail-Adresse dürfen wir für die Rückmeldung verwenden?
But live tests show that after asking this, the assistant can immediately hit max turns and say it will pass the request to the team, without waiting for the caller to provide the email address.

This task must ensure that when Soft Intake asks a contact-detail question, the assistant waits for the caller’s next answer and handles it before any max-turn close.

Problem Evidence

Soft Intake v1 works partially:

contact preference email is detected
assistant asks for the email address

But then max-turn behavior can interrupt the flow:

Assistant: Welche E-Mail-Adresse dürfen wir für die Rückmeldung verwenden?
Assistant next: Ich gebe Ihre Anfrage gerne an unser Team weiter. Wann passt Ihnen ein kurzer Rückruf?

This is wrong because the caller did not get a proper opportunity to provide the email address.

The issue is not the email-address question itself. The issue is the turn budget / state priority after asking the question.

Required Behavior

If the assistant asks:

Welche E-Mail-Adresse dürfen wir für die Rückmeldung verwenden?

then the next caller turn must be treated as an answer to that question.

The assistant must not close due to max turns before processing that next answer.

Same for phone:

Welche Telefonnummer dürfen wir für den Rückruf notieren?

The next caller turn must be treated as the phone-answer turn.

Product Decisions

Keep these decisions:

German only
No human name
No exact pricing
No ranking guarantees
No lead extraction
No writes to voice.leads
No writes to voice.call_summaries
No n8n
No notifications
No Botinteg integration
No CRM
No calendar booking
No caller ID capture
No major architecture refactor
In Scope
1. Prioritize Soft Intake Waiting State Before Max-Turn Close

Inspect:

voice-bridge/src/turn-assistant.js

If ctx.assistantTurn.intake is waiting for contact detail or permission, that state must be processed before any generic max-turn close.

Required priority order:

1. If waiting_for_contact_detail:
   - listen for caller answer
   - if answer looks like email/phone/detail, ask permission
   - if answer is unclear, ask once more briefly
   - do not max-turn close yet

2. If waiting_for_permission:
   - listen for yes/no/refusal
   - close politely based on permission
   - do not generic max-turn close before processing permission

3. Only after Soft Intake is completed, declined, or failed after retry:
   - allow normal max-turn close
2. Add Soft Intake Extra Turn Budget

Current default max turns appears too low for Soft Intake.

Implement a safe extra-turn rule.

Preferred behavior:

base_max_turns = existing config
if soft intake is active and not completed:
  effective_max_turns = base_max_turns + 2

Alternative via config:

VOICE_ASSISTANT_MAX_TURNS_WITH_INTAKE=5

If adding config, update:

voice-bridge/src/config.js
voice-bridge/.env.example
.env.example
voice-bridge/README.md

Recommended default:

VOICE_ASSISTANT_MAX_TURNS_WITH_INTAKE=5

Do not make calls unlimited.

Do not increase normal non-intake calls too much.

3. Add Explicit Intake States

Ensure the intake state can represent these states clearly:

contact_preference_requested
contact_detail_requested
contact_permission_requested
completed
declined
failed

When the assistant asks for email address:

soft_intake_state = contact_detail_requested
contact_detail_type = email
waiting_for = contact_detail

When it asks for phone number:

soft_intake_state = contact_detail_requested
contact_detail_type = phone
waiting_for = contact_detail

When it asks permission:

soft_intake_state = contact_permission_requested
waiting_for = permission

When permission granted:

soft_intake_state = completed
contact_permission_granted = true

When caller refuses:

soft_intake_state = declined
contact_permission_granted = false
4. Handle The Next Caller Turn After Detail Question

If previous assistant response asked for email address, then next caller text should be handled as an attempted email detail even if STT is imperfect.

Do not require perfect email validation.

Examples:

meine email ist max punkt mustermann at gmail punkt com
max at firma punkt de
ich schicke ihnen meine email lieber selbst

Expected:

if likely detail: ask permission
if caller refuses/self-send: provide info@technolohit.com
if unclear: ask once more briefly

Email unclear retry:

Entschuldigung, ich habe die E-Mail-Adresse nicht sicher verstanden. Sie können sie auch direkt an info@technolohit.com senden.

Important:
Do not get stuck asking the email again repeatedly.

5. Handle The Next Caller Turn After Phone Question

If previous assistant response asked for phone number, next caller text should be handled as phone detail attempt.

Do not require perfect phone validation.

Examples:

null eins sieben sechs ...
plus vier neun ...
ich rufe später nochmal an

Expected:

if likely phone detail: ask permission
if caller refuses/self-calls: provide info@technolohit.com
if unclear: ask once more briefly

Phone unclear retry:

Entschuldigung, ich habe die Telefonnummer nicht sicher verstanden. Sie können uns auch per E-Mail unter info@technolohit.com erreichen.
6. Permission Question Must Get One Answer Turn

If assistant asks:

Danke. Darf ich diese Information an unser Team weitergeben, damit sich jemand bei Ihnen meldet?

then next caller answer must be processed as permission.

Recognize positive:

ja
ja gerne
genau
in ordnung
okay
passt
dürfen sie

Recognize negative:

nein
lieber nicht
keine daten
möchte ich nicht

Positive response:

Danke. Ich gebe Ihre Anfrage an unser Team weiter.

Negative response:

Kein Problem. Sie können uns auch direkt per E-Mail unter info@technolohit.com erreichen.

Do not hit max-turn close before this permission answer is processed.

7. Prevent Bad Max-Turn Message During Active Intake

If soft intake is active and missing contact detail, do not say:

Ich gebe Ihre Anfrage gerne an unser Team weiter. Wann passt Ihnen ein kurzer Rückruf?

That is misleading because contact details are missing.

Use one of these instead:

If email was requested but missing:

Sie können uns Ihre Kontaktdaten auch direkt per E-Mail an info@technolohit.com senden.

If phone was requested but missing:

Sie können uns auch direkt per E-Mail unter info@technolohit.com erreichen.

If permission missing:

Ohne Ihre Bestätigung gebe ich keine Kontaktdaten weiter. Sie können uns direkt unter info@technolohit.com erreichen.
8. Metadata / Events

Add or update metadata where feasible:

soft_intake_state
soft_intake_waiting_for
contact_detail_type
contact_detail_attempted
contact_detail_retry_count
contact_permission_requested
contact_permission_granted
soft_intake_completed
max_turns_extended_for_intake
max_turns_blocked_by_active_intake

Use existing JSONB metadata/event paths.

No migration.

Do not persist extracted email/phone into structured lead fields.

9. Docker Image Build And Push Required

After implementation and validation pass, build and push a new Docker image to Docker Hub.

Repository:

thnhit/technhvoice

Required tags:

voice-bridge-soft-intake-turn-budget-v1-YYYYMMDD-HHMMSS
voice-bridge-latest

Also include the git SHA tag if the existing release script supports it.

The report must include:

exact image tag
digest if available
build command or release script used
push confirmation
container sanity check result if available

Do not skip this.

Out of Scope

Do not implement:

lead extraction
voice.leads writes
voice.call_summaries writes
n8n
email notification
Telegram notification
Botinteg integration
CRM
calendar booking
caller ID capture
new migrations unless absolutely unavoidable
large architecture refactor
multi-tenant deployment platform
Files Likely To Change

Expected:

voice-bridge/src/turn-assistant.js
voice-bridge/src/persist.js
voice-bridge/README.md
docs/voice-database.md

If config is added:

voice-bridge/src/config.js
voice-bridge/.env.example
.env.example

Task docs:

docs/Tasks/voice_assistant_soft_intake_turn_budget_bugfix_v1_report.md
docs/Tasks/sysadmin_voice_bridge_soft_intake_turn_budget_v1.md
Validation

Run:

node --check voice-bridge/src/config.js
node --check voice-bridge/src/index.js
node --check voice-bridge/src/turn-assistant.js
node --check voice-bridge/src/persist.js
npm run validate

If release/build scripts exist, use the project’s existing Docker release process.

Manual QA Scenarios
Scenario 1 — Email Preference Must Wait For Email

Caller:

Was kostet eine Website?
Per E-Mail bitte.

Expected:

Welche E-Mail-Adresse dürfen wir für die Rückmeldung verwenden?

Then caller provides email.

Expected:

Danke. Darf ich diese Information an unser Team weitergeben, damit sich jemand bei Ihnen meldet?

No max-turn close before email answer is processed.

Scenario 2 — Email Asked, Caller Pauses Then Answers

Flow:

Assistant: Welche E-Mail-Adresse dürfen wir für die Rückmeldung verwenden?
Caller: meine email ist ...

Expected:

system waits for this caller turn
handles it as contact detail attempt
asks permission
Scenario 3 — Phone Preference Must Wait For Phone

Caller:

Telefonisch bitte.

Expected:

Welche Telefonnummer dürfen wir für den Rückruf notieren?

Then caller provides number.

Expected:

Danke. Darf ich diese Information an unser Team weitergeben, damit sich jemand bei Ihnen meldet?
Scenario 4 — Permission Turn Protected

After permission question:

Danke. Darf ich diese Information an unser Team weitergeben, damit sich jemand bei Ihnen meldet?

Caller:

Ja, gerne.

Expected:

Danke. Ich gebe Ihre Anfrage an unser Team weiter.

No generic max-turn close before processing permission.

Scenario 5 — Refusal

Caller:

Ich möchte keine Daten angeben.

Expected:

Kein Problem. Sie können uns auch direkt per E-Mail unter info@technolohit.com erreichen.
SQL QA Queries

Include these in the report and sysadmin guide.

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
Sysadmin Guide Required

Create:

docs/Tasks/sysadmin_voice_bridge_soft_intake_turn_budget_v1.md

This guide must tell the sysadmin exactly how to deploy and test the new image.

It must include:

Exact Docker image tag and digest
Pull command
Docker compose restart command
Command to verify running image
How to clear old container logs before testing if appropriate
How to tail new logs
How to run SQL QA queries
Manual call test scenarios
What success looks like
What failure looks like
Rollback command to previous image

Use this deployment location as the expected production server path:

/opt/technolohit-voice/asterisk

Expected command style:

cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE='thnhit/technhvoice:<NEW_TAG_OR_DIGEST>'

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge

docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}} image_id={{.Image}}'
docker logs --tail=200 technolohit-voice-bridge

For clearing logs, do not delete application data. If using Docker logs, explain safe options such as recreating the container or using --since for new logs.

Prefer:

docker logs --since=5m -f technolohit-voice-bridge

Do not instruct sysadmin to delete recordings, database rows, or volumes unless explicitly requested.

Implementation Report Required

Create:

docs/Tasks/voice_assistant_soft_intake_turn_budget_bugfix_v1_report.md

Report must include:

# Voice Assistant Soft Intake Turn Budget Bugfix v1 Report

## Files Changed
## Root Cause
## Fix Summary
## Intake State Priority Changes
## Max Turn / Turn Budget Changes
## Template Changes
## Metadata / Events
## Docker Image Built And Pushed
## Validation Results
## Manual QA Matrix
## Sysadmin Deployment Guide
## Out-of-Scope Confirmed
## Deferred Follow-ups
Success Criteria

This task is successful when:

after asking for email address, assistant waits for the next caller answer
after asking for phone number, assistant waits for the next caller answer
permission question gets a real answer turn
active soft intake is not interrupted by normal max turns
max turns are extended only for active soft intake, not all calls unnecessarily
no lead extraction is added
no voice.leads writes are added
no n8n/notification/Botinteg/CRM/calendar integration is added
validation passes
Docker image is built and pushed to thnhit/technhvoice
sysadmin deployment/test guide is created
implementation report is created