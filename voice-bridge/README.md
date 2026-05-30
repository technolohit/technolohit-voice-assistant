# TechnoloHit voice-bridge

Realtime AudioSocket orchestrator for the Voice Assistant. It persists call lifecycle rows to PostgreSQL schema `voice` and does not use n8n, Redis, or the Growth schema.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `VOICE_BRIDGE_HOST` | `0.0.0.0` | AudioSocket bind address |
| `VOICE_BRIDGE_PORT` | `9092` | AudioSocket TCP port |
| `VOICE_GREETING_MODE` | `file` | Use `file`, `default`, `tone`, `none`, or `skip` |
| `VOICE_GREETING_FILE` | `/app/audio/greeting.slin` | Path to raw PCM s16le 8 kHz mono audio |
| `VOICE_GREETING_PRIVACY_MODE` | `auto` | Privacy intro variant for greeting audio: `auto` (recording enabled → recording wording), `recording`, or `processing` |
| `VOICE_SAMPLE_RATE` | `8000` | Outbound/inbound PCM rate |
| `VOICE_FRAME_MS` | `20` | Outbound chunk timing, 320 bytes per frame at 8 kHz |
| `VOICE_TONE_DURATION_MS` | `800` | Built-in fallback tone length |
| `VOICE_TONE_FREQUENCY_HZ` | `440` | Built-in fallback tone frequency |
| `VOICE_INBOUND_LOG_EVERY` | `50` | Log every N inbound audio frames |
| `VOICE_RECORDING_ENABLED` | `true` | Buffer caller/inbound audio for post-call recording |
| `VOICE_RECORDING_MAX_SECONDS` | `300` | Max caller audio buffered in memory |
| `VOICE_RECORDING_DIR` | `/app/recordings` | Directory for `.slin` and `.wav` recordings |
| `VOICE_TRANSCRIPTION_ENABLED` | `false` | Enable post-call OpenAI transcription |
| `VOICE_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` | OpenAI speech-to-text model |
| `VOICE_TRANSCRIPTION_LANGUAGE` | `de` | ISO-639-1 language hint |
| `VOICE_TRANSCRIPTION_PROMPT` | (empty) | Optional German transcription prompt |
| `VOICE_KNOWLEDGE_RETRIEVAL_ENABLED` | `true` | Enable lightweight FAQ retrieval for clear unknown caller questions |
| `VOICE_KNOWLEDGE_RETRIEVAL_MIN_SCORE` | `1` | Minimum retrieval score for FAQ answer match |
| `VOICE_RAG_ENABLED` | `false` | Optional semantic RAG fallback; keep disabled until pgvector/RAG QA is green |
| `VOICE_RAG_API_URL` | (empty) | URL for RAG API; with host networking use `http://127.0.0.1:8080`, with bridge networking use service DNS (for example `http://technolohit-rag-api:8080`) |
| `VOICE_RAG_TIMEOUT_MS` | `700` | Maximum live-call RAG wait before safe fallback |
| `VOICE_RAG_MIN_SCORE` | `0.72` | Minimum semantic retrieval score accepted by voice-bridge |
| `VOICE_RAG_QA_MODE` | `false` | QA-only RAG resilience mode (timeout retry + relaxed no-hit retry) |
| `VOICE_RAG_QA_TIMEOUT_MS` | `1200` | QA-only timeout used for retry paths when QA mode is enabled |
| `VOICE_RAG_QA_RETRY_DELTA` | `0.08` | QA-only min-score reduction for a second no-hit retrieval attempt |
| `VOICE_RAG_QA_ACCEPT_FLOOR` | `0.65` | QA-only absolute minimum accepted score on relaxed retry |
| `VOICE_QA_LOG_TRANSCRIPT_PREVIEW` | `false` | QA-only transcript preview logging for investigation; keep `false` in production |
| `VOICE_POST_CALL_SUMMARY_ENABLED` | `true` | Write deterministic post-call business summary to `voice.call_summaries` |
| `VOICE_POST_CALL_LEAD_EXTRACTION_ENABLED` | `true` | Post-call lead extraction/enrichment from summary (non-realtime path) |
| `VOICE_POST_CALL_NOTIFY_ENABLED` | `false` | Enable async post-call webhook notification |
| `VOICE_POST_CALL_NOTIFY_WEBHOOK_URL` | (empty) | Target webhook URL for founder/team notification payload |
| `VOICE_POST_CALL_NOTIFY_TIMEOUT_MS` | `8000` | HTTP timeout for post-call webhook notification |
| `OPENAI_API_KEY` | required for transcription | Set in `.env` or Docker env; never commit |
| `VOICE_ASSISTANT_ENABLED` | `false` | Enable controlled turn-based assistant after greeting |
| `VOICE_TURN_LISTEN_SECONDS` | `5` | Legacy/recommended caller-turn quality target; adaptive listening now uses the min/max settings below |
| `VOICE_ASSISTANT_MIN_LISTEN_MS` | `2500` | Minimum caller audio capture before silence can end a turn |
| `VOICE_ASSISTANT_MAX_LISTEN_MS` | `10000` | Maximum bounded caller audio capture per turn |
| `VOICE_ASSISTANT_END_SILENCE_MS` | `900` | End a turn after detected speech is followed by this much silence |
| `VOICE_ASSISTANT_MODEL` | `gpt-4o-mini` | Text model for grounded German response |
| `VOICE_ASSISTANT_TTS_MODEL` | `gpt-4o-mini-tts` | TTS model for assistant response |
| `VOICE_ASSISTANT_TTS_VOICE` | `marin` | TTS voice for assistant response |
| `VOICE_ASSISTANT_TTS_SPEED` | `1.0` | OpenAI TTS speed (0.75–1.15). Tune after live PSTN QA; candidate production value `1.08` |
| `VOICE_ASSISTANT_MAX_RESPONSE_CHARS` | `160` | Maximum assistant response length for phone playback |
| `VOICE_ASSISTANT_MAX_RESPONSE_SENTENCES` | `2` | Maximum assistant response sentence count |
| `VOICE_ASSISTANT_MAX_TURNS` | `3` | Maximum caller/assistant turns per call |
| `VOICE_ASSISTANT_MAX_TURNS_WITH_INTAKE` | `5` | Intake-only turn cap used while waiting for contact detail/permission |
| `VOICE_ASSISTANT_END_ON_SILENCE` | `true` | Finish conversation when no caller audio is captured |
| `VOICE_ASSISTANT_MIN_TRANSCRIPT_CHARS` | `5` | Minimum usable caller transcript length |
| `VOICE_LOG_TRANSCRIPT_PREVIEW` | `false` | When `false`, transcript/response previews in assistant logs are redacted |
| `VOICE_DB_HOST` | `10.20.0.1` | Postgres over WireGuard |
| `VOICE_DB_PORT` | `5432` | Postgres port |
| `VOICE_DB_NAME` | `technolohit_growth` | Database name |
| `VOICE_DB_USER` | `technolohit_voice_app` | Least-privilege voice app role |
| `VOICE_DB_PASSWORD` | required | Never logged |
| `VOICE_DB_SSL` | `false` | Set `true` if TLS is required |
| `VOICE_DB_POOL_MAX` | `5` | Pool size |

