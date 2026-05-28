# Voice Assistant + Easybell Logfix Report

Date: 2026-05-21

## What Was Fixed

Two production issues were made permanent in repo source.

1. Easybell inbound INVITEs were failing with `Failed to authenticate` because `[easybell-endpoint]` required inbound digest auth via `auth=easybell-auth`.
2. Soft Intake still behaved poorly after live testing: email preference was sometimes missed, `info@technolohit.com` was truncated to `info@technolohit`, and the assistant kept talking after intake was already completed or declined.

## Asterisk / Easybell Changes

Changed `asterisk/templates/pjsip.conf.template`:

- Removed endpoint inbound auth:
  - removed `auth=easybell-auth` from `[easybell-endpoint]`
- Kept outbound auth:
  - `outbound_auth=easybell-auth` remains in `[easybell-registration]`
  - `outbound_auth=easybell-auth` remains in `[easybell-endpoint]`
- Changed endpoint identification to IP-only:
  - `identify_by=ip`
- Added inline comments explaining why inbound auth is intentionally empty.

Updated `docs/asterisk-easybell-registration.md` with:

- root cause explanation for `Request INVITE from sip.easybell.de failed - Failed to authenticate`
- why outbound registration auth and inbound provider identification are different
- verification command for endpoint OutAuth without InAuth/auth

Verification command:

```bash
docker exec technolohit-asterisk asterisk -rx "pjsip show endpoint easybell-endpoint" \
  | egrep -i 'Endpoint:|OutAuth|InAuth|Auth|identify_by|Identify|Match' || true
```

Expected:

- `OutAuth: easybell-auth`
- no `InAuth: easybell-auth`
- no endpoint `auth=easybell-auth`
- `identify_by=ip`

## Voice-Bridge Changes

Changed `voice-bridge/src/turn-assistant.js`:

- Protected email addresses before sentence limiting so `info@technolohit.com` is not split at `.com`.
- Added state-specific fuzzy preference matching for live STT failures:
  - `Ja, e-mail, bitte`
  - `i medvita`
  - `Per Anruf`
  - `Anruf bitte`
  - `Rückruf bitte`
  - noisy callback STT from logs such as `Morspitze`, `Rot gross bitte`, and `Rotkrostitzel`
- Added `completedIntakeFinishReason()` and now exits the turn loop after final intake states:
  - `soft_intake_email_directed`
  - `soft_intake_completed`
  - `soft_intake_declined`
  - `soft_intake_failed`
- Prevents the bad follow-up where max-turn asks for a callback after the assistant already gave `info@technolohit.com` or after the caller declined.

## Docs Updated

- `voice-bridge/README.md`
- `docs/voice-database.md`
- `docs/asterisk-easybell-registration.md`
- `docs/Tasks/sysadmin_voice_bridge_soft_intake_permission_hotfix_v1.md`

## Validation

Passed locally:

```bash
node --check voice-bridge/src/config.js
node --check voice-bridge/src/index.js
node --check voice-bridge/src/turn-assistant.js
node --check voice-bridge/src/persist.js
node --check voice-bridge/src/db.js
npm run validate
```

Docker Hub image pushed and validated:

```text
thnhit/technhvoice:voice-bridge-easybell-soft-intake-logfix-v1-20260521-132205
sha256:78c3a0f44b6bfc1bc9f9c08dbbe698dbea13908a3de46fe15a42170a6f6d2423
```

Image syntax check passed:

```bash
docker run --rm --entrypoint sh thnhit/technhvoice:voice-bridge-easybell-soft-intake-logfix-v1-20260521-132205 -lc "node --check src/config.js && node --check src/index.js && node --check src/turn-assistant.js && node --check src/persist.js && node --check src/db.js"
```

## Production QA Focus

Test these exact cases:

1. Caller: `Ich habe Ihre E-Mail bekommen.`
   Assistant asks Rückruf vs direct E-Mail.

2. Caller: `Per E-Mail bitte.`
   Assistant says `info@technolohit.com` with `.com`, creates `email_direct` lead marker, then ends the assistant turn loop.

3. Caller: `Per Anruf bitte.`
   Assistant asks for phone number.

4. Caller: noisy callback preference that STT may render as `Morspitze` or `Rot gross bitte`.
   Assistant should still route to callback and ask for phone number.

5. Caller: `Nein, lieber nicht.`
   Assistant gives `info@technolohit.com` with `.com`, then ends the assistant turn loop.

6. Easybell inbound call:
   Asterisk should accept INVITE by provider IP identify, not challenge inbound digest auth.

## Out Of Scope

- No lead extraction pipeline.
- No `voice.call_summaries` writes.
- No n8n or CRM.
- No calendar booking.
- No Asterisk dialplan change.
- No Easybell credential change.
