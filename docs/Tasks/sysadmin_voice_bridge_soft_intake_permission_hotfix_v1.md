# Sysadmin Guide: Voice Bridge Reception-First Soft Intake

Date: 2026-05-21

## Image To Test

Repository:

```text
thnhit/technhvoice
```

Use this immutable tag:

```text
thnhit/technhvoice:voice-bridge-easybell-soft-intake-logfix-v1-20260521-132205
```

Digest:

```text
sha256:78c3a0f44b6bfc1bc9f9c08dbbe698dbea13908a3de46fe15a42170a6f6d2423
```

Do not deploy by `voice-bridge-latest` for this QA unless explicitly asked. Use the immutable tag above.

## DB Precheck

No new migration is required if the normal voice migrations are already applied.

Before pulling the new image, verify that `voice.leads` exists:

```bash
docker exec -i central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -c "SELECT to_regclass('voice.leads') AS voice_leads_table;"
```

Expected result:

```text
voice.leads
```

If it is missing, apply the normal voice migrations from the repository before deploy. Do not create ad-hoc tables manually.

## Pull And Restart

Run on the cloud server for voice-bridge:

```bash
cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-easybell-soft-intake-logfix-v1-20260521-132205

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

For this release, voice-bridge is deployed from Docker Hub and the Asterisk service must also be rebuilt/recreated from the updated repo template so the Easybell inbound auth fix survives redeploys.

Apply the Asterisk template fix from the updated repo checkout/build context:

```bash
cd /opt/technolohit-voice/asterisk

docker compose -f docker-compose.yml -f docker-compose.prod.yml build asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d asterisk
```

This must render `/etc/asterisk/pjsip.conf` without `auth=easybell-auth` under `[easybell-endpoint]`.

## Verify Running Image

```bash
docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'
docker inspect technolohit-voice-bridge --format '{{index .RepoDigests 0}}'
docker logs --since=10m technolohit-voice-bridge
```

Expected image:

```text
thnhit/technhvoice:voice-bridge-easybell-soft-intake-logfix-v1-20260521-132205
```

Expected digest should include:

```text
sha256:78c3a0f44b6bfc1bc9f9c08dbbe698dbea13908a3de46fe15a42170a6f6d2423
```

Verify Asterisk Easybell endpoint auth policy:

```bash
docker exec technolohit-asterisk asterisk -rx "pjsip show endpoint easybell-endpoint" \
  | egrep -i 'Endpoint:|OutAuth|InAuth|Auth|identify_by|Identify|Match' || true
```

Expected:

- `OutAuth` exists for `easybell-auth`.
- no `InAuth` / endpoint inbound `auth=easybell-auth`.
- endpoint identification is IP-based.

## Safe Logs

Use redacted live logs:

```bash
docker logs --since=20m technolohit-voice-bridge \
  | egrep -i 'voice-assistant|soft_intake|lead_created|response created|conversation finished|ERROR|WARNING' \
  || true
