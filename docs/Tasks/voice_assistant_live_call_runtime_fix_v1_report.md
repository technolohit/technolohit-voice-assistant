# Voice Assistant Live Call Runtime Fix v1 Report

Date: 2026-05-20

## Summary

Implemented the live-call runtime quality fix for the TechnoloHit voice assistant. Scope stayed limited to voice-bridge runtime quality, greeting audio, turn handling, deterministic intent routing, QA metadata, environment examples, and docs.

No lead extraction, `voice.leads` writes, `voice.call_summaries` writes, n8n, CRM, Botinteg integration, calendar booking, Asterisk/Easybell changes, or schema migrations were added.

## Files Changed

- `.env.example`
- `docs/voice-database.md`
- `docs/Tasks/voice_assistant_live_call_runtime_fix_v1_report.md`
- `voice-bridge/.env.example`
- `voice-bridge/README.md`
- `voice-bridge/audio/greeting.wav`
- `voice-bridge/audio/greeting.slin`
- `voice-bridge/knowledge/technolohit.md`
- `voice-bridge/scripts/generate-greeting-openai.js`
- `voice-bridge/src/config.js`
- `voice-bridge/src/index.js`
- `voice-bridge/src/persist.js`
- `voice-bridge/src/turn-assistant.js`

## Greeting

Greeting source:

```text
voice-bridge/scripts/generate-greeting-openai.js
```

New greeting text:

```text
Hallo, hier ist der digitale Assistent von TechnoloHit. Wobei kann ich Ihnen helfen?
```

Generated output files:

```text
voice-bridge/audio/greeting.wav
voice-bridge/audio/greeting.slin
```

Greeting was regenerated.

Commands used:

```bash
cd voice-bridge
npm run tts:greeting
ffmpeg -y -i audio/greeting.wav -ar 8000 -ac 1 -f s16le -acodec pcm_s16le audio/greeting.slin
```

Note: `npm run audio:convert` could not run in the local Windows shell because `sh` was unavailable, so the documented equivalent `ffmpeg` command was used directly.

Result:

```text
audio/greeting.wav  = 290444 bytes
audio/greeting.slin = 96800 bytes
```

The Docker image packages `voice-bridge/audio/greeting.slin` into `/app/audio/greeting.slin`, so deployment requires rebuilding and redeploying the voice-bridge image.

## Turn Capture Changes

Added adaptive bounded listening:

```env
VOICE_ASSISTANT_MIN_LISTEN_MS=2500
VOICE_ASSISTANT_MAX_LISTEN_MS=10000
VOICE_ASSISTANT_END_SILENCE_MS=900
```

Runtime behavior:

- listens for at least `min_listen_ms`
- tracks speech with a lightweight PCM RMS energy heuristic
- stops after `end_silence_ms` of silence after detected speech
- always stops at `max_listen_ms`
- records `listen_duration_ms`, `speech_end_detected`, and `audio_bytes_captured`

This avoids a blind fixed 5-second cut-off while keeping calls bounded.

## Intent Detection Changes

Strengthened imperfect-STT matching for:

- `seo_guarantee_question`
- `pricing_question`
- `smart_website_interest`
- `voice_assistant_question`
- `email_campaign_caller`
- `human_or_ai_question`
- `free_analysis_request`
- `callback_request`
- `technology_question`
- `english_language`

Examples now covered include:

- `platz eins`, `platz 1`, `erste seite`, `google bringen`, `bei google nach oben`, `konnen Sie mich auf`
- `was kostet`, `kosten`, `preis`, `wie teuer`, `angebot`
- `intelligente website`, `webseite`, `internetauftritt`, `neue website`
- `telefonassistent`, `sprachassistent`, `ki telefon`, `anrufe beantworten`
- `ich habe ihre email bekommen`, `wegen ihrer email`, `sie haben mir geschrieben`
- `Sizinze eine echte Person`, `sind sie ein mensch`, `spreche ich mit einer ki`

If a transcript is short or imperfect but contains a strong known signal, the template wins before transcript-quality fallback.

## Deterministic Templates

Critical intents now use templates instead of falling through to the LLM:

```text
human_or_ai_question:
Ich bin der digitale Assistent von TechnoloHit.

pricing_question:
Das hängt vom Umfang ab. Wenn Sie möchten, prüft unser Team Ihre Situation kurz und gibt Ihnen eine erste Einschätzung.

smart_website_interest:
Eine intelligente Website hilft lokalen Unternehmen, besser gefunden zu werden und Anfragen besser zu erfassen. Für welche Art von Unternehmen rufen Sie an?

voice_assistant_question:
Ja, so ein Telefonassistent kann Teil der Lösung sein. Soll er Anrufe oder Website-Anfragen vorbereiten?

email_campaign_caller:
Danke, dann geht es um die kostenlose Website-Ersteinschätzung. Für welches Unternehmen rufen Sie an?

seo_guarantee_question:
Seriöse Ranking-Garantien geben wir nicht. Wir verbessern Struktur und Inhalte, damit Ihre Website bessere Chancen bei passenden Suchanfragen hat.

max_turns_callback:
Ich gebe Ihre Anfrage gerne an unser Team weiter. Wann passt Ihnen ein kurzer Rückruf?

max_turns_wrapup:
Danke, das reicht für eine erste Einordnung. Unser Team kann die Details persönlich klären.
```

