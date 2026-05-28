# Voice Assistant Product Overview Router v1 Report

Date: 2026-05-21

## Summary

Implemented Phase 1 of the productization plan: the voice assistant can now answer broad product/offer questions, list the five TechnoloHit offers, resolve product selection by name or by number in context, and keep the response deterministic before falling back to the LLM.

## Files Changed

- `voice-bridge/src/turn-assistant.js`
- `voice-bridge/src/persist.js`
- `voice-bridge/knowledge/technolohit.md`
- `voice-bridge/knowledge/products.technolohit.json`
- `voice-bridge/README.md`
- `docs/voice-database.md`
- `docs/Tasks/voice_assistant_product_overview_router_v1.md`
- `docs/Tasks/technolohit_voice_agent_productization_implementation_plan_v1.md`
- `scripts/docker/build-voice-bridge.sh`

## Runtime Logic

Added deterministic product intents:

- `product_overview_request`
- `product_selection_smart_website`
- `product_selection_aiseoq`
- `product_selection_botinteg`
- `product_selection_lokalki`
- `product_selection_voice_agent`
- `product_more_detail_request`
- `compare_products_request`
- `product_interest_confirmed`
- `product_interest_declined`

Product selection by number is context-aware. Bare answers like `drei` or `Nummer drei` only map to a product after the assistant has offered the product overview, so normal phone numbers are not misrouted.

After a product explanation, a short positive answer such as `ja` starts the existing reception-first Soft Intake flow and asks whether the caller prefers callback or direct email.

## Product Catalog

Added editable catalog:

```text
voice-bridge/knowledge/products.technolohit.json
```

The catalog contains five products:

1. Smart Website
2. AISeoQ
3. Botinteg
4. LokalKI
5. Digitale Rezeption

The runtime loads this JSON and falls back to an in-code default if it is missing or invalid.

## Metadata

Assistant transcript metadata now includes:

- `product_flow_state`
- `product_overview_offered`
- `product_awaiting_selection`
- `product_awaiting_interest_confirmation`
- `product_interest`
- `product_interest_name`
- `product_last_intent`

No database migration is required; these are written to existing JSONB metadata/event payloads.

## Docker Image

Pushed:

```text
thnhit/technhvoice:voice-bridge-product-overview-router-v1-20260521-175634
thnhit/technhvoice:voice-bridge-latest
thnhit/technhvoice:voice-bridge-85dbb09
```

Digest:

```text
sha256:058cfc139c374e8980afa1befdfcdd6c2654afd873887e38b802cd602ec351f3
```

Runtime metadata verified inside the image:

```text
BUILD_VERSION=voice-bridge-product-overview-router-v1-20260521-175634
IMAGE_TAG=voice-bridge-product-overview-router-v1-20260521-175634
GIT_SHA=85dbb09
```

Also fixed `scripts/docker/build-voice-bridge.sh` so default `BUILD_VERSION` follows the immutable image tag, not only the git SHA.

## Validation

Passed:

```bash
node --check voice-bridge/src/config.js
node --check voice-bridge/src/index.js
node --check voice-bridge/src/turn-assistant.js
node --check voice-bridge/src/persist.js
node --check voice-bridge/src/db.js
npm run validate
```

Image validation passed:

```bash
docker run --rm --entrypoint sh thnhit/technhvoice:voice-bridge-product-overview-router-v1-20260521-175634 -lc 'printenv BUILD_VERSION IMAGE_TAG GIT_SHA'
docker run --rm --entrypoint sh thnhit/technhvoice:voice-bridge-product-overview-router-v1-20260521-175634 -lc 'node --check src/config.js && node --check src/index.js && node --check src/turn-assistant.js && node --check src/persist.js && node --check src/db.js'
docker run --rm --entrypoint node thnhit/technhvoice:voice-bridge-product-overview-router-v1-20260521-175634 -p "const c=require('/app/knowledge/products.technolohit.json'); c.version + ' products=' + c.products.length"
```

## Manual QA Matrix

| Caller | Expected |
|---|---|
| `Welche Produkte bieten Sie an?` | `product_overview_request`, template, no LLM |
| `Nummer drei.` after product overview | `product_selection_botinteg`, template, no LLM |
| `Was ist LokalKI?` | `product_selection_lokalki`, no legal/security guarantee |
| `Erzähl mehr über Smart Website.` | Smart Website detail, no generic marketing |
| `Ja.` after product explanation | starts Soft Intake contact preference question |
| `Per E-Mail bitte.` after Soft Intake prompt | directs to `info@technolohit.com`, no voice email capture |
| `Per Anruf bitte.` after Soft Intake prompt | asks for callback phone number |

## SQL QA

```sql
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
WHERE ct.metadata->>'transcript_scope' = 'turn'
ORDER BY ct.created_at DESC
LIMIT 40;
```

Expected product rows:

- product overview assistant row: `intent=product_overview_request`, `template=true`, `llm=false`, `product_flow_state=awaiting_selection`
- product selection assistant row: `intent=product_selection_botinteg` or selected product, `template=true`, `llm=false`, `product_interest=<product_id>`
- positive follow-up row: `intent=product_interest_confirmed`, then Soft Intake starts

## Out Of Scope Confirmed

- No Asterisk/Easybell changes
- No DB schema migrations
- No n8n/CRM/notification work
- No Redis/pgvector
- No realtime speech rewrite
- No calendar booking