Copy `voice-bridge/.env.example` to `voice-bridge/.env`, or set `VOICE_DB_*` in the repo root `.env`. Startup loads `../.env` first and then `voice-bridge/.env` as local overrides.

`VOICE_DB_PASSWORD` must be non-empty for persistence. If the DB is down or an insert fails, the audio path continues and only `[voice-db] ... failed` is logged.

## Local Run

```bash
cd voice-bridge
cp .env.example .env
# edit .env and set VOICE_DB_PASSWORD for persistence
npm install
npm start
```

Dialogue QA (no OpenAI calls in default QA text mode):

```bash
cd voice-bridge
npm test
node scripts/qa-dialogue-text.js --scenario caller_id_callback
node scripts/qa-dialogue-text.js --scenario voice_agent_ai_assistant
```

On **Windows PowerShell**, prefer the direct `node` form above. `npm run qa:dialogue -- --scenario …` can fail because PowerShell may not pass `--scenario` through to the script correctly.

On start you should see:

```text
[voice-bridge] listening on 0.0.0.0:9092 version=0.2.0
[voice-db] persistence enabled -> 10.20.0.1:5432/technolohit_growth schema=voice user=technolohit_voice_app
[voice-recording] recording enabled dir=/app/recordings max_seconds=300
[voice-transcribe] transcription disabled
[voice-assistant] assistant disabled
```

## Greeting Audio Generation

Audio generation is a developer/local step. Docker builds do not call OpenAI and do not require `OPENAI_API_KEY`.

Requirements:

- `OPENAI_API_KEY` in your local `.env` or shell
- `ffmpeg` on your local machine
- Node.js 20+

Optional TTS settings:

```env
VOICE_TTS_MODEL=gpt-4o-mini-tts
VOICE_TTS_VOICE=marin
VOICE_TTS_FORMAT=wav
```

Generate and convert the natural German greeting:

```bash
cd voice-bridge
npm run audio:build
```

The greeting script (`npm run tts:greeting`) uses a short KI/privacy intro. With `VOICE_GREETING_PRIVACY_MODE=auto` and `VOICE_RECORDING_ENABLED=true` (default), the text mentions recording, processing, and summary. With processing-only mode:

```text
Guten Tag, Sie sprechen mit dem KI-Assistenten von TechnoloHit. Zur Bearbeitung Ihres Anliegens kann dieses Gespräch verarbeitet und zusammengefasst werden. Wie kann ich Ihnen helfen?
```

Regenerate after wording changes:

```bash
cd voice-bridge
npm run audio:build
```

| File | Purpose |
|------|---------|
| `audio/greeting.wav` | OpenAI TTS output |
| `audio/greeting.slin` | AudioSocket-ready raw PCM, signed 16-bit little-endian, mono, 8000 Hz |

You can run the steps separately:

```bash
npm run tts:greeting
npm run audio:convert
```

The conversion command is equivalent to:

```bash
ffmpeg -y -i audio/greeting.wav -ar 8000 -ac 1 -f s16le -acodec pcm_s16le audio/greeting.slin
```

The TTS script does not print API keys or secrets. It uses the OpenAI `audio/speech` endpoint with `gpt-4o-mini-tts`, the `marin` voice by default, and voice instructions for a warm, calm, professional German business receptionist tone.

## Docker And Deploy

The Docker image packages whatever exists under `voice-bridge/audio/`. If `audio/greeting.slin` is present before `docker build`, it is copied to `/app/audio/greeting.slin`. If it is missing or empty at runtime, voice-bridge logs the problem and falls back to the generated test tone unless `VOICE_GREETING_MODE=none` or `skip`.

The image installs `ffmpeg` for post-call `.slin` to `.wav` conversion. Docker build does not call OpenAI. The Dockerfile uses `npm ci --omit=dev`, copies only application code/audio/knowledge, sets `BUILD_VERSION`, and runs the app as the non-root `node` user.