```

Transcript previews should stay `<redacted>` unless `VOICE_LOG_TRANSCRIPT_PREVIEW=true` was explicitly set.

## Manual Live-Call Scenarios

Scenario 1: Email campaign to direct email

Caller:

```text
Ich habe Ihre E-Mail bekommen.
```

Expected assistant:

```text
Danke, dann geht es um die kostenlose Website-Ersteinschaetzung. Moechten Sie lieber einen Rueckruf oder uns direkt per E-Mail schreiben?
```

Caller:

```text
Per E-Mail bitte.
```

Expected assistant:

```text
Gerne. Schreiben Sie uns bitte kurz an info@technolohit.com. Dann kann unser Team direkt antworten.
```

Expected DB:

- `contact_route=email_direct`
- `email_direct_to=info@technolohit.com`
- `no_voice_email_capture=true`
- one `voice.leads` row
- no request to spell the caller's email address

Scenario 2: Callback with permission

Caller:

```text
Ich interessiere mich fuer eine intelligente Website.
```

Expected: assistant asks callback vs direct email.

Caller:

```text
Rueckruf bitte.
```

Expected:

```text
Welche Telefonnummer duerfen wir fuer den Rueckruf notieren?
```

Caller provides a phone number.

Expected:

```text
Danke. Darf unser Team Sie dazu kontaktieren?
```

Caller:

```text
Ja gerne.
```

Expected:

```text
Danke. Ich gebe Ihre Anfrage an unser Team weiter.
```

Expected DB:

- `contact_route=callback`
- `contact_permission_granted=true`
- `normalized_phone` is set if phone normalization succeeds
- one `voice.leads` row linked to the call session

Scenario 3: Callback permission denied

Caller gives phone number, then:

```text
Nein lieber nicht.
```

Expected:

```text
Kein Problem. Sie koennen uns auch direkt per E-Mail unter info@technolohit.com erreichen.
```

Expected DB:

- `contact_permission_granted=false` in transcript/event metadata
- no callback lead should be required for denied permission

## SQL QA Queries

Latest turn transcript metadata:

```sql
SELECT cs.external_call_id,
       ct.speaker,
       ct.sequence_number,
       ct.metadata->>'turn_index' AS turn_index,
       ct.metadata->>'detected_intent' AS intent,
       ct.metadata->>'contact_route' AS contact_route,
       ct.metadata->>'contact_preference_detected' AS preference,
       ct.metadata->>'email_direct_offered' AS email_direct,
       ct.metadata->>'contact_permission_granted' AS permission_granted,
       ct.metadata->>'soft_intake_lead_created' AS lead_created,
       ct.metadata->>'soft_intake_state' AS soft_intake_state,
       length(ct.text) AS text_len,
       left(ct.text, 220) AS text_preview,
       ct.created_at
FROM voice.call_transcripts ct
JOIN voice.call_sessions cs ON cs.id = ct.call_session_id
WHERE ct.metadata->>'transcript_scope' = 'turn'
ORDER BY ct.created_at DESC
LIMIT 40;
```

Soft Intake events:

```sql
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
  'soft_intake_email_directed',
  'contact_permission_requested',
  'contact_permission_granted',
  'contact_permission_denied',
  'soft_intake_lead_created',
  'soft_intake_declined',
  'conversation_finished'
)
ORDER BY ce.occurred_at DESC
LIMIT 40;
```

Latest lead markers:

```sql
SELECT cs.external_call_id,
       vl.id AS lead_id,
       vl.status,
       vl.source,
       vl.normalized_phone,
       vl.metadata->>'contact_route' AS contact_route,
       vl.metadata->>'contact_preference' AS preference,
       vl.metadata->>'email_direct_to' AS email_direct_to,
       vl.metadata->>'no_voice_email_capture' AS no_voice_email_capture,
       vl.metadata->>'contact_permission_granted' AS permission_granted,
       vl.created_at
FROM voice.leads vl
JOIN voice.call_sessions cs ON cs.id = vl.call_session_id
ORDER BY vl.created_at DESC
LIMIT 20;
```

## Success Criteria

- Email preference never asks caller to spell an email address.
- Email preference replies with `info@technolohit.com`.
- Callback preference asks for phone number, then permission.
- `Ja gerne` after permission completes intake.
- Soft Intake does not close badly because of max-turn while waiting for permission.
- `voice.leads` receives a lightweight marker for email-direct and callback-with-permission cases.
- No secrets or raw transcript previews appear in logs by default.

## Failure Criteria

- Assistant asks: `Welche E-Mail-Adresse ...`
- Assistant truncates the fallback address to `info@technolohit`.
- Assistant repeatedly asks permission after `Ja gerne`.
- Email route fails to create a `voice.leads` marker.
- Callback permission path reaches max-turn before processing `Ja gerne`.
- Assistant asks a max-turn callback question after an email-direct or declined intake outcome.
- Logs expose transcript previews while `VOICE_LOG_TRANSCRIPT_PREVIEW=false`.

## Rollback

Set `VOICE_BRIDGE_IMAGE` to the previous immutable image tag and run:

```bash
cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE=<previous-known-good-image>

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

No DB rollback is expected. The new code only uses existing `voice.leads`, `voice.call_events`, and `voice.call_transcripts.metadata`.

