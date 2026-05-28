# Voice Assistant Soft Intake Contact Preference Hotfix v1 Report

## Root Cause
The live logs showed the assistant stayed in `soft_intake_state=contact_preference_requested` after the caller answered the contact preference question.

For turns 2 and 3, OpenAI STT returned short transcripts with:

```text
normalized_intent=unknown
transcript_quality=unclear
soft_intake_state=contact_preference_requested
```

Because the assistant was waiting for contact preference but only used the generic intent detector, it repeated the same "E-Mail oder telefonisch" question.

## Fix Summary
- Added state-specific contact preference detection while waiting for `contact_preference`.
- Recognizes email preference from short/noisy STT variants such as:
  - `e mail`
  - `email`
  - `mail`
  - `per email`
  - `mail bitte`
  - `schreiben`
  - `nachricht`
- Recognizes phone preference from:
  - `telefonisch`
  - `telefon`
  - `anruf`
  - `rufen`
  - `rückruf`
  - `handy`
- Limits contact preference retry to one short retry instead of repeating the same prompt multiple times.

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
- Tag: `voice-bridge-soft-intake-contact-preference-hotfix-v1-20260521-014916`
- Also pushed: `voice-bridge-latest`
- Also pushed: `voice-bridge-85dbb09`
- Digest: `sha256:7c9d0c364c42c7594c3fed374eb805b53aa5310f3c4c0bd558bb2220568bddc5`

## Deploy
```bash
cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE='thnhit/technhvoice@sha256:7c9d0c364c42c7594c3fed374eb805b53aa5310f3c4c0bd558bb2220568bddc5'

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## QA Scenario
1. Caller: `Was kostet eine Website?`
2. Assistant asks contact preference.
3. Caller: `Per E-Mail bitte.`
4. Expected: assistant asks `Welche E-Mail-Adresse dürfen wir für die Rückmeldung verwenden?`
5. Assistant must not repeat `Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?` more than once.

Safe logs:

```bash
TEST_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker logs --since="$TEST_START_ISO" -f technolohit-voice-bridge
```
