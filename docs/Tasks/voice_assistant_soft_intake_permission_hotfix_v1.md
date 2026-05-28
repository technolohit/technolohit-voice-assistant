# Voice Assistant Soft Intake Permission Hotfix v1

## Goal

Fix the current live-call regression in Soft Intake.

The assistant now reaches the contact-detail and permission step, but it does not reliably understand short permission answers such as:

```text
Ja.
Ja gerne.
Okay.
In Ordnung.
Passt.
Live logs show that after asking permission, the next caller turn can be transcribed as very short text with:

normalized_intent=unknown
transcript_quality=unclear
soft_intake_state=permission_requested

Then the assistant fails to complete Soft Intake and eventually closes via max turns.

This task must make permission handling deterministic and state-first.

Critical Problem

Current behavior:

Assistant: Danke. Darf ich diese Information an unser Team weitergeben, damit sich jemand bei Ihnen meldet?
Caller: Ja gerne.
System: intent=unknown, quality=unclear
Assistant: does not complete permission
Then max_turns close

Expected behavior:

Assistant: Darf unser Team Sie dazu kontaktieren?
Caller: Ja gerne.
Assistant: Danke. Ich gebe Ihre Anfrage an unser Team weiter.
Conversation can end cleanly.
Product Decisions

Keep:

German only
no lead extraction
no writes to voice.leads
no writes to voice.call_summaries
no n8n
no notifications
no Botinteg integration
no CRM
no calendar booking
no caller ID capture
no new migrations unless absolutely unavoidable
no major architecture refactor
In Scope
1. Permission State Must Override Intent Quality

Inspect:

voice-bridge/src/turn-assistant.js

If Soft Intake is in:

soft_intake_state = permission_requested
soft_intake_waiting_for = permission

then the next caller turn must be interpreted as a permission answer before generic intent handling, transcript quality checks, LLM fallback, or max-turn logic.

Do not require:

transcript_quality=clear
detected_intent=permission_yes

Short permission answers are often short and may be marked as unclear.

2. Add Deterministic Permission Yes/No Detection

Add state-specific permission detection helpers.

Positive examples:

ja
ja gerne
ja bitte
genau
okay
ok
in ordnung
passt
dürfen sie
können sie
machen sie
ist okay
das ist okay
einverstanden
gerne

Normalize aggressively:

lowercase
trim punctuation
remove filler words
tolerate spaces
tolerate short STT output
tolerate okey, oke, okay
tolerate ja, gerne
tolerate jagern / close variants if simple normalization can handle it safely

Negative examples:

nein
nee
lieber nicht
möchte ich nicht
keine daten
nicht weitergeben
nein danke

If permission positive:

Danke. Ich gebe Ihre Anfrage an unser Team weiter.

If permission negative:

Kein Problem. Sie können uns auch direkt per E-Mail unter info@technolohit.com erreichen.

If permission unclear:

Ask one short retry only:

Darf unser Team Sie dazu kontaktieren?

After one unclear retry, close safely:

Ohne klare Bestätigung gebe ich keine Kontaktdaten weiter. Sie können uns direkt unter info@technolohit.com erreichen.
3. Shorten Permission Question

Current permission question is too long and playback takes too much time.

Replace:

Danke. Darf ich diese Information an unser Team weitergeben, damit sich jemand bei Ihnen meldet?

with:

Danke. Darf unser Team Sie dazu kontaktieren?

This is shorter, more natural, and easier for callers to answer.

4. Do Not Ask For Permission Repeatedly

If permission is already requested and caller gives a positive or negative answer, do not ask permission again.

Expected state transitions:

permission_requested + positive answer
→ completed
→ final thanks

permission_requested + negative answer
→ declined
→ info@technolohit.com fallback

permission_requested + unclear answer
→ permission_retry_once

permission_retry_once + unclear answer
→ failed
→ safe close
5. Preserve Contact Detail Attempt Without Over-Validation

If the system has reached permission state, assume a contact detail attempt was captured.

Do not go back to asking:

Welche E-Mail-Adresse dürfen wir ...

unless the previous state was truly contact_detail_requested and no detail attempt happened.

In permission state, the only job is permission yes/no.

6. Fix Max Turns During Permission State

If waiting for permission, do not trigger generic max_turns before permission yes/no is processed.

If turn limit is reached while waiting for permission:

first process the caller response as permission
only close if permission remains unclear after retry

Do not emit generic callback-time close.

7. Metadata / Events

Add or update metadata where feasible:

soft_intake_state
soft_intake_waiting_for
permission_detected
permission_detection_source
permission_retry_count
contact_permission_requested
contact_permission_granted
soft_intake_completed
soft_intake_failed_reason
max_turns_blocked_by_permission_state

Use existing JSONB metadata/event paths.

No migration.

Do not store structured email/phone in voice.leads.

8. Add Unit-Like Static Checks If Existing Test Pattern Exists

If the repo has lightweight validation helpers or test patterns, add simple checks for permission detection.

Cases:

Ja.
Ja gerne.
Okay.
In Ordnung.
Passt.
Nein.
Lieber nicht.

If there is no test framework, document manual validation in the report.

Out of Scope

Do not implement:

lead extraction
post-call summary
writes to voice.leads
writes to voice.call_summaries
n8n
email notification
Telegram notification
Botinteg integration
CRM
calendar booking
caller ID capture
migrations
major runtime refactor
Docker Image Build And Push Required

After implementation and validation pass, build and push a new Docker image.

Repository:

thnhit/technhvoice

Required tag:

voice-bridge-soft-intake-permission-hotfix-v1-YYYYMMDD-HHMMSS

Also push:

voice-bridge-latest

Also include git SHA tag if existing release script supports it.

The implementation report must include:

exact image tag
digest
build command
push command
validation output
sanity check output
Validation

Run:

node --check voice-bridge/src/config.js
node --check voice-bridge/src/index.js
node --check voice-bridge/src/turn-assistant.js
node --check voice-bridge/src/persist.js
npm run validate
Manual QA Scenarios
Scenario 1 — Permission Positive

Flow:

Caller: Was kostet eine Website?
Assistant: ...
Caller: Per E-Mail bitte.
Assistant: Welche E-Mail-Adresse dürfen wir für die Rückmeldung verwenden?
Caller: max punkt test at gmail punkt com
Assistant: Danke. Darf unser Team Sie dazu kontaktieren?
Caller: Ja gerne.

Expected:

Danke. Ich gebe Ihre Anfrage an unser Team weiter.

No repeated permission question.

No generic max-turn close.

Scenario 2 — Permission Short Yes

Caller:

Ja.

Expected:

Danke. Ich gebe Ihre Anfrage an unser Team weiter.
Scenario 3 — Permission Okay

Caller:

Okay.

Expected:

Danke. Ich gebe Ihre Anfrage an unser Team weiter.
Scenario 4 — Permission Negative

Caller:

Nein, lieber nicht.

Expected:

Kein Problem. Sie können uns auch direkt per E-Mail unter info@technolohit.com erreichen.
Scenario 5 — Permission Unclear Once

Caller:

ähm

Expected:

Darf unser Team Sie dazu kontaktieren?

If unclear again:

Ohne klare Bestätigung gebe ich keine Kontaktdaten weiter. Sie können uns direkt unter info@technolohit.com erreichen.
SQL QA Queries

Include in report and sysadmin guide:

SELECT cs.external_call_id,
       ct.speaker,
       ct.sequence_number,
       ct.metadata->>'turn_index' AS turn_index,
       ct.metadata->>'detected_intent' AS intent,
       ct.metadata->>'transcript_quality' AS quality,
       ct.metadata->>'soft_intake_state' AS soft_intake_state,
       ct.metadata->>'soft_intake_waiting_for' AS waiting_for,
       ct.metadata->>'permission_detected' AS permission_detected,
       ct.metadata->>'permission_detection_source' AS permission_source,
       ct.metadata->>'permission_retry_count' AS permission_retry_count,
       ct.metadata->>'contact_permission_requested' AS permission_requested,
       ct.metadata->>'contact_permission_granted' AS permission_granted,
       ct.metadata->>'soft_intake_completed' AS completed,
       ct.metadata->>'soft_intake_failed_reason' AS failed_reason,
       ct.metadata->>'used_template_response' AS template,
       ct.metadata->>'used_llm_response' AS llm,
       length(ct.text) AS text_len,
       left(ct.text, 250) AS text_preview,
       ct.created_at
FROM voice.call_transcripts ct
JOIN voice.call_sessions cs ON cs.id = ct.call_session_id
WHERE ct.metadata->>'transcript_scope' = 'turn'
ORDER BY ct.created_at DESC
LIMIT 80;
SELECT cs.external_call_id,
       ce.event_type,
       ce.payload,
       ce.occurred_at
FROM voice.call_events ce
JOIN voice.call_sessions cs ON cs.id = ce.call_session_id
WHERE ce.event_type IN (
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

docs/Tasks/sysadmin_voice_bridge_soft_intake_permission_hotfix_v1.md

It must include:

Exact Docker image tag and digest
Pull command
Docker compose restart command
Verify running image command
Safe log viewing command using docker logs --since
SQL QA queries
Manual call scenarios
Success criteria
Failure criteria
Rollback command/notes

Expected deployment path:

/opt/technolohit-voice/asterisk

Expected command style:

cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE='thnhit/technhvoice:<NEW_TAG_OR_DIGEST>'

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge

docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}} image_id={{.Image}}'

TEST_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker logs --since="$TEST_START_ISO" -f technolohit-voice-bridge

Do not instruct sysadmin to delete recordings, DB rows, or volumes.

Implementation Report Required

Create:

docs/Tasks/voice_assistant_soft_intake_permission_hotfix_v1_report.md

Report must include:

# Voice Assistant Soft Intake Permission Hotfix v1 Report

## Files Changed
## Root Cause
## Fix Summary
## Permission State Priority
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

Ja gerne after permission question completes Soft Intake
Ja after permission question completes Soft Intake
Okay after permission question completes Soft Intake
Nein after permission question declines Soft Intake
permission question is shorter
permission is not asked repeatedly
max-turn does not override permission state
no lead extraction is added
no voice.leads writes are added
no n8n/notification/Botinteg/CRM/calendar integration is added
validation passes
Docker image is built and pushed to thnhit/technhvoice
sysadmin deployment guide is created
implementation report is created