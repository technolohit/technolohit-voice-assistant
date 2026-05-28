# Voice Assistant v2 Inspection Report

## Executive Summary

- The current implementation is a Node.js `voice-bridge` AudioSocket server (`voice-bridge/src/index.js`, `voice-bridge/src/audiosocket.js`) with optional post-call transcription and an optional turn-based in-call assistant.
- Realtime path is Easybell SIP -> Asterisk -> AudioSocket TCP -> `voice-bridge`; persistence is direct to PostgreSQL schema `voice` via `pg` (`voice-bridge/src/db.js`), not via n8n.
- The codebase stores call sessions/events/transcripts; lead and summary tables exist in schema migrations but are not written by runtime voice-bridge code today.
- Recording/transcription features are present; caller audio is written to `.slin`/`.wav` files and may be transcribed with OpenAI when enabled.
- Privacy/security controls are basic: secret-like keys are filtered from JSON payload keys, but there is no retention/deletion workflow, no consent-capture fielding in runtime code, and transcript previews are logged.
- This inspection is repository-based only. Production runtime parity, network exposure boundaries, and legal consent process require additional operational verification.

## Actual Architecture

- **Telephony ingress**
  - Easybell registration and SIP ingress are configured through Asterisk assets under `asterisk/` (not in voice-bridge runtime).
  - `asterisk/templates/pjsip.conf.template` routes to `context=from-easybell`; actual `extensions.conf` is not present in this repo.
  - `docs/asterisk-easybell-registration.md` documents `AudioSocket(...,127.0.0.1:9092)` behavior.
- **Realtime bridge**
  - `voice-bridge/src/index.js` starts TCP server with `createAudioSocketServer(config)`.
  - `voice-bridge/src/audiosocket.js` parses AudioSocket frames and orchestrates greeting, optional assistant turns, and post-call tasks.
- **Media + conversation**
  - Greeting playback and silence keepalive: `voice-bridge/src/media-outbound.js`.
  - Turn-based assistant flow: `voice-bridge/src/turn-assistant.js` (listen window -> STT -> intent/template/LLM -> TTS -> playback).
- **Persistence**
  - DB access: `voice-bridge/src/db.js` (`createCallSession`, `insertCallEvent`, `insertCallTranscript`, `endCallSession`).
  - Persistence wrappers/error containment: `voice-bridge/src/persist.js`.
- **Post-call pipeline**
  - Recording write/conversion: `voice-bridge/src/recording.js`.
  - Post-call orchestration: `voice-bridge/src/post-call.js`.
  - Post-call OpenAI transcription: `voice-bridge/src/transcribe.js`.
- **Config/env**
  - Env load order: repo root `.env` then `voice-bridge/.env` override in `voice-bridge/src/load-env.js`.
  - Config mapping/defaults: `voice-bridge/src/config.js`.
- **Deployment references**
  - Voice image: `voice-bridge/Dockerfile`, release/deploy docs in `docs/dockerhub-voice-deploy.md`.
  - Asterisk override for voice-bridge image mode: `asterisk/docker-compose.prod.yml`.

## Relevant Files and Modules

- `voice-bridge/src/index.js` - service startup, config logging, signal shutdown.
- `voice-bridge/src/audiosocket.js` - TCP socket lifecycle, frame handling, post-call trigger.
- `voice-bridge/src/audiosocket-protocol.js` - AudioSocket frame constants and parser/encoder.
- `voice-bridge/src/media-outbound.js` - greeting resolve/playback, silence writer, assistant start hook.
- `voice-bridge/src/audio-media.js` - greeting source resolution, tone fallback, PCM chunking.
- `voice-bridge/src/turn-assistant.js` - in-call assistant logic, intent detection, LLM/TTS orchestration.
- `voice-bridge/src/recording.js` - inbound audio buffering and ffmpeg conversion (`.slin` -> `.wav`).
- `voice-bridge/src/transcribe.js` - post-call transcription call to OpenAI STT.
- `voice-bridge/src/post-call.js` - runs recording + transcription after call close.
- `voice-bridge/src/db.js` - low-level PostgreSQL queries and pool management.
- `voice-bridge/src/persist.js` - event/transcript/session persistence wrappers and failure-safe logging.
- `voice-bridge/knowledge/technolohit.md` - assistant grounding content/version marker.
- `db/voice/migrations/001_voice_schema.sql` - base `voice` schema/tables/indexes/triggers.
- `db/voice/migrations/003_voice_bridge_session_fields.sql` - call session status/language/duration additions.
- `db/voice/migrations/004_call_transcript_post_call_fields.sql` - transcript `sequence_number`, `text`, `is_final`, `metadata`.
- `asterisk/templates/pjsip.conf.template` - Easybell registration/endpoint template (SIP side).
- `asterisk/easybell-registration-keeper.sh` - registration maintenance loop.