Apply the voice-only migration from your developer machine before using transcription queries:

```bash
npm run db:migrate:voice
```

### Docker Hub release

Production deploys should use Docker Hub image tags instead of copying source folders to the server. The current Docker Hub repository is:

```text
thnhit/technhvoice
```

Recommended tags:

| Tag | Purpose |
|-----|---------|
| `thnhit/technhvoice:voice-bridge-<git-short-sha>` | Preferred immutable staging/production tag |
| `thnhit/technhvoice:voice-bridge-latest` | Convenience tag only |
| `thnhit/technhvoice:voice-bridge-dev` | Optional dev tag |
| `thnhit/technhvoice:voice-bridge-vX.Y.Z` | Optional semantic version tag |

Do not rely only on `voice-bridge-latest` for production. Pin the server to an immutable SHA tag so rollback is deterministic.

From the repo root, after `docker login`:

```bash
VOICE_DOCKER_IMAGE=thnhit/technhvoice npm run docker:release:voice-bridge
```

On Windows, run the Docker scripts from Git Bash or another shell with `bash`.

### Server image-mode deploy

Use the existing Docker Compose service with the production override documented in [docs/dockerhub-voice-deploy.md](../docs/dockerhub-voice-deploy.md):

```bash
cd /opt/technolohit-voice/asterisk

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-abc1234 \
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-abc1234 \
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

The volume for `/app/recordings` is still recommended so recordings survive container replacement. Runtime secrets must stay in server env files, Docker secrets, or the server environment; never bake them into the image.

Verify the deployed image:

```bash
docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'
docker logs --tail=120 technolohit-voice-bridge
docker exec technolohit-voice-bridge sh -lc 'ls -lah /app/knowledge /app/audio || true'
```

Rollback by setting `VOICE_BRIDGE_IMAGE` to the previous immutable tag and running the same `pull` and `up -d` commands again.

Do not change Asterisk or Easybell config for a voice-bridge image update.

## Audio Behaviour

Inbound parses UUID (`0x01`), audio (`0x10`-`0x18`), hangup (`0x00`), DTMF (`0x03`), and error (`0xff`) frames. Inbound frame and byte counts are stored on `call_ended`.

When recording is enabled, inbound audio frame payloads (`0x10`-`0x18`) are buffered as raw PCM s16le 8 kHz mono caller audio. Outbound greeting and silence are not recorded. Buffering stops safely at `VOICE_RECORDING_MAX_SECONDS`; the call continues.

Outbound greeting behaviour:

| `VOICE_GREETING_FILE` | `VOICE_GREETING_MODE` | Behaviour |
|----------------------|------------------------|-----------|
| set and readable | any | Stream file as PCM s16le 8 kHz in 20 ms frames, then `greeting_played` |
| set but missing/empty | not `none`/`skip` | Log fallback, stream generated tone, then `greeting_played` |
| empty | `default`, `tone`, or `file` | Stream generated tone, then `greeting_played` |
| empty or invalid | `none` or `skip` | No greeting audio, insert `greeting_skipped`, then silence |

After greeting or skip, a silence writer sends 20 ms PCM zero frames so Asterisk keeps the call up.

Expected file greeting logs:

```text
[voice-bridge] sending greeting (file: /app/audio/greeting.slin)
[voice-bridge] sending greeting (123456 bytes pcm, chunk=320)
[voice-bridge] finished sending greeting frames=386 bytes=123520
[voice-bridge] starting silence writer
```

Expected fallback logs:

```text
[voice-bridge] greeting file unavailable (greeting file not found: /app/audio/greeting.slin); falling back to generated tone
[voice-bridge] sending greeting (generated_tone: tone_800ms_440hz)
```

## Recording And Transcription

Recording is enabled by default:

```env
VOICE_RECORDING_ENABLED=true
VOICE_RECORDING_MAX_SECONDS=300
VOICE_RECORDING_DIR=/app/recordings
```

After `call_ended`, voice-bridge writes:

```text
/app/recordings/<bridge_call_id>.slin
/app/recordings/<bridge_call_id>.wav
```

The conversion command inside the container is equivalent to:

```bash
ffmpeg -y -f s16le -ar 8000 -ac 1 -i input.slin output.wav
```

Enable OpenAI post-call transcription:

```env
VOICE_TRANSCRIPTION_ENABLED=true
VOICE_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
VOICE_TRANSCRIPTION_LANGUAGE=de
VOICE_TRANSCRIPTION_PROMPT=
OPENAI_API_KEY=<OPENAI_API_KEY>
```

Set `OPENAI_API_KEY` only in `voice-bridge/.env`, Docker secrets, or your runtime environment. Do not commit real keys.

Test one call:

1. Rebuild/restart voice-bridge with `ffmpeg` in the image.
2. Place one inbound call and speak after the greeting.
3. Check logs for recording write, WAV conversion, and transcript creation or safe failure.
4. Check `/app/recordings` or the mounted host directory for the `.slin` and `.wav` files.
5. Run the SQL queries below.

Expected recording/transcription logs:

```text
[voice-recording] wrote /app/recordings/<bridge_call_id>.slin bytes=...
[voice-recording] converted /app/recordings/<bridge_call_id>.wav bytes=...
[voice-transcribe] transcript created length=...
```

Expected safe failure examples:

```text
[voice-transcribe] transcription enabled but OPENAI_API_KEY is missing
[voice-transcribe] transcription failed reason=...
```

## Turn-Based Assistant MVP

This is a controlled turn-based conversational MVP, not full realtime conversational AI. It can handle a few short caller turns, but it still uses listen windows and sequential STT -> LLM -> TTS processing.

It validates:

- short post-greeting caller STT quality
- grounded German assistant response quality
- TTS playback quality
- caller experience over the existing AudioSocket path

It does not do lead extraction, CRM updates, or call summaries.

Enable it with:

```env
VOICE_ASSISTANT_ENABLED=true
VOICE_TURN_LISTEN_SECONDS=5
VOICE_ASSISTANT_MIN_LISTEN_MS=2500
VOICE_ASSISTANT_MAX_LISTEN_MS=10000
VOICE_ASSISTANT_END_SILENCE_MS=900
VOICE_ASSISTANT_MAX_TURNS=3
VOICE_ASSISTANT_END_ON_SILENCE=true
VOICE_ASSISTANT_MIN_TRANSCRIPT_CHARS=5
VOICE_ASSISTANT_MAX_RESPONSE_CHARS=180
VOICE_ASSISTANT_MAX_RESPONSE_SENTENCES=2
VOICE_ASSISTANT_MODEL=gpt-4o-mini
VOICE_ASSISTANT_TTS_MODEL=gpt-4o-mini-tts
VOICE_ASSISTANT_TTS_VOICE=marin
VOICE_LOG_TRANSCRIPT_PREVIEW=false
OPENAI_API_KEY=<OPENAI_API_KEY>
```

`VOICE_TURN_LISTEN_SECONDS=5` is the recommended production quality default. `4` seconds is faster and can reduce latency, but production calls showed normal German utterances can be cut before the caller finishes, which lowers STT quality and makes the response less relevant.

Live-call capture is now adaptive: the bridge listens for at least `VOICE_ASSISTANT_MIN_LISTEN_MS`, keeps listening while speech energy is present, ends after `VOICE_ASSISTANT_END_SILENCE_MS` of post-speech silence, and always stops at `VOICE_ASSISTANT_MAX_LISTEN_MS`. This is a lightweight energy/silence heuristic, not full realtime VAD.

Flow:

1. voice-bridge plays the greeting.
2. voice-bridge starts the silence writer.
3. Inbound caller audio is captured until speech appears to have ended, bounded by the min/max listen settings.
4. The caller turn is saved as `.slin` and `.wav` under `VOICE_RECORDING_DIR`.
5. The turn WAV is transcribed.
6. The turn transcript is classified as `clear`, `unclear`, `incomplete`, or `malformed`.
7. If the transcript is empty, too short, truncated, malformed, or mostly filler, the assistant asks one short clarification once.
8. Known intents use deterministic short templates; clear unknown intents first try FAQ retrieval, then fall through to model generation using `knowledge/technolohit.md`, the latest caller turn, and compact history only.
9. The response is synthesized to WAV, converted to `.slin`, and streamed back to AudioSocket in 20 ms frames.
10. The silence writer resumes, then the next turn begins.
11. The loop stops at `VOICE_ASSISTANT_MAX_TURNS` for normal calls, or at `VOICE_ASSISTANT_MAX_TURNS_WITH_INTAKE` only while soft intake is active and waiting for contact detail/permission.

The assistant prompt is intentionally constrained:

- answer in German
- be short, warm, calm, and professional like a phone assistant
- answer the caller's latest question directly
- use only the latest caller utterance, compact history, and `knowledge/technolohit.md`
- do not invent prices, guarantees, legal claims, contracts, or availability
- do not invent services, timelines, technical details, or ranking guarantees
- ask at most one clear follow-up question
- keep responses to `VOICE_ASSISTANT_MAX_RESPONSE_SENTENCES` short sentences and `VOICE_ASSISTANT_MAX_RESPONSE_CHARS` characters
- if asked whether it is AI, say: "Ich bin der digitale Assistent von TechnoloHit."
- if asked about pricing, say pricing depends on scope and a team member can clarify details

The relevance guard runs before final playback:

- incomplete transcripts such as `Entschuldigung, ich habe da...` use a repeat request instead of generic marketing
- weak, filler, or malformed transcripts use clarification fallback
- known caller intents use templates before free-form model generation
- common STT variants such as `Sizinze eine echte Person`, `Sind Sie echt`, `Bouwen Sie Websites`, and `Was kostet` are normalized through lightweight regex rules
- broken live-call phrases such as `konnen Sie mich auf`, `Platz eins bei Google`, and `Ich habe Ihre E-Mail bekommen` route to deterministic business-safe templates
- product overview questions such as `Welche Produkte bieten Sie an?` route to a short five-product overview instead of a generic company paragraph
- after a product overview, short answers such as `Nummer drei` are interpreted in context and route to the matching product
- product copy is loaded from `voice-bridge/knowledge/products.technolohit.json` with a safe in-code fallback if the catalog is missing
- FAQ retrieval copy is loaded from `voice-bridge/knowledge/faqs.technolohit.json` with a safe in-code fallback if missing
- soft intake asks for contact preference only after interest, callback, handoff, pricing, free analysis, Smart Website, voice assistant, or email campaign signals
- soft intake asks one question at a time; email callers are directed to `info@technolohit.com`
- callback path prefers caller ID when available: `Gerne. Darf unser Team Sie unter der Nummer zurückrufen, von der Sie gerade anrufen?`
- if no caller ID is available, callback callers are asked once: `Gerne. Unter welcher Telefonnummer darf unser Team Sie zurückrufen?` — permission is implied; no second permission question after voice capture
- voice-agent product synonyms (`AI Assistant`, `KI Assistent`, `Telefonassistent`, …) route to a compact offer instead of repeating the full product menu
- unknown/unclear input uses short clarification; repeated unknown intent offers contact preference instead of replaying the full intro
- after email-direct, callback permission granted, callback permission denied, or intake fallback, the assistant finishes the turn loop instead of asking another max-turn callback question
- when soft intake is waiting for contact detail/permission, this waiting state is handled before generic max-turn close
- soft intake detail retry is limited to one brief retry, then fallback to `info@technolohit.com`
- email addresses in templates are protected during response sentence limiting so `info@technolohit.com` is not truncated at `.com`
- generated responses are normalized to phone length
- assistant rows store `detected_intent`, `transcript_quality`, `used_template_response`, `used_llm_response`, `used_clarification_fallback`, `used_relevance_fallback`, `response_chars`, product flow metadata, `knowledge_source`, `knowledge_version`, `assistant_model`, `turn_index`, and `transcript_scope`
- turn events include `listen_duration_ms`, `speech_end_detected`, `audio_bytes_captured`, response length, and playback timing
- transcript/response previews are redacted by default unless `VOICE_LOG_TRANSCRIPT_PREVIEW=true`

Semantic RAG is deliberately separate from this live-call state machine. `VOICE_RAG_ENABLED=false` is the production-safe default while pgvector and `technolohit-rag-api` are being prepared. Even after it is enabled, deterministic routing for products, callback/email choices, permission, and caller ID consent must run before any RAG lookup; RAG is only a timeout-protected support layer for clear knowledge questions that local templates and FAQ retrieval did not answer. `VOICE_RAG_QA_MODE` can be enabled only during Gate 5 QA to improve observability and resilience testing without making RAG a hard dependency. If transcript diagnostics are needed during QA, use `VOICE_QA_LOG_TRANSCRIPT_PREVIEW=true` temporarily and revert to `false` after evidence collection.

Soft intake now uses a reception-first lead marker. It writes one lightweight row to `voice.leads` when the caller chooses direct email, or when the caller requests a callback and grants permission. Callback number can come either from caller speech or caller ID metadata when available. It does not capture email addresses by voice and does not notify n8n/CRM. Milestones remain in event payloads/transcript metadata, including `contact_route`, `contact_preference_detected`, `contact_detail_source`, `email_direct_offered`, `contact_permission_requested`, `contact_permission_granted`, `permission_detected`, `permission_detection_source`, `permission_retry_count`, `soft_intake_lead_created`, and `soft_intake_state`.

Post-call summary v1 now runs after call completion (outside realtime turn playback) and writes/upserts one `summary_type=auto` row in `voice.call_summaries`. It includes deterministic fields: `product_interest`, `caller_need`, `contact_preference`, `permission`, `next_action`, `confidence`, and `transcript_quality_notes`. It remains independent from notification dispatch.

Lead extraction v1 now also runs after summary generation (still outside realtime path). It follows guardrails:

- no noisy lead creation for unclear/weak calls
- requires explicit contact route and valid permission path
- enriches existing `voice.leads` rows first to avoid duplication
- only creates a new row when no lead exists and summary guards pass
- stores structured metadata (`product_interest`, `next_action`, `confidence`, `summary_id`) without raw transcript text

Notification/dashboard v1 now runs after summary + lead processing in the same post-call async pipeline. It is disabled by default and sends a compact JSON payload to `VOICE_POST_CALL_NOTIFY_WEBHOOK_URL` when enabled. This does not block or modify realtime turn handling.

Transcript quality rules:

| Quality | Meaning | Behavior |
|---------|---------|----------|
| `clear` | Enough content and a recognizable intent or usable question | Answer directly or use a known intent template |
| `unclear` | Too short, mostly filler, or no clear intent/question | Ask `Entschuldigung, ich habe das nicht ganz verstanden. Worum geht es genau?` |
| `incomplete` | Ends with `...` or likely cut off mid-sentence | Ask `Ich glaube, ich habe nur einen Teil verstanden. KÃ¶nnen Sie das bitte kurz wiederholen?` |
| `malformed` | Looks like malformed STT and no intent can be recovered | Ask clarification instead of giving generic marketing |

Known intent templates:

| Intent | Template |
|--------|----------|
| `human_or_ai_question` | `Ich bin der digitale Assistent von TechnoloHit.` |
| `what` | `TechnoloHit baut intelligente Websites und KI-Assistenten fÃ¼r lokale Unternehmen. Geht es um Website, Sichtbarkeit oder Anfragen?` |
| `website` | `Ja, TechnoloHit erstellt intelligente Websites fÃ¼r lokale Unternehmen. Haben Sie bereits eine bestehende Website?` |
| `product_overview_request` | `TechnoloHit bietet fünf Lösungen: Smart Websites, AISeoQ, Botinteg, LokalKI und eine digitale Rezeption. Zu welchem Produkt möchten Sie kurz mehr hören?` |
| `product_selection_smart_website` | `Eine Smart Website verbindet Website, lokale Sichtbarkeit, KI-Chat und Anfrage-Erfassung. Möchten Sie prüfen lassen, ob das zu Ihrem Unternehmen passt?` |
| `product_selection_aiseoq` | `AISeoQ hilft Agenturen und IT-Teams, Websites mit Wettbewerbern zu vergleichen und SEO-Maßnahmen abzuleiten. Prüfen Sie eigene oder Kundenprojekte?` |
| `product_selection_botinteg` | `Botinteg ist für KI-Chatbots und einfache Automatisierung, etwa FAQ, Lead-Erfassung und Website-Abläufe. Geht es eher um Chatbot oder Automatisierung?` |
| `product_selection_lokalki` | `LokalKI ist eine private KI-Lösung für sensible Daten in kontrollierten oder lokalen Umgebungen. Geht es um interne Dokumente oder Datenschutz?` |
| `product_selection_voice_agent` | `Die digitale Rezeption nimmt Anrufe an, beantwortet erste Fragen und bereitet Rückrufwünsche oder Leads vor. Möchten Sie das für Ihr Unternehmen prüfen?` |
| `compare_products_request` | Short comparison of Smart Website, Botinteg, and LokalKI, then asks which topic matters most. |
| `product_interest_confirmed` | Starts reception-first soft intake: `Möchten Sie lieber einen Rückruf oder uns direkt per E-Mail schreiben?` |
| `pricing_question` | `Das hängt vom Umfang ab. Möchten Sie lieber einen Rückruf oder uns direkt per E-Mail schreiben?` |
| `smart_website_interest` | `Eine intelligente Website hilft bei Sichtbarkeit und Anfragen. Möchten Sie lieber einen Rückruf oder uns direkt per E-Mail schreiben?` |
| `voice_assistant_question` | `Ja, so ein Telefonassistent kann Teil der Lösung sein. Möchten Sie lieber einen Rückruf oder uns direkt per E-Mail schreiben?` |
| `handoff_requested` / `callback_request` | `Natürlich. Möchten Sie lieber einen Rückruf oder uns direkt per E-Mail schreiben?` |
| `contact_preference_email` | `Gerne. Schreiben Sie uns bitte kurz an info@technolohit.com. Dann kann unser Team direkt antworten.` |
| `contact_preference_phone` | `Welche Telefonnummer dÃ¼rfen wir fÃ¼r den RÃ¼ckruf notieren?` |
| `email_provided` | Routes to direct email and does not capture the address by voice. |
| `phone_provided` | `Danke. Darf unser Team Sie dazu kontaktieren?` |
| `contact_permission_granted` | `Danke. Ich gebe Ihre Anfrage an unser Team weiter.` |
| `refuses_contact_details` | `Kein Problem. Sie kÃ¶nnen uns auch direkt per E-Mail unter info@technolohit.com erreichen.` |
| `technology_question` | `TechnoloHit nutzt eigene KI- und AutomatisierungslÃ¶sungen. Die Details erklÃ¤rt Ihnen unser Team gern persÃ¶nlich.` |
| `email_campaign_caller` | `Danke, dann geht es um die kostenlose Website-Ersteinschätzung. Möchten Sie lieber einen Rückruf oder uns direkt per E-Mail schreiben?` |
| `seo_guarantee_question` | `SeriÃ¶se Ranking-Garantien geben wir nicht. Wir verbessern Struktur und Inhalte, damit Ihre Website bessere Chancen bei passenden Suchanfragen hat.` |
| `unknown` | `Das kann ich nicht sicher beantworten. Am besten klÃ¤rt unser Team die Details persÃ¶nlich.` |
| `unclear` | `Entschuldigung, ich habe das nicht ganz verstanden. Worum geht es genau?` |
| `max_turns_callback` | `Ich gebe Ihre Anfrage gerne an unser Team weiter. Wann passt Ihnen ein kurzer RÃ¼ckruf?`; if the previous response already asked for callback, use `Danke, das reicht fÃ¼r eine erste Einordnung. Unser Team kann die Details persÃ¶nlich klÃ¤ren.` |
| `max_turns_active_intake` | Uses intake-safe close text instead of callback request while detail/permission is still missing. |

Expected turn logs:

```text
[voice-assistant] listening for caller turn=1 min_listen_ms=2500 max_listen_ms=10000 end_silence_ms=900
[voice-assistant] caller turn audio wrote turn=1 slin=/app/recordings/<bridge_call_id>-turn1-caller.slin wav=/app/recordings/<bridge_call_id>-turn1-caller.wav bytes=...
[voice-assistant] turn transcribed turn_index=1 length=... caller_transcript_preview=<redacted> normalized_intent=website transcript_quality=clear transcription_ms=...
[voice-assistant] response created turn_index=1 caller_transcript_preview=<redacted> normalized_intent=website transcript_quality=clear response_preview=<redacted> used_template_response=true used_llm_response=false clarification_fallback=false relevance_fallback=false response_chars=... soft_intake_state=... product_flow_state=... product_interest=... response_generation_ms=0
[voice-assistant] response synthesized turn=1 wav=/app/recordings/<bridge_call_id>-turn1-assistant.wav slin=/app/recordings/<bridge_call_id>-turn1-assistant.slin bytes=... tts_ms=...
[voice-bridge] sending assistant response (... bytes pcm, chunk=320)
[voice-bridge] finished sending assistant response frames=... bytes=...
[voice-assistant] turn timings turn=1 listen_duration_ms=... speech_end_detected=true audio_bytes_captured=... transcription_ms=... response_generation_ms=... tts_ms=... playback_ms=... total_turn_ms=...
[voice-assistant] conversation finished reason=... turns_completed=...
```

German test call scenarios:

| Test | Caller | Expected behavior |
|------|--------|-------------------|
| A | `Was machen Sie genau?` | Direct short answer about intelligent websites and AI assistants. |
| B | `Bauen Sie Websites fÃ¼r lokale Unternehmen?` | Yes, then asks whether the caller already has a website. |
| C | `Was kostet sowas?` | Depends on scope and offers callback. |
| D | `Sind Sie eine echte Person?` | `Ich bin der digitale Assistent von TechnoloHit.` |
| E | `Entschuldigung, ich habe da...` | Asks the caller to repeat or clarify; no generic answer. |
| F | `Sizinze eine echte Person` | Identity answer if matcher detects it; otherwise clarification. |
| G | `Ich interessiere mich fÃ¼r Ihre intelligente Website.` | Short smart-website answer and asks business type. |
| H | `KÃ¶nnen Sie mich auf Platz eins bei Google bringen?` | No ranking guarantee template. |
| I | `Kann ich so einen Telefonassistenten bekommen?` | Says yes as part of the solution without overpromising. |
| J | `Ich habe Ihre E-Mail bekommen.` | Routes to the email campaign template. |
| K | `Can you help me in English?` | German-only response that asks for the concern in German. |
| L | `Welche Produkte bieten Sie an?` | Lists Smart Websites, AISeoQ, Botinteg, LokalKI, and digitale Rezeption in one short answer. |
| M | `Nummer drei.` after the product list | Routes to Botinteg and explains chatbot/automation, no LLM. |
| N | `Was ist LokalKI?` | Explains private/local AI without legal or security guarantees. |
| O | `Erzählen Sie mehr über Smart Website.` | Explains Smart Website as website, visibility, KI-Chat, and inquiry capture. |
| P | `Ja.` after a product explanation | Starts soft intake and asks Rückruf or direct E-Mail. |
| Q | `Kann ich so einen Telefonassistenten wie du haben fÃ¼r mein Unternehmen?` | `voice_assistant_question`, template response, no LLM. |
| R | `KÃ¶nnen Sie mich morgen zurÃ¼ckrufen?` | `callback_request`, asks when tomorrow fits, no LLM. |
| S | `Sehen Sie einen Mensch?` | `human_or_ai_question`, transparent digital assistant response. |
| T | `Ich mÃ¶chte mit jemandem sprechen.` | Asks whether the caller prefers email or phone contact. |
| U | `Per E-Mail bitte.` | Gives `info@technolohit.com`; does not ask the caller to spell an email address. |
| V | `Telefonisch bitte.`, `Per Anruf bitte.`, or noisy STT such as `Morspitze` after the contact-choice question | If caller ID exists, asks permission under that number; otherwise asks which phone number may be noted. |
| W | Caller provides phone detail | Asks permission before passing the callback request to the team. |
| X | `Ich mÃ¶chte keine Daten angeben.` | Offers `info@technolohit.com` without pressure. |

Expected turn DB events:

- `turn_transcribed`
- `assistant_response_created`
- `assistant_response_played`
- `soft_intake_started`
- `contact_preference_requested`
- `contact_preference_detected`
- `contact_detail_requested` for callback phone only
- `soft_intake_email_directed` for direct email path
- `soft_intake_lead_created` when a lightweight lead marker is written
- `contact_permission_requested`
- `contact_permission_granted`
- `contact_permission_denied`
- `soft_intake_declined`
- `turn_failed` on safe failure
- `conversation_finished`

Turn transcript sequence numbers:

| Row | `speaker` | `sequence_number` | Metadata |
|-----|-----------|-------------------|----------|
| Caller turn 1 | `caller` | `1` | `transcript_scope=turn`, `turn_index=1` |
| Assistant turn 1 | `assistant` | `2` | `transcript_scope=turn`, `turn_index=1` |
| Caller turn 2 | `caller` | `3` | `transcript_scope=turn`, `turn_index=2` |
| Assistant turn 2 | `assistant` | `4` | `transcript_scope=turn`, `turn_index=2` |
| Full-call post transcript | `caller` | `9999` | `transcript_scope=full_call` |

Verify only turn transcripts:

```sql
SELECT cs.external_call_id,
       ct.speaker,
       ct.sequence_number,
       ct.metadata->>'turn_index' AS turn_index,
       ct.metadata->>'transcript_scope' AS scope,
       ct.metadata->>'detected_intent' AS intent,
       ct.metadata->>'transcript_quality' AS quality,
       ct.metadata->>'used_template_response' AS template,
       ct.metadata->>'used_llm_response' AS llm,
       ct.metadata->>'used_clarification_fallback' AS clarification,
       ct.metadata->>'contact_route' AS contact_route,
       ct.metadata->>'contact_preference_detected' AS contact_preference,
       ct.metadata->>'email_direct_offered' AS email_direct_offered,
       ct.metadata->>'contact_permission_granted' AS permission_granted,
       ct.metadata->>'soft_intake_lead_created' AS lead_created,
       ct.metadata->>'soft_intake_state' AS soft_intake_state,
       ct.metadata->>'product_flow_state' AS product_flow_state,
       ct.metadata->>'product_interest' AS product_interest,
       ct.metadata->>'product_interest_name' AS product_interest_name,
       length(ct.text) AS text_len,
       left(ct.text, 300) AS text_preview,
       ct.metadata,
       ct.created_at
