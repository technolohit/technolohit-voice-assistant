# Sysadmin Guide: Voice Bridge Caller ID Capture v1

Date: 2026-05-21

## Image To Test

Use this exact immutable image:

```text
thnhit/technhvoice:voice-bridge-caller-id-capture-v1-20260521-190123
```

Digest:

```text
sha256:f90cca2c2c7508f1bddf3fb92c9207dfb5c4237cfa047e5573f1b14a589b84a7
```

Do not run QA only on `voice-bridge-latest`; use the immutable tag above.

## Deploy

```bash
cd /opt/technolohit-voice/asterisk

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-caller-id-capture-v1-20260521-190123 \
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-caller-id-capture-v1-20260521-190123 \
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

No DB migration is required for this release.

## Verify Running Image And Metadata

```bash
docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'

docker exec technolohit-voice-bridge sh -lc 'printenv BUILD_VERSION IMAGE_TAG GIT_SHA'

docker logs --since=10m technolohit-voice-bridge \
| egrep -i 'startup|build_version|image_tag|git_sha|soft_intake|voice-assistant|ERROR|WARNING' || true
```

Expected:

```text
BUILD_VERSION=voice-bridge-caller-id-capture-v1-20260521-190123
IMAGE_TAG=voice-bridge-caller-id-capture-v1-20260521-190123
GIT_SHA=85dbb09
```

## Caller ID QA Scenarios

1. Caller asks callback and caller ID metadata is present:
   - Caller: `Per Anruf bitte.`
   - Expected assistant: `Danke. Darf unser Team Sie unter dieser Nummer zurückrufen?`
   - Must not ask `Welche Telefonnummer dürfen wir...` in this path.

2. Caller grants permission:
   - Caller: `Ja.`
   - Expected: callback lead marker created.

3. Caller ID absent path:
   - Caller: `Per Anruf bitte.`
   - Expected: asks for phone number by voice (existing fallback path).

4. Direct email path:
   - Caller: `Per E-Mail bitte.`
   - Expected: directs to `info@technolohit.com`, no spoken email capture.

## Logs

Use a fresh QA window:

```bash
export QA_START_UTC="$(date -u -d '20 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"

docker logs --since="$QA_START_UTC" technolohit-voice-bridge \
| egrep -i 'turn transcribed|response created|soft_intake|contact_permission|contact_detail|caller_phone|conversation finished|ERROR|WARNING' || true
```

Look for caller-ID path clues:

```text
... contact_detail_source=caller_id ...
... normalized_intent=contact_preference_phone ...
... normalized_intent=contact_permission_granted ...
```

## SQL QA

```bash
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -P pager=off -c "
SELECT cs.external_call_id,
       cs.caller_phone_raw,
       cs.caller_phone_normalized,
       ce.event_type,
       ce.payload->>'contact_detail_source' AS contact_detail_source,
       ce.payload->>'contact_preference' AS contact_preference,
       ce.payload->>'contact_permission_granted' AS permission_granted,
       ce.occurred_at
FROM voice.call_sessions cs
LEFT JOIN voice.call_events ce ON ce.call_session_id = cs.id
WHERE cs.created_at >= '$QA_START_UTC'::timestamptz
  AND (ce.event_type IN ('call_started','contact_permission_requested','contact_permission_granted','soft_intake_lead_created') OR ce.event_type IS NULL)
ORDER BY cs.created_at DESC, ce.occurred_at ASC
LIMIT 120;"
```

Success criteria:

- `call_sessions` row has caller phone populated when caller ID metadata is provided.
- Callback permission flow with caller ID shows `contact_detail_source=caller_id`.
- No regression in callback flow when caller ID is missing.

## Rollback

Set `VOICE_BRIDGE_IMAGE` to previous immutable tag and rerun:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

No DB rollback required.