## Runtime Call Flow

1. Asterisk opens TCP AudioSocket connection to voice-bridge (`voice-bridge/src/audiosocket.js`).
2. On socket accept, bridge generates unique identity:
   - `assignBridgeCallIdentity(ctx)` -> `ctx.bridgeCallId=randomUUID()`, `external_call_id=bridge:<uuid>` (`voice-bridge/src/persist.js`).
3. When UUID frame arrives (`FrameType.UUID` in `handleFrame`), bridge:
   - stores `ctx.audiosocketUuid`,
   - calls `onConnectionOpen` (create `voice.call_sessions`),
   - calls `onCallStarted` event,
   - starts greeting flow (`playGreetingAndKeepalive`) (`voice-bridge/src/audiosocket.js`).
4. Greeting flow (`voice-bridge/src/media-outbound.js`):
   - resolve file/tone/skip via `resolveGreetingPcm`,
   - persist `greeting_played` or `greeting_skipped`,
   - stream PCM frames to socket in `streamPcmToSocket`,
   - start silence writer.
5. If assistant enabled, `startOneTurnAssistant(...)` starts async conversation loop.
6. Inbound audio frames (`0x10..0x18`) continuously:
   - increment counters (`framesReceived`, `bytesReceived`),
   - buffered for post-call recording (`captureInboundAudio`),
   - optionally captured for active assistant turn window (`captureAssistantTurnAudio`).
7. Assistant turn flow (`voice-bridge/src/turn-assistant.js`, if enabled):
   - `listenForTurn` waits fixed seconds,
   - write turn caller audio files,
   - transcribe turn with OpenAI STT (`audio.transcriptions.create`),
   - classify quality/intent (`analyzeCallerTranscript`, `detectIntent`, `classifyTranscript`),
   - known intents use deterministic templates; unknown clear intents call OpenAI `responses.create`,
   - synthesize response using OpenAI TTS (`audio.speech.create`),
   - play response audio and persist turn events/transcripts.
8. On hangup/socket close:
   - `onCallEnded` updates session + inserts `call_ended`,
   - async `runPostCallProcessing` executes:
     - `writeRecordingFiles` (full call inbound audio),
     - optional `transcribeRecording` (full-call transcript) if transcription enabled.

**Synchronous vs asynchronous**
- Frame parsing/dispatch is synchronous per socket chunk in `socket.on("data")`.
- Greeting playback and assistant run are async promises.
- Post-call processing is async fire-and-forget after close (`void runPostCallProcessing(...)`).

**Failure behavior**
- DB failures are caught and logged in persistence wrappers; audio path continues.
- Greeting errors fall back to silence writer and `onError`.
- Assistant turn failures emit `turn_failed` and stop conversation loop.
- Missing `OPENAI_API_KEY`:
  - assistant mode: `turn_failed` config error, assistant does not start.
  - transcription mode: `transcription_failed` config error, call flow unaffected.

## Database Schema Findings

Schema source: `db/voice/migrations/*.sql`.

- **`voice.call_sessions`**
  - PK: `id UUID`.
  - Unique index: `uq_call_sessions_external_call_id` on `external_call_id`.
  - Columns include lifecycle/telephony + metadata:
    - `external_call_id`, `provider`, `direction`, `status`,
    - `caller_phone_*`, `callee_phone_*`,
    - `lead_id`, `started_at`, `ended_at`, `language`, `duration_seconds`,
    - `metadata JSONB`, `created_at`, `updated_at`.
  - FK: `lead_id -> voice.leads(id)` (`ON DELETE SET NULL`).
  - Runtime usage:
    - created in `createCallSession` with `status='active'`, `language='de'`, metadata.
    - updated in `endCallSession`.