FROM voice.call_transcripts ct
JOIN voice.call_sessions cs ON cs.id = ct.call_session_id
WHERE ct.metadata->>'transcript_scope' = 'turn'
ORDER BY ct.created_at DESC
LIMIT 30;
```

Verify only full-call transcripts:

```sql
SELECT cs.external_call_id,
       ct.speaker,
       ct.sequence_number,
       left(ct.text, 200) AS transcript_preview,
       ct.created_at
FROM voice.call_transcripts ct
JOIN voice.call_sessions cs ON cs.id = ct.call_session_id
WHERE ct.metadata->>'transcript_scope' = 'full_call'
ORDER BY ct.created_at DESC
LIMIT 10;
```

Verify turn events:

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
  'soft_intake_started',
  'contact_preference_requested',
  'contact_preference_detected',
  'contact_detail_requested',
  'soft_intake_email_directed',
  'soft_intake_lead_created',
  'contact_permission_requested',
  'contact_permission_granted',
  'contact_permission_denied',
  'soft_intake_declined',
  'turn_failed',
  'conversation_finished'
)
ORDER BY ce.occurred_at DESC
LIMIT 30;
```

Verify latest Soft Intake lead markers:

```sql
SELECT cs.external_call_id,
       vl.id AS lead_id,
       vl.status,
       vl.source,
       vl.normalized_phone,
       vl.metadata->>'contact_route' AS contact_route,
       vl.metadata->>'contact_preference' AS contact_preference,
       vl.metadata->>'email_direct_to' AS email_direct_to,
       vl.metadata->>'no_voice_email_capture' AS no_voice_email_capture,
       vl.metadata->>'contact_permission_granted' AS permission_granted,
       vl.created_at
FROM voice.leads vl
JOIN voice.call_sessions cs ON cs.id = vl.call_session_id
ORDER BY vl.created_at DESC
LIMIT 20;
```

