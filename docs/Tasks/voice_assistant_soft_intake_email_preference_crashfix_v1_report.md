# Voice Assistant Soft Intake Email Preference Crashfix v1 Report

## Root Cause
Production logs showed the assistant stopped immediately after the caller answered `Per E-Mail bitte`.

The runtime error was:

```text
[voice-assistant] turn failed reason=isPermissionDenied is not defined
```

This happened in `voice-bridge/src/turn-assistant.js` because the permission hotfix replaced permission detection with `detectPermissionAnswer()`, but one pre-permission refusal check still called the removed helper `isPermissionDenied()`.

The same logs also showed `Per E-Mail bitte` could be transcribed with `normalized_intent=unknown`, so the email preference matcher needed to accept STT-normalized `e mail` forms as well as `e-mail`.

## Fix Summary
- Restored `isPermissionDenied()` as a wrapper around `detectPermissionAnswer()`.
- Expanded email preference detection for:
  - `per e mail`
  - `e mail bitte`
  - `email bitte`
  - `e mail ist besser`
- Kept the scope limited to the crash and email-preference recognition.
- No lead extraction, no DB migration, no notification/CRM/n8n changes.

## Files Changed
- `voice-bridge/src/turn-assistant.js`

## Validation
- `node --check voice-bridge/src/config.js` -> pass
- `node --check voice-bridge/src/index.js` -> pass
- `node --check voice-bridge/src/turn-assistant.js` -> pass
- `node --check voice-bridge/src/persist.js` -> pass
- `npm run validate` -> pass

## Docker Image
- Repository: `thnhit/technhvoice`
- Tag: `voice-bridge-soft-intake-email-preference-crashfix-v1-20260521-013647`
- Also pushed: `voice-bridge-latest`
- Also pushed: `voice-bridge-85dbb09`
- Digest: `sha256:c3e890490c552acfdaf228561f59179b60c26358d53e9941dd6de77a4e1d6fed`

## Deployment
Use the digest-pinned image:

```bash
cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE='thnhit/technhvoice@sha256:c3e890490c552acfdaf228561f59179b60c26358d53e9941dd6de77a4e1d6fed'

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## QA Scenario
Manual call:

1. Caller: `Was kostet eine Website?`
2. Assistant asks email/phone preference.
3. Caller: `Per E-Mail bitte.`
4. Expected: assistant asks `Welche E-Mail-Adresse dürfen wir für die Rückmeldung verwenden?`
5. No `isPermissionDenied is not defined` error appears in logs.

Safe log command:

```bash
TEST_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker logs --since="$TEST_START_ISO" -f technolohit-voice-bridge
```

## Rollback
If needed, rollback to the previous known image by setting `VOICE_BRIDGE_IMAGE` to the previous immutable tag or digest and running the same compose `pull` and `up -d` commands.