- **`voice.call_events`**
  - PK: `id UUID`.
  - FK: `call_session_id -> voice.call_sessions(id)` (`ON DELETE CASCADE`).
  - Columns: `event_type`, `event_source`, `payload JSONB`, `occurred_at`, `created_at`.
  - Runtime inserts many lifecycle/assistant/transcription/error events via `insertCallEvent`.

- **`voice.call_transcripts`**
  - PK: `id UUID`.
  - FK: `call_session_id -> voice.call_sessions(id)` (`ON DELETE CASCADE`).
  - Base columns: `segment_index`, `speaker`, `content`, `language_code`, `confidence`, `recorded_at`, `created_at`.
  - Added by migration `004`: `sequence_number`, `text`, `is_final`, `metadata JSONB`.
  - Runtime writes:
    - full-call caller transcripts (`transcript_scope=full_call`),
    - per-turn caller + assistant transcripts (`transcript_scope=turn`).

- **`voice.leads`**
  - Exists with lead fields (`company_name`, `email`, `normalized_phone`, `normalized_domain`, `status`, etc.).
  - Indexed for matching (`normalized_domain`, `normalized_phone`, normalized email/company+city).
  - Runtime voice-bridge code currently does **not** insert into this table.

- **`voice.call_summaries`**
  - Exists with `summary_text`, `summary_type`, `model`, `metadata`.
  - Unique index on `(call_session_id, summary_type)`.
  - Runtime voice-bridge code currently does **not** insert into this table.

**Founder-assumption deltas (from repository evidence)**
- Assumed tables exist: **confirmed**.
- Assumed lead/summaries may already be used: **not currently verified in runtime code**; no write paths found in `voice-bridge/src`.

## Recording and Transcription Findings

- Recording controls in config:
  - `VOICE_RECORDING_ENABLED`, `VOICE_RECORDING_MAX_SECONDS`, `VOICE_RECORDING_DIR` (`voice-bridge/src/config.js`, `.env.example`).
- Actual behavior:
  - only inbound caller audio frames are buffered (`captureInboundAudio`),
  - greeting/silence outbound audio are not buffered for full-call recorder,
  - buffer has max-bytes cap; if exceeded, buffering stops and call continues.
- File outputs:
  - full-call post-call: `<bridge_call_id>.slin`, `<bridge_call_id>.wav` in recording dir (`writeRecordingFiles`),
  - assistant-turn files: `*-turnN-caller.slin/.wav` and `*-turnN-assistant.wav/.slin`.
- Transcription:
  - full-call transcription only when `VOICE_TRANSCRIPTION_ENABLED=true` (`transcribeRecording`),
  - model default `gpt-4o-mini-transcribe`,
  - on success writes transcript row + `transcript_created` event.
- In-call assistant transcription:
  - when assistant enabled, each turn uses OpenAI STT in `transcribeTurn(...)`.
- Consent/notice:
  - No explicit consent capture field writing found in runtime code.
  - No explicit "recording consent state" persisted in `voice.call_sessions`/events by dedicated logic.
  - **Unknown / Requires Follow-up**: whether Asterisk/dialplan/legal messaging outside this repo provides consent notice before recording.
- Retention/deletion:
  - No retention scheduler, deletion job, or export/delete API found in `voice-bridge/src`.
  - **Unknown / Requires Follow-up**: external ops process for file/database retention.

## Privacy / GDPR Risk Areas

- **PII-bearing data paths (code-level)**
  - Transcript text persisted (`voice.call_transcripts.text`, `.content`).
  - Turn-level transcript previews logged in `voice-assistant` logs.
  - Recording file paths and metadata persisted in events/transcripts.
  - Remote address stored in session/event metadata (`initial_remote_address`, `remote_address`).
- **Consent evidence gap**
  - Runtime does not persist explicit consent/notice flag.
  - Risk classification: **High** (legal/compliance evidence gap).
- **Retention controls gap**
  - No in-code retention/deletion for recordings/transcripts.
  - Risk classification: **High**.
- **Data minimization**
  - Positive: `safePayload` strips keys containing `password|secret|token|api_key`.
  - Limitation: does not redact transcript content or caller-derived personal details.
  - Risk classification: **Medium**.
- **Compliance state**
  - Compliance cannot be claimed from current repository inspection.
  - **Unknown / Requires Follow-up**: legal basis, DPA setup, retention policy, DSAR workflow.