## Persistence Behaviour

- On TCP connect, the bridge generates `bridge_call_id` with Node `crypto.randomUUID()`.
- `external_call_id` is `bridge:<uuid>`.
- Asterisk's AudioSocket UUID is stored in `metadata.audiosocket_uuid` and event payloads.
- Optional caller ID metadata can be embedded in AudioSocket UUID payload and is parsed when present:
  - JSON: `{"uuid":"...","caller_phone_raw":"+49..."}`.
  - Key-value: `uuid=...;caller_phone_raw=+49...;caller_phone_source=...`.
- Parsed caller ID is persisted into `voice.call_sessions.caller_phone_raw` and `voice.call_sessions.caller_phone_normalized`.
- `call_started`, `greeting_played` or `greeting_skipped`, and `call_ended` events are inserted when DB persistence is available.
- Recording and transcription run after `call_ended`.
- The turn-based assistant runs during the call after greeting, while the full-call post-call recording/transcription remains unchanged.
- Successful transcription inserts one `voice.call_transcripts` row with `speaker='caller'`, `sequence_number=1`, `is_final=true`, and metadata.
- Successful transcription inserts a `transcript_created` event.
- Transcription/config/API failures insert `transcription_failed` when `call_session_id` exists.
- DB errors are logged and do not kill the audio path.