## LLM Fallback Changes

The LLM fallback is less aggressive:

- known business intents use templates first
- unclear, malformed, or incomplete transcripts ask for clarification
- clear unknown questions may use the LLM with the TechnoloHit knowledge file and compact history
- generated answers still pass a relevance guard before playback
- rejected LLM answers fall back to a safe callback-oriented response
- `used_llm_response` is stored/logged so QA can see whether a response came from LLM or template

## Env Vars Added Or Changed

Added to root `.env.example` and `voice-bridge/.env.example`:

```env
VOICE_ASSISTANT_MIN_LISTEN_MS=2500
VOICE_ASSISTANT_MAX_LISTEN_MS=10000
VOICE_ASSISTANT_END_SILENCE_MS=900
```

Relevant current defaults:

```env
VOICE_TURN_LISTEN_SECONDS=5
VOICE_ASSISTANT_MAX_RESPONSE_CHARS=180
VOICE_ASSISTANT_MAX_RESPONSE_SENTENCES=2
VOICE_ASSISTANT_MAX_TURNS=3
VOICE_ASSISTANT_END_ON_SILENCE=true
VOICE_ASSISTANT_MIN_TRANSCRIPT_CHARS=5
VOICE_LOG_TRANSCRIPT_PREVIEW=false
```

## QA Metadata And Logging

Added or preserved safe QA fields:

- `detected_intent`
- `transcript_quality`
- `used_template_response`
- `used_llm_response`
- `used_clarification_fallback`
- `used_relevance_fallback`
- `listen_duration_ms`
- `speech_end_detected`
- `audio_bytes_captured`
- `response_chars`
- `playback_ms`

Raw transcript and response previews are redacted by default. Set this only for controlled debugging:

```env
VOICE_LOG_TRANSCRIPT_PREVIEW=true
```

## Validation

Commands run:

```bash
node --check voice-bridge/src/config.js
node --check voice-bridge/src/index.js
node --check voice-bridge/src/turn-assistant.js
npm run validate
```

Results:

```text
node --check voice-bridge/src/config.js       PASS
node --check voice-bridge/src/index.js        PASS
node --check voice-bridge/src/turn-assistant.js PASS
npm run validate                              PASS
```

Additional syntax check run:

```text
node --check voice-bridge/src/persist.js PASS
```

## Deploy Steps

From the repo root after `docker login`:

```bash
VOICE_DOCKER_IMAGE=thnhit/technhvoice npm run docker:release:voice-bridge
```

On the production server:

```bash
cd /opt/technolohit-voice/asterisk

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-<git-short-sha> \
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-<git-short-sha> \
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

Verify the deployed image and greeting asset:

```bash
docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'
docker logs --tail=120 technolohit-voice-bridge
docker exec technolohit-voice-bridge sh -lc 'ls -lah /app/audio /app/knowledge || true'
```

Do not change Asterisk or Easybell for this voice-bridge-only deploy.

## Manual Live-Call Checklist

Live phone testing was not performed directly from this environment. Founder verification should run these calls after deployment:

| Scenario | Caller phrase | Expected |
|---|---|---|
| Smart Website | `Ich interessiere mich für Ihre intelligente Website.` | Short explanation and asks business type |
| Pricing | `Was kostet eine Webseite?` | No exact price, offers first assessment |
| SEO guarantee | `Können Sie mich auf Platz eins bei Google bringen?` | No ranking guarantee template |
| Voice assistant | `Kann ich so einen Telefonassistenten bekommen?` | Says yes as part of the solution, no overpromise |
| Email campaign | `Ich habe Ihre E-Mail bekommen.` | Routes to email campaign template |
| Human/AI | `Sind Sie ein Mensch?` | `Ich bin der digitale Assistent von TechnoloHit.` |
| Unclear partial | `Können Sie mich auf...` | No hallucination; clarification or SEO template if signal is strong |
| English | `Can you help me in English?` | German-only response |

## Founder SQL QA Queries

Latest turn transcript pairs:

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
LIMIT 30;
```

Timing and relevance events:

```sql
SELECT cs.external_call_id,
       ce.event_type,
       ce.payload,
       ce.occurred_at
FROM voice.call_events ce
JOIN voice.call_sessions cs ON cs.id = ce.call_session_id
WHERE ce.event_type IN (
  'turn_transcribed',
  'assistant_response_created',
  'assistant_response_played',
  'turn_failed',
  'conversation_finished'
)
ORDER BY ce.occurred_at DESC
LIMIT 30;
```

Operational log check:

```bash
docker logs --tail=160 technolohit-voice-bridge | egrep -i 'voice-assistant|greeting|ERROR|WARNING' || true
```

Expected log shape:

```text
[voice-assistant] assistant enabled listen_seconds=5 min_listen_ms=2500 max_listen_ms=10000 end_silence_ms=900 ...
[voice-bridge] sending greeting (file: /app/audio/greeting.slin)
[voice-assistant] listening for caller turn=1 min_listen_ms=2500 max_listen_ms=10000 end_silence_ms=900
[voice-assistant] response created ... used_template_response=true used_llm_response=false ...
[voice-assistant] turn timings ... speech_end_detected=... audio_bytes_captured=...
```
