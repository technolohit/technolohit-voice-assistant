# Voice Assistant Caller ID Capture v1 Report

Date: 2026-05-21

## Summary

Implemented Phase 4 (Caller ID Capture) in `voice-bridge` so callback flow can use caller ID when available, persist it in call session data, and ask for callback permission directly under the same number instead of forcing callers to repeat their phone number by voice.

## Files Changed

- `voice-bridge/src/audiosocket.js`
- `voice-bridge/src/db.js`
- `voice-bridge/src/persist.js`
- `voice-bridge/src/turn-assistant.js`
- `voice-bridge/README.md`
- `docs/Tasks/technolohit_voice_agent_productization_blueprint.md`

## Runtime Changes

1. Caller ID ingestion at connection open:
   - Added optional parsing of caller ID metadata from AudioSocket UUID payload.
   - Supported payload forms:
     - JSON: `{"uuid":"...","caller_phone_raw":"+49...","caller_phone_source":"..."}`
     - KV: `uuid=...;caller_phone_raw=+49...;caller_phone_source=...`

2. Caller ID persistence:
   - `createCallSession(...)` now writes:
     - `caller_phone_raw`
     - `caller_phone_normalized`
   - Caller phone metadata/source is also stored in call metadata and `call_started` event payload.

3. Soft intake callback behavior:
   - If caller chooses callback and caller ID exists:
     - skip `Welche Telefonnummer dürfen wir für den Rückruf notieren?`
     - ask directly:
       - `Danke. Darf unser Team Sie unter dieser Nummer zurückrufen?`
   - If caller ID is missing, existing voice phone capture path remains unchanged.

4. Intake telemetry:
   - Added `contact_detail_source` (e.g., `caller_id`, `voice`) to intake metadata and lead/event payloads.

## Behavior Impact

- Better caller experience for callback requests.
- Fewer STT failures around spoken phone numbers.
- Cleaner lead rows for callback use cases when caller ID is available.
- No breaking change for existing calls that do not provide caller ID metadata.

## Docker Image

Pushed:

```text
thnhit/technhvoice:voice-bridge-caller-id-capture-v1-20260521-190123
thnhit/technhvoice:voice-bridge-latest
thnhit/technhvoice:voice-bridge-85dbb09
```

Digest:

```text
sha256:f90cca2c2c7508f1bddf3fb92c9207dfb5c4237cfa047e5573f1b14a589b84a7
```

Runtime metadata verified inside image:

```text
BUILD_VERSION=voice-bridge-caller-id-capture-v1-20260521-190123
IMAGE_TAG=voice-bridge-caller-id-capture-v1-20260521-190123
GIT_SHA=85dbb09
```

## Validation

Passed:

```bash
node --check voice-bridge/src/config.js
node --check voice-bridge/src/index.js
node --check voice-bridge/src/audiosocket.js
node --check voice-bridge/src/turn-assistant.js
node --check voice-bridge/src/persist.js
node --check voice-bridge/src/db.js
```

Image metadata check passed:

```bash
docker run --rm --entrypoint sh thnhit/technhvoice:voice-bridge-caller-id-capture-v1-20260521-190123 -lc 'printenv BUILD_VERSION IMAGE_TAG GIT_SHA'
```

## Manual QA Matrix

| Caller Path | Expected |
|---|---|
| `Per Anruf bitte.` with caller ID present in UUID payload | Assistant asks `Darf unser Team Sie unter dieser Nummer zurückrufen?` |
| Caller says `Ja.` to permission | Lead/event written with `contact_detail_source=caller_id` and normalized phone |
| `Per Anruf bitte.` without caller ID metadata | Assistant asks for spoken phone number (existing behavior) |
| Caller says spoken number then `Ja.` | Existing voice-based callback path still works |
| `Per E-Mail bitte.` | Unchanged direct email path to `info@technolohit.com` |

## Out Of Scope Confirmed

- No new DB migration required.
- No Asterisk dialplan file change in this repo.
- No post-call summary extraction changes.
- No n8n/CRM notification changes.
