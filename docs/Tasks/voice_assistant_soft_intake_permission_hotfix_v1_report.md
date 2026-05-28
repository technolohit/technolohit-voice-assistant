# Voice Assistant Reception-First Soft Intake Report

Date: 2026-05-21

## Summary

Implemented a reception-first Soft Intake flow for the TechnoloHit voice assistant.

The old MVP tried to capture email addresses by voice. Live testing showed that this is too brittle: callers repeat "per E-Mail bitte", spelling is slow, STT can corrupt addresses, and the call feels like form filling. The new flow avoids voice email capture.

New behavior:

- Interested callers are asked: "Moechten Sie lieber einen Rueckruf oder uns direkt per E-Mail schreiben?"
- If the caller chooses email, the assistant gives `info@technolohit.com` and does not ask for an email address.
- If the caller chooses callback, the assistant asks for a phone number, then asks permission.
- A lightweight row is written to `voice.leads` for email-direct milestones and for callback requests with permission.

## Files Changed

- `voice-bridge/src/turn-assistant.js`
- `voice-bridge/src/persist.js`
- `voice-bridge/src/db.js`
- `voice-bridge/knowledge/technolohit.md`
- `voice-bridge/README.md`
- `docs/voice-database.md`
- `docs/Tasks/voice_assistant_soft_intake_permission_hotfix_v1_report.md`
- `docs/Tasks/sysadmin_voice_bridge_soft_intake_permission_hotfix_v1.md`

## Intake State Design

Soft Intake still uses `ctx.assistantTurn.intake` as lightweight per-call state.

Added/used state fields:

- `contactRoute`: `email_direct` or `callback`
- `contactPreference`: `email` or `phone`
- `emailDirectOffered`: true when the caller is routed to `info@technolohit.com`
- `contactDetailNormalized`: best-effort normalized phone for callback
- `leadCreated`: true when a `voice.leads` row was created

Permission handling remains state-first:

- `waitingFor=permission` is processed before generic intent handling.
- Short positives such as `ja`, `ja gerne`, `okay`, `passt`, `gerne` complete intake.
- Short negatives such as `nein`, `lieber nicht`, `keine daten` decline intake.
- Max turns do not override active permission handling.

## Templates Changed

Reception-first contact prompt:

`Moechten Sie lieber einen Rueckruf oder uns direkt per E-Mail schreiben?`

Email route:

`Gerne. Schreiben Sie uns bitte kurz an info@technolohit.com. Dann kann unser Team direkt antworten.`

Callback phone route:

`Welche Telefonnummer duerfen wir fuer den Rueckruf notieren?`

Permission question:

`Danke. Darf unser Team Sie dazu kontaktieren?`

Permission positive:

`Danke. Ich gebe Ihre Anfrage an unser Team weiter.`

Permission negative:

`Kein Problem. Sie koennen uns auch direkt per E-Mail unter info@technolohit.com erreichen.`

## Lead Persistence

Added `db.insertVoiceLead()` and `persist.onSoftIntakeLeadReady()`.

No schema migration was added. The implementation uses the existing `voice.leads` table from the normal voice migrations.

Lead creation rules:

- Email preference: create a lightweight lead marker with `contact_route=email_direct`, `email_direct_to=info@technolohit.com`, and `no_voice_email_capture=true`.
- Callback preference: create a lead after phone detail attempt plus positive permission.
- Caller ID is not assumed.
- No email address is captured or stored from voice.
- No call summaries, n8n notifications, CRM writes, Botinteg integration, or calendar booking were added.

## Events And Metadata

New/updated event and transcript metadata:

- `contact_route`
- `email_direct_offered`
- `soft_intake_lead_created`
- `soft_intake_email_directed`
- `soft_intake_lead_created`
- existing permission fields remain: `permission_detected`, `permission_detection_source`, `permission_retry_count`, `contact_permission_granted`

The lead event payload contains only safe operational metadata and whether a normalized phone exists. It does not duplicate raw caller transcript or secrets.

## Docker Image

Pushed to Docker Hub:

- `thnhit/technhvoice:voice-bridge-soft-intake-reception-first-v1-20260521-122326`
- Compatibility tag: `thnhit/technhvoice:voice-bridge-soft-intake-permission-hotfix-v1-20260521-122326`
- `thnhit/technhvoice:voice-bridge-latest`
- `thnhit/technhvoice:voice-bridge-85dbb09`

Digest:

`sha256:79eb0450bf3aa0bfa71e0831c76060ce9af65d39282d835c4220b4286ae701f9`

## Validation

Passed:

```bash
node --check voice-bridge/src/config.js
node --check voice-bridge/src/index.js
node --check voice-bridge/src/turn-assistant.js
node --check voice-bridge/src/persist.js
node --check voice-bridge/src/db.js
npm run validate
docker run --rm --entrypoint sh thnhit/technhvoice:voice-bridge-soft-intake-reception-first-v1-20260521-122326 -lc "node --check src/config.js && node --check src/index.js && node --check src/turn-assistant.js && node --check src/persist.js && node --check src/db.js"
```

## Manual QA Matrix

1. Caller: `Ich habe Ihre E-Mail bekommen.`
   Expected: assistant asks callback vs direct email.

2. Caller: `Per E-Mail bitte.`
   Expected: assistant gives `info@technolohit.com`, does not ask caller to spell address, creates `voice.leads` marker with `contact_route=email_direct`.

3. Caller: `Telefonisch bitte.`
   Expected: assistant asks for phone number.

4. Caller gives phone number.
   Expected: assistant asks: `Danke. Darf unser Team Sie dazu kontaktieren?`

5. Caller: `Ja gerne.`
   Expected: assistant says `Danke. Ich gebe Ihre Anfrage an unser Team weiter.` and writes `voice.leads` with `contact_route=callback`.

6. Caller: `Nein lieber nicht.`
   Expected: assistant gives `info@technolohit.com` fallback and does not create callback lead.

## Out Of Scope Confirmed

- No lead extraction pipeline.
- No `voice.call_summaries` writes.
- No n8n.
- No notifications.
- No CRM.
- No Botinteg integration.
- No calendar booking.
- No caller ID capture from Asterisk.
- No Asterisk/Easybell/dialplan changes.

## Deferred Follow-Ups

- Add an internal dashboard view for `voice.leads` after enough live calls prove the flow.
- Consider better German phone-number normalization after production examples.
- Add duplicate matching against Growth prospects later, not in this hotfix.