## Prompt and Conversation Logic Findings

- System/behavior instructions are hardcoded in `createAssistantResponse(...)` (`voice-bridge/src/turn-assistant.js`).
- Knowledge file is loaded from `voice-bridge/knowledge/technolohit.md` via `readKnowledge()`.
- Deterministic logic exists:
  - intent detection regex (`detectIntent`),
  - transcript-quality classification (`classifyTranscript`),
  - known intent templates (`templateResponseForIntent`),
  - clarification fallback text constants.
- LLM generation path:
  - only for clear unknown intents (`responses.create`),
  - includes full knowledge file + compact recent history + latest caller text.
- Response constraints:
  - sentence and character limits (`VOICE_ASSISTANT_MAX_RESPONSE_SENTENCES`, `VOICE_ASSISTANT_MAX_RESPONSE_CHARS`).
- Behavior classification:
  - **Hybrid** (deterministic template + guarded LLM fallback).
- Pricing/identity policy:
  - explicit handling in both templates and hardcoded instructions.
- Hallucination controls:
  - instruction constraints + relevance check (`responseAddressesCaller`) + unknown fallback.
- Potential future knowledge-loading point:
  - existing `knowledgePath`/`readKnowledge()` path can structurally load an expanded knowledge document.

## Lead Capture Findings

- Schema readiness:
  - `voice.leads` exists with normalization/status fields (`db/voice/migrations/001_voice_schema.sql`).
- Runtime write status:
  - No lead insert/update logic found in `voice-bridge/src` (no `insert ... voice.leads` path).
- Current inferred capability:
  - system captures transcripts/events that could support later extraction, but does not currently create lead rows.
- Desired future field comparison:
  - present now: `email`, `normalized_phone`, `normalized_domain`, `company_name`, `city`, `country`, basic `status`, `metadata`.
  - missing as explicit columns from requested set: `contact_name`, `phone` (raw lead phone), `business_type`, `website_url`, `main_topic`, `main_pain_point`, `preferred_callback_time`, `lead_status` (current `status` exists but different semantic naming), `source_call_session_id` (current `call_session_id` close equivalent), `raw_extraction` (possible via `metadata` but no dedicated column).
- Duplicate-prevention readiness:
  - supporting indexes exist (normalized phone/domain/email/company-city).
  - extraction + matching algorithm not implemented in runtime voice-bridge.

## Notification / Follow-up Findings

- No in-repo voice-bridge module found for:
  - email notification dispatch,
  - Telegram notification,
  - webhook callback dispatch,
  - n8n post-call trigger invocation.
- Post-call behavior currently is local to bridge:
  - recording write + optional transcription (`runPostCallProcessing`).
- Event persistence exists in DB (`call_events`) and can be used by future async workers.
- Realtime safety:
  - no n8n coupling in realtime path found in code (aligns with architecture direction).
- **Unknown / Requires Follow-up**:
  - whether external jobs/services (outside this repo) consume `voice.call_events` for follow-up.

## OpenAI Usage / Cost Findings

- OpenAI touchpoints:
  - Post-call STT: `voice-bridge/src/transcribe.js` -> `audio.transcriptions.create`.
  - Turn STT: `voice-bridge/src/turn-assistant.js` -> `audio.transcriptions.create`.
  - Turn LLM response (unknown intents): `responses.create`.
  - Turn TTS playback: `audio.speech.create`.
  - Greeting generation script (dev utility): `voice-bridge/scripts/generate-greeting-openai.js` -> `/v1/audio/speech`.
- Per-turn call volume (assistant enabled):
  - known intent clear turn: STT + TTS (2 OpenAI calls),
  - unknown intent clear turn: STT + LLM + TTS (3 OpenAI calls),
  - unclear turn with clarification playback: STT + TTS (2 calls),
  - optional full-call transcription adds +1 per call post-call when enabled.
- Cost/latency risk areas:
  - full knowledge text included in unknown-intent LLM input each time.
  - synchronous sequential turn pipeline (listen window + STT + generation + TTS + playback) adds latency.
  - no explicit token accounting persistence for OpenAI responses.
  - no explicit timeout/retry policy in OpenAI call options (SDK defaults only).