Expected `greeting_played` payload for file playback:

```json
{
  "greeting_mode": "file",
  "greeting_file": "/app/audio/greeting.slin",
  "greeting_type": "file",
  "greeting_source": "file",
  "fallback_reason": "",
  "requested_file": ""
}
```

Verify after a real call:

```sql
SELECT id, external_call_id, provider, status, language, started_at, ended_at, duration_seconds
FROM voice.call_sessions
ORDER BY created_at DESC
LIMIT 5;

SELECT ce.occurred_at, ce.event_type, ce.payload
FROM voice.call_events ce
JOIN voice.call_sessions cs ON cs.id = ce.call_session_id
WHERE cs.external_call_id LIKE 'bridge:%'
ORDER BY ce.occurred_at DESC
LIMIT 20;
```

Specific check for file greeting payload:

```sql
SELECT cs.external_call_id,
       ce.occurred_at,
       ce.payload->>'greeting_type' AS greeting_type,
       ce.payload->>'greeting_file' AS greeting_file,
       ce.payload->>'greeting_source' AS greeting_source,
       ce.payload
FROM voice.call_events ce
JOIN voice.call_sessions cs ON cs.id = ce.call_session_id
WHERE ce.event_type = 'greeting_played'
ORDER BY ce.occurred_at DESC
LIMIT 10;
```

