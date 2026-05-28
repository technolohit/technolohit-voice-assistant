# Voice Assistant Soft Intake v1

## Goal

Implement a lightweight, polite, DSGVO-conscious soft intake flow for the TechnoloHit Voice Assistant.

The assistant should not interrogate callers or behave like a long form.

When a caller shows interest, asks for a callback, asks about pricing, mentions the email campaign, asks for a human, or wants the team to follow up, the assistant should briefly ask how the caller wants to be contacted:

```text
Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?
This task must not implement full lead extraction or write to voice.leads.

The goal is to improve follow-up readiness while keeping the live call experience human, short, and low-risk.

Background

The Soft Intake questions inspection confirmed:

Caller phone number is not currently populated by voice-bridge into voice.call_sessions.
Runtime does not currently write to voice.leads.
voice.call_transcripts.metadata and voice.call_events.payload can store additional JSONB metadata without migrations.
ctx.assistantTurn exists and is the safest low-risk place to store lightweight per-call intake state.
Email and phone extraction from spoken German is unreliable, so contact collection must be optional, short, and permission-based.
Event-based permission/intake milestones are safer than writing lead rows in this phase.
Product Decisions

Keep these decisions:

Language: German only
Assistant identity: digitaler Assistent von TechnoloHit
No human name
No exact pricing
No ranking guarantees
No DSGVO/compliance guarantees
No forced data collection
No long form
No lead extraction
No writes to voice.leads
No writes to voice.call_summaries
No n8n
No Botinteg integration
No CRM integration
No calendar booking
No notification workflow
In Scope
1. Add Lightweight Intake State

Use existing in-memory per-call state:

ctx.assistantTurn

Add a small intake object such as:

ctx.assistantTurn.intake = {
  handoffRequested: false,
  callbackRequested: false,
  contactPreferenceAsked: false,
  contactPreference: null,
  contactPermissionRequested: false,
  contactPermissionGranted: null,
  contactDetailAttempted: false,
  contactDetailType: null
}

Exact naming can follow the existing code style.

Requirements:

no architecture refactor
no DB migration
state is per-call only
do not persist sensitive extracted values as lead data
use metadata/events only for milestones
2. Add / Strengthen Soft Intake Intents

Inspect current detectIntent in:

voice-bridge/src/turn-assistant.js

Add or strengthen intent detection for:

handoff_requested
callback_request
contact_preference_email
contact_preference_phone
email_provided
phone_provided
refuses_contact_details

Use tolerant German patterns.

handoff_requested

Examples:

ich möchte mit jemandem sprechen
ich möchte mit einem menschen sprechen
kann mich jemand zurückrufen
ich möchte einen mitarbeiter sprechen
geben sie das bitte weiter
team soll sich melden
contact_preference_email

Examples:

per email
per e-mail
per mail
schreiben sie mir
per nachricht
email ist besser
contact_preference_phone

Examples:

telefonisch
rufen sie mich an
per telefon
rückruf
telefon ist besser
email_provided

Detect likely email-like utterances but do not over-trust it.

Patterns may include:

@
punkt de
punkt com
gmail
outlook
web.de
gmx
mail
phone_provided

Detect likely phone-like utterances but do not over-trust it.

Patterns may include:

null
eins
zwei
drei
vier
fünf
sechs
sieben
acht
neun
plus vier neun
017
015
016
refuses_contact_details

Examples:

möchte ich nicht sagen
lieber nicht
keine daten
ich schreibe ihnen selbst
ich sende eine email
3. Add Soft Intake Templates

Add short deterministic templates.

The assistant should ask at most one intake question at a time.

If caller asks for human / callback / team follow-up
Natürlich. Ich nehme nur kurz auf, wie unser Team Sie erreichen kann. Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?
If caller is interested in Smart Website / pricing / free analysis

After one short useful answer, ask:

Wenn Sie möchten, gebe ich Ihre Anfrage an unser Team weiter. Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?
If caller chooses email
Welche E-Mail-Adresse dürfen wir für die Rückmeldung verwenden?
If caller chooses phone

Because caller ID is not confirmed reliable, ask:

Welche Telefonnummer dürfen wir für den Rückruf notieren?

Do not assume the current caller number is available.

After caller provides contact detail

Do not over-validate in this phase.

Ask permission:

Danke. Darf ich diese Information an unser Team weitergeben, damit sich jemand bei Ihnen meldet?
If permission granted
Danke. Ich gebe Ihre Anfrage an unser Team weiter.
If caller refuses details
Kein Problem. Sie können uns auch direkt per E-Mail unter info@technolohit.com erreichen.
If caller is impatient
Verstanden. Ich halte es kurz: Wie darf unser Team Sie erreichen?
4. Persist Intake Milestones As Events / Metadata

Do not write to voice.leads.

Use existing JSONB event payloads and/or transcript metadata.

Add lightweight event payloads where feasible via existing voice.call_events.

Suggested event types:

soft_intake_started
contact_preference_requested
contact_preference_detected
contact_detail_requested
contact_permission_requested
contact_permission_granted
contact_permission_denied
soft_intake_declined

Use existing insertCallEvent path via voice-bridge/src/persist.js.

If adding wrapper functions in persist.js, keep them small and consistent with existing style.

Metadata keys can include:

handoff_requested
callback_requested
contact_preference_asked
contact_preference_detected
contact_permission_requested
contact_permission_granted
soft_intake_state

Do not persist raw sensitive contact details as structured lead fields in this task.

If contact detail appears in transcript, it will naturally remain in transcript for now; do not add extra copies outside transcript/event metadata.

5. Keep Conversation Short

Rules:

one question at a time
no more than 2 short sentences
never ask for company, email, phone, website, and callback time all at once
do not pressure the caller
if caller wants a human, move quickly to contact preference
if caller declines, give info@technolohit.com

Avoid:

Für welches Unternehmen rufen Sie an, wie ist Ihre Website, was ist Ihre E-Mail, Telefonnummer und wann passt ein Rückruf?

Preferred:

Natürlich. Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?
6. Update Knowledge File

Update:

voice-bridge/knowledge/technolohit.md

Add concise Soft Intake rules:

ask contact preference only when caller shows interest or asks for team/human/callback
do not collect unnecessary data
explain purpose briefly
ask permission before passing information to team
offer info@technolohit.com if caller declines
do not claim DSGVO compliance
do not pressure callers
7. Caller ID Handling

Do not implement caller ID capture in this task.

Document clearly in the report:

caller phone number is not currently populated by voice-bridge
phone callback flow should ask for a phone number
future caller ID capture requires Asterisk/dialplan work

Do not assume caller ID.

Out of Scope

Do not implement:

lead extraction
writes to voice.leads
writes to voice.call_summaries
post-call summaries
n8n
email notification
Telegram notification
CRM integration
Botinteg integration
calendar booking
caller ID capture from Asterisk
new database migrations unless absolutely unavoidable
multi-tenant platform
customer deployment automation
Files Likely To Change

Expected files:

voice-bridge/src/turn-assistant.js
voice-bridge/src/persist.js
voice-bridge/knowledge/technolohit.md
voice-bridge/README.md

Optional if needed:

voice-bridge/src/config.js
voice-bridge/.env.example
.env.example

Only add env vars if there is a clear need.

Suggested Optional Config

If a toggle is useful, add:

VOICE_ASSISTANT_SOFT_INTAKE_ENABLED=true

Default should be safe and documented.

Do not make the feature depend on external services.

Verification Requirements

Run:

node --check voice-bridge/src/config.js
node --check voice-bridge/src/index.js
node --check voice-bridge/src/turn-assistant.js
npm run validate

If persist.js is changed:

node --check voice-bridge/src/persist.js
Manual QA Scenarios

Document static/manual expected behavior.

Scenario 1 — Human handoff

Caller:

Ich möchte mit jemandem sprechen.

Expected:

Natürlich. Ich nehme nur kurz auf, wie unser Team Sie erreichen kann. Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?
Scenario 2 — Email preference

Caller:

Per E-Mail bitte.

Expected:

Welche E-Mail-Adresse dürfen wir für die Rückmeldung verwenden?
Scenario 3 — Phone preference

Caller:

Telefonisch bitte.

Expected:

Welche Telefonnummer dürfen wir für den Rückruf notieren?
Scenario 4 — Permission

Caller provides contact detail.

Expected:

Danke. Darf ich diese Information an unser Team weitergeben, damit sich jemand bei Ihnen meldet?
Scenario 5 — Refusal

Caller:

Ich möchte keine Daten angeben.

Expected:

Kein Problem. Sie können uns auch direkt per E-Mail unter info@technolohit.com erreichen.
Scenario 6 — Smart Website interest

Caller:

Ich interessiere mich für eine intelligente Website.

Expected:

Short Smart Website answer, then optional handoff:

Wenn Sie möchten, gebe ich Ihre Anfrage an unser Team weiter. Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?
Scenario 7 — Pricing

Caller:

Was kostet eine Website?

Expected:

No exact price, then optional handoff/contact preference.

Scenario 8 — Email campaign

Caller:

Ich habe Ihre E-Mail bekommen.

Expected:

Short email campaign template, then contact preference.

Report Required

Create:

docs/Tasks/voice_assistant_soft_intake_v1_report.md

Report must include:

# Voice Assistant Soft Intake v1 Report

## Files Changed
## Intake State Design
## Intents Added / Updated
## Templates Added / Updated
## Event / Metadata Persistence
## Caller ID Decision
## Knowledge Updates
## Validation Results
## Manual QA Matrix
## Out-of-Scope Confirmed
## Deferred Follow-ups
Success Criteria

This task is complete when:

caller can ask for human/team/callback and gets a short contact-preference question
assistant can ask email vs phone without sounding intrusive
assistant asks permission before passing information to the team
caller refusal is handled politely
no lead rows are written
no call summaries are written
no n8n/notification/Botinteg/CRM/calendar integration is added
no migration is created unless explicitly justified
intake milestones are recorded via existing JSONB metadata/events where feasible
validation passes
report is created
Final Reminder

This is still not a lead pipeline.

This is only Soft Intake.

The goal is a better phone experience and a safer handoff path.