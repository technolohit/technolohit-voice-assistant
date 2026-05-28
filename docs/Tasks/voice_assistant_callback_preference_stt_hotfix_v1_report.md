# Voice Assistant Callback Preference STT Hotfix v1 Report

## Problem From Logs
The latest QA logs showed that when the assistant asked:

```text
Möchten Sie lieber einen Rückruf oder uns direkt per E-Mail schreiben?
```

the caller answered with callback intent, but STT produced phrases like:

- `Holt ruf bitte.`
- `Holt Ruf, bitte.`
- `Halt auf.`

These were stored as `normalized_intent=unknown` / `transcript_quality=unclear`, so the assistant stayed in `contact_preference_requested` and then failed with an email fallback. This made a real callback request look like a refusal or unknown answer.

## Fix
- Added state-specific callback preference recognition for real STT variants seen in the logs:
  - `holt ruf`
  - `hold ruf`
  - `hohl ruf`
  - `halt auf`
  - `ruf bitte`
  - existing `rückruf`, `ruckruf`, `rueckruf`, `anruf`, `telefon`, `handy`
- This logic only applies while the assistant is waiting for contact preference, so it does not broadly reinterpret unrelated caller text.
- Changed the failure text for unclear contact preference so it no longer closes with only an email fallback after the caller tried to request callback.

## Expected Result
For this flow:

```text
Caller: Ich interessiere mich für eine intelligente Webseite.
Assistant: ... Möchten Sie lieber einen Rückruf oder uns direkt per E-Mail schreiben?
Caller: Rückruf bitte.  (even if STT hears "Holt ruf bitte")
```

the assistant should now move to callback flow:

```text
Welche Telefonnummer dürfen wir für den Rückruf notieren?
```

## Validation
- `node --check voice-bridge/src/config.js` -> pass
- `node --check voice-bridge/src/index.js` -> pass
- `node --check voice-bridge/src/turn-assistant.js` -> pass
- `node --check voice-bridge/src/persist.js` -> pass
- `npm run validate` -> pass

## Docker Image
- Repository: `thnhit/technhvoice`
- Tag: `voice-bridge-callback-preference-stt-hotfix-v1-20260521-141650`
- Digest: `sha256:127134e462ba167722b749f9649f07f866b9766afc21d668a07922da8adfd814`
- Also pushed:
  - `voice-bridge-latest`
  - `voice-bridge-85dbb09`

## Deploy
```bash
cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE='thnhit/technhvoice@sha256:127134e462ba167722b749f9649f07f866b9766afc21d668a07922da8adfd814'

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## QA
Use a fresh log window:

```bash
TEST_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker logs --since="$TEST_START_ISO" -f technolohit-voice-bridge
```

Manual scenario:

1. Caller: `Ich interessiere mich für eine intelligente Webseite.`
2. Assistant asks Rückruf or direct email.
3. Caller: `Rückruf bitte.`
4. Expected assistant response: `Welche Telefonnummer dürfen wir für den Rückruf notieren?`
5. It must not answer only with `info@technolohit.com` in this callback path.