- Fallbacks:
  - deterministic templates reduce LLM usage for known intents.
  - safe failure paths prevent call process crash.

## Security Findings

- **Medium** - Secrets handling in repo
  - `.env` and `.env.*` ignored (`.gitignore`), `.env.example` committed.
  - `voice-bridge/.dockerignore` excludes env/logs/recordings from image build context.
- **Medium** - OpenAI/DB secret exposure controls
  - API keys/passwords not logged directly in inspected code.
  - `safePayload` strips common secret-like keys from payloads.
- **Medium** - Potential sensitive log content
  - transcript previews and response previews are logged in `turn-assistant`.
  - file paths and metadata are logged/persisted.
- **High** - Network exposure risk
  - bridge defaults to bind `0.0.0.0:9092`; if not firewalled/internal-only this exposes raw audio ingress.
  - **Unknown / Requires Follow-up**: production network ACL and host firewall enforcement.
- **Medium** - Data at rest exposure risk
  - recordings stored as plaintext files (`.slin`, `.wav`) under configured directory.
  - **Unknown / Requires Follow-up**: disk encryption, host access controls, backup handling.
- **Unknown** - Public API exposure
  - no HTTP API present in `voice-bridge/src`; only TCP AudioSocket service.
  - **Unknown / Requires Follow-up**: any external reverse-proxy or port exposure not represented in repo.

## Botinteg / Future Integration Reuse Opportunities

- Reusable components for future integration:
  - Session/event model: `voice.call_sessions`, `voice.call_events`.
  - Transcript model with metadata: `voice.call_transcripts`.
  - Knowledge grounding mechanism: `voice-bridge/knowledge/technolohit.md` + `readKnowledge()`.
  - Intent and transcript quality classification logic: `detectIntent`, `classifyTranscript`.
  - Call identity bridging: `bridge_call_id`, `audiosocket_uuid` tracking.
- Reuse opportunities:
  - async post-call worker can consume DB events without touching realtime audio path.
  - lead extraction service can build from existing transcript/event records.
- Duplicate-system risks:
  - implementing parallel session/event/transcript storage in another stack would duplicate existing persistence model.
  - adding public-widget style data exposure to voice tables would conflict with private owner-side call-data boundary.
- **Unknown / Requires Follow-up**:
  - canonical cross-system integration contract (event schema/versioning/API) is not defined in repo.

## Gaps / Unknowns

- Exact production `from-easybell` dialplan content is not present in repo (`extensions.conf` missing here).
- Base production `docker-compose.yml` for full voice stack is not present; only `asterisk/docker-compose.prod.yml` override is present.
- Consent/notice implementation source (if any) is not verifiable from repository runtime code.
- No verifiable in-repo retention/deletion/export workflow for recordings/transcripts.
- No verifiable in-repo post-call notification consumer (email/Telegram/webhook/n8n) for voice events.
- No cost telemetry persistence (token usage per call/turn) found.
- Legal/compliance controls (DPA, purpose limitation docs, DSAR process) are outside code scope.

## Recommended Next Steps

- Validate operational unknowns before implementation:
  - confirm production dialplan path and exact `AudioSocket(...)` routing source file,
  - confirm network boundary for `VOICE_BRIDGE_PORT` exposure,
  - document retention/deletion policy owner and execution mechanism,
  - document consent/notice legal flow and where it is captured as evidence.
- Define an explicit inspection follow-up checklist:
  - DB event consumer ownership (if any),
  - whether `voice.leads` and `voice.call_summaries` should be written by bridge or async worker,
  - required metadata contract for future callback workflow.
- Prepare implementation planning inputs (without coding yet):
  - prioritize privacy/security remediations (consent evidence, retention, log minimization),
  - quantify OpenAI per-call cost envelopes for different assistant modes,
  - specify clear boundaries for any future Botinteg/CRM integration on async layer only.

## Do Not Implement Yet

- Do not add or change voice assistant features in code.
- Do not change prompts or knowledge behavior yet.
- Do not create migrations or alter schema.
- Do not refactor runtime call flow.
- Do not edit Docker/deployment/env/secrets.
- Do not add dependencies.
- Do not change model settings.
- Do not add notification workflows, n8n workflows, or Botinteg integration yet.
- First complete operational/legal follow-up on the Unknown / Requires Follow-up items above.