Verify transcripts:

```sql
SELECT cs.external_call_id,
       ct.speaker,
       ct.is_final,
       left(ct.text, 200) AS transcript_preview,
       ct.created_at
FROM voice.call_transcripts ct
JOIN voice.call_sessions cs ON cs.id = ct.call_session_id
ORDER BY ct.created_at DESC
LIMIT 10;
```

Verify transcription events:

```sql
SELECT cs.external_call_id,
       ce.event_type,
       ce.payload,
       ce.occurred_at
FROM voice.call_events ce
JOIN voice.call_sessions cs ON cs.id = ce.call_session_id
WHERE ce.event_type IN ('transcript_created', 'transcription_failed')
ORDER BY ce.occurred_at DESC
LIMIT 10;
```

## Layout

| File | Role |
|------|------|
| `src/db.js` | `pg` pool, `createCallSession`, `insertCallEvent`, `endCallSession` |
| `src/persist.js` | Safe persistence wrappers, no secret payloads |
| `src/audiosocket-protocol.js` | Frame encode/decode |
| `src/audio-media.js` | PCM file read, fallback tone |
| `src/media-outbound.js` | Greeting stream and silence writer |
| `src/recording.js` | Caller audio buffering, `.slin` write, WAV conversion |
| `src/transcribe.js` | Post-call OpenAI transcription |
| `src/turn-assistant.js` | Controlled turn-based STT, response generation, TTS, playback |
| `src/post-call.js` | Post-call recording/transcription orchestration |
| `src/audiosocket.js` | TCP server and lifecycle |
| `src/index.js` | Entry point |
| `scripts/generate-greeting-openai.js` | Local OpenAI TTS generation |
| `scripts/convert-greeting.sh` | Local ffmpeg conversion to `.slin` |
| `audio/` | Greeting assets packaged into Docker |
| `knowledge/technolohit.md` | Grounding context for the turn-based assistant |

See [docs/voice-database.md](../docs/voice-database.md) for the voice schema and operational boundaries.
