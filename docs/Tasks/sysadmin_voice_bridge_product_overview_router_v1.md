# Sysadmin Guide: Voice Bridge Product Overview Router v1

Date: 2026-05-21

## Image To Test

Use this exact immutable image:

```text
thnhit/technhvoice:voice-bridge-product-overview-router-v1-20260521-175634
```

Digest:

```text
sha256:058cfc139c374e8980afa1befdfcdd6c2654afd873887e38b802cd602ec351f3
```

Do not deploy by `voice-bridge-latest` for QA; use the immutable tag above.

## Deploy

```bash
cd /opt/technolohit-voice/asterisk

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-product-overview-router-v1-20260521-175634 \
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-product-overview-router-v1-20260521-175634 \
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

No database migration is required for this release.

## Verify Running Image And Metadata

```bash
docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'

docker exec technolohit-voice-bridge sh -lc 'printenv BUILD_VERSION IMAGE_TAG GIT_SHA'

docker logs --since=10m technolohit-voice-bridge \
| egrep -i 'startup|build_version|image_tag|git_sha|voice-assistant|ERROR|WARNING' || true
```

Expected:

```text
BUILD_VERSION=voice-bridge-product-overview-router-v1-20260521-175634
IMAGE_TAG=voice-bridge-product-overview-router-v1-20260521-175634
GIT_SHA=85dbb09
```

## Manual Live-Call Tests

1. Caller: `Welche Produkte bieten Sie an?`
   Expected: lists Smart Websites, AISeoQ, Botinteg, LokalKI, digitale Rezeption.

2. Caller after product overview: `Nummer drei.`
   Expected: Botinteg answer, no LLM fallback.

3. Caller: `Was ist LokalKI?`
   Expected: private/local AI explanation; no compliance or security guarantee.

4. Caller: `Erzähl mehr über Smart Website.`
   Expected: Smart Website explanation; no generic marketing paragraph.

5. Caller after product explanation: `Ja.`
   Expected: asks whether caller prefers callback or direct email.

6. Caller after contact preference prompt: `Per E-Mail bitte.`
   Expected: directs caller to `info@technolohit.com`, does not ask to spell an email address.

7. Caller after contact preference prompt: `Per Anruf bitte.`
   Expected: asks for callback phone number.

## Logs

Use a fresh QA window:

```bash
export QA_START_UTC="$(date -u -d '20 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"

docker logs --since="$QA_START_UTC" technolohit-voice-bridge \
| egrep -i 'turn transcribed|response created|conversation finished|product_flow|soft_intake|ERROR|WARNING' || true
```

Expected product logs include:

```text
normalized_intent=product_overview_request ... used_template_response=true used_llm_response=false ... product_flow_state=awaiting_selection
normalized_intent=product_selection_botinteg ... used_template_response=true used_llm_response=false ... product_interest=botinteg
```

## SQL QA

```bash
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -P pager=off -c "
SELECT cs.external_call_id,
       ct.speaker,
       ct.sequence_number,
       ct.metadata->>'turn_index' AS turn_index,
       ct.metadata->>'detected_intent' AS intent,
       ct.metadata->>'used_template_response' AS template,
       ct.metadata->>'used_llm_response' AS llm,
       ct.metadata->>'product_flow_state' AS product_flow_state,
       ct.metadata->>'product_interest' AS product_interest,
       ct.metadata->>'product_interest_name' AS product_interest_name,
       ct.metadata->>'soft_intake_state' AS soft_intake_state,
       left(ct.text, 220) AS text_preview,
       ct.created_at
FROM voice.call_transcripts ct
JOIN voice.call_sessions cs ON cs.id = ct.call_session_id
WHERE cs.created_at >= '$QA_START_UTC'::timestamptz
  AND ct.metadata->>'transcript_scope' = 'turn'
ORDER BY cs.created_at, ct.sequence_number;"
```

Success criteria:

- `Welche Produkte...` produces assistant `intent=product_overview_request`.
- `Nummer drei` after overview produces assistant `intent=product_selection_botinteg`.
- Known product paths show `template=true` and `llm=false`.
- Product rows include `product_flow_state` and `product_interest`.
- Existing Soft Intake still works for email/callback.

Failure criteria:

- Product overview falls through to unknown/LLM.
- `Nummer drei` is treated as unclear after product overview.
- Product rows have empty product metadata.
- Startup logs still show `image_tag=unset` or wrong `BUILD_VERSION`.

## Rollback

Set `VOICE_BRIDGE_IMAGE` to the previous immutable tag and rerun:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

No DB rollback is required because this release has no migration.
