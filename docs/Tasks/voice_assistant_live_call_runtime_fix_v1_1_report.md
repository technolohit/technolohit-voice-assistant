# Voice Assistant Live Call Runtime Fix v1.1 Report

Date: 2026-05-20

## Why This Iteration Exists

Cloud live-call testing of `voice-bridge-live-call-runtime-fix-v1` passed Docker/runtime/greeting/privacy checks, but showed several response-quality gaps:

- `Kann ich so einen Telefonassistenten wie du haben für mein Unternehmen?` fell through to LLM instead of `voice_assistant_question`.
- `Können Sie mich morgen zurückrufen?` fell through to LLM instead of `callback_request`.
- Human/AI STT variants such as `Sehen Sie einen Mensch?` were fragile.
- The technology answer was too close to the configured max response length.
- The max-turn callback close could repeat callback wording after a previous answer already asked for callback.
- The generic unknown fallback repeated the "I will write this down for the team" style too often.

## Scope

Changed only voice-bridge assistant intent matching, response templates, max-turn closing behavior, knowledge text, and docs.

No Asterisk, Easybell, Postgres schema, n8n, monitoring, credentials, Docker deployment workflow, or dialplan changes were made.

## Files Changed In This Iteration

- `voice-bridge/src/turn-assistant.js`
- `voice-bridge/README.md`
- `voice-bridge/knowledge/technolohit.md`
- `docs/Tasks/voice_assistant_live_call_runtime_fix_v1_report.md`
- `docs/Tasks/voice_assistant_live_call_runtime_fix_v1_1_report.md`

## Intent Matching Changes

Added/strengthened matching for:

- `voice_assistant_question`
  - `telefonassistent`
  - `telefon assistent`
  - `telefon assistenten`
  - `so einen assistent`
  - `so einen telefon`
  - `assistent wie du`
- `callback_request`
  - `ruckruf`
  - `zuruckrufen`
  - `zuruck rufen`
  - `morgen ... rufen`
  - `morgen ... ruck`
- `human_or_ai_question`
  - `sehen sie ... mensch`
  - `sehn se ... mensch`
  - `einen mensch`
  - `eine person`
  - `real person`
  - `spreche ich ... ki/bot/assistent`

Important normalization detail: after `normalize("NFKD")`, German `Rückruf/zurückrufen` becomes `ruckruf/zuruckrufen`, so the matcher now checks these forms directly.

## Template Changes

Shortened or changed templates:

```text
what:
TechnoloHit baut intelligente Websites und KI-Assistenten für lokale Unternehmen. Geht es um Website, Sichtbarkeit oder Anfragen?

smart_website_interest:
Eine intelligente Website hilft, besser gefunden zu werden und Anfragen sauberer aufzunehmen. Für welches Unternehmen rufen Sie an?

voice_assistant_question:
Ja, so ein Telefonassistent kann Teil der Lösung sein. Soll er Anrufe oder Website-Anfragen vorbereiten?

callback_request:
Gerne. Wann passt Ihnen morgen ein kurzer Rückruf?

generic callback:
Gerne. Wann passt Ihnen ein kurzer Rückruf?

technology_question:
TechnoloHit nutzt eigene KI- und Automatisierungslösungen. Die Details erklärt Ihnen unser Team gern persönlich.

email_campaign_caller:
Danke, dann geht es um die kostenlose Website-Ersteinschätzung. Für welches Unternehmen rufen Sie an?

unknown fallback:
Das kann ich nicht sicher beantworten. Am besten klärt unser Team die Details persönlich.
```

## Max-Turn Closing Change

`VOICE_ASSISTANT_MAX_TURNS=3` was kept.

If the last assistant answer already asked for callback, max-turn closing now uses:

```text
Danke, das reicht für eine erste Einordnung. Unser Team kann die Details persönlich klären.
```

Otherwise it still uses the callback-oriented close:

```text
Ich gebe Ihre Anfrage gerne an unser Team weiter. Wann passt Ihnen ein kurzer Rückruf?
```

This reduces repeated callback wording while still keeping a polite end to the call.

## Validation

Commands run:

```bash
node --check voice-bridge/src/turn-assistant.js
node --check voice-bridge/src/config.js
node --check voice-bridge/src/index.js
node --check voice-bridge/src/persist.js
npm run validate
```

Result: all passed.

## Docker Image Built And Pushed

Repository:

```text
thnhit/technhvoice
```

Exact image for sysadmin test:

```text
thnhit/technhvoice:voice-bridge-live-call-runtime-fix-v1-1-20260520-234814@sha256:c2381081685cb5ad24575d89bc01325daadff3b1135a6d58bc0d444992987dc5
```

Also pushed by the release script:

```text
thnhit/technhvoice:voice-bridge-85dbb09
thnhit/technhvoice:voice-bridge-latest
```

All point to:

```text
sha256:c2381081685cb5ad24575d89bc01325daadff3b1135a6d58bc0d444992987dc5
```

Container sanity check passed:

```text
BUILD_VERSION=85dbb09
/app/audio/greeting.slin present, about 94.5K
/app/audio/greeting.wav present, about 283.6K
/app/knowledge/technolohit.md present
node --check src/config.js PASS
node --check src/index.js PASS
node --check src/turn-assistant.js PASS
```

## SQL Verification Expectations

For the next live test, these rows should be visible in `voice.call_transcripts` metadata:

```text
Caller: Kann ich so einen Telefonassistenten wie du haben für mein Unternehmen?
Expected metadata:
detected_intent=voice_assistant_question
used_template_response=true
used_llm_response=false

Caller: Können Sie mich morgen zurückrufen?
Expected metadata:
detected_intent=callback_request
used_template_response=true
used_llm_response=false

Caller: Sehen Sie einen Mensch?
Expected metadata:
detected_intent=human_or_ai_question
used_template_response=true
used_llm_response=false

Caller: Welche Technik steckt dahinter?
Expected metadata:
detected_intent=technology_question
used_template_response=true
used_llm_response=false
response_chars under 130
```

Query:

```sql
SELECT cs.external_call_id,
       ct.speaker,
       ct.sequence_number,
       ct.metadata->>'turn_index' AS turn_index,
       ct.metadata->>'detected_intent' AS intent,
       ct.metadata->>'transcript_quality' AS quality,
       ct.metadata->>'used_template_response' AS template,
       ct.metadata->>'used_llm_response' AS llm,
       ct.metadata->>'used_clarification_fallback' AS clarification,
       length(ct.text) AS text_len,
       left(ct.text, 250) AS text_preview,
       ct.created_at
FROM voice.call_transcripts ct
JOIN voice.call_sessions cs ON cs.id = ct.call_session_id
WHERE ct.metadata->>'transcript_scope' = 'turn'
ORDER BY ct.created_at DESC
LIMIT 40;
```

## Sysadmin Pull Command

```bash
cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE='thnhit/technhvoice:voice-bridge-live-call-runtime-fix-v1-1-20260520-234814@sha256:c2381081685cb5ad24575d89bc01325daadff3b1135a6d58bc0d444992987dc5'

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}} image_id={{.Image}}'
docker logs --tail=160 technolohit-voice-bridge | egrep -i 'startup|voice-assistant|greeting|ERROR|WARNING' || true
```
