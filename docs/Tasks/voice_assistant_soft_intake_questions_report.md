# Voice Assistant Soft Intake Questions Report

## Executive Summary

- Current runtime can already persist rich turn-level transcript metadata in `voice.call_transcripts.metadata` and event payloads in `voice.call_events.payload`, so Soft Intake v1 can likely be implemented without migrations if it remains metadata/event-based.
- Caller phone number is **not** currently populated by `voice-bridge` into `voice.call_sessions` caller phone columns.
- There is already in-memory per-call conversation state (`ctx.assistantTurn`) and turn history; this is the safest low-risk place to add lightweight intake state later.
- Intent/template system is already hybrid and extensible; `callback_request` and `email_campaign_caller` intents already exist.
- No lead table writes currently happen in runtime (`voice.leads` exists but unused by `voice-bridge` code).

## Caller Phone Number Availability

- **Does current system receive caller ID / phone number?**
  - From `voice-bridge` code: **not observed**.
  - `voice-bridge/src/audiosocket.js` context stores `remoteAddress`, `audiosocketUuid`, `bridgeCallId`, etc., but no caller phone field.

- **Where is caller phone stored currently?**
  - Schema has fields in `voice.call_sessions`:
    - `caller_phone_raw`
    - `caller_phone_normalized`
    - `callee_phone_raw`
    - `callee_phone_normalized`
    - Defined in `db/voice/migrations/001_voice_schema.sql`.
  - Runtime insert `db.createCallSession(...)` in `voice-bridge/src/db.js` does **not** set these columns (defaults remain empty strings).

- **Are `caller_phone_raw`, `caller_phone_e164`, etc. populated?**
  - `caller_phone_raw` / `caller_phone_normalized`: not populated by runtime code path.
  - `caller_phone_e164`: field does not exist in current schema.

- **Which file/function maps phone metadata into call sessions?**
  - No such mapping function found in `voice-bridge/src`.
  - Session creation path: `voice-bridge/src/persist.js` -> `onConnectionOpen(...)` -> `voice-bridge/src/db.js` `createCallSession(...)`.
  - Metadata currently stored includes `initial_remote_address`, `audiosocket_uuid`, `bridge_call_id`, etc., not caller phone.

- **Is phone available elsewhere (AudioSocket metadata, Asterisk vars, SIP headers, dialplan, logs, DB metadata)?**
  - AudioSocket path in repo exposes UUID frame and audio frames; no explicit caller number payload in bridge parser (`voice-bridge/src/audiosocket-protocol.js`, `voice-bridge/src/audiosocket.js`).
  - Asterisk dialplan source (`extensions.conf`) is not present in this repo (documented in `asterisk/README.md`), so caller ID handling there is **Unknown / Requires Follow-up**.
  - SIP headers are configured at PJSIP endpoint level (`asterisk/templates/pjsip.conf.template`) but no in-repo bridge mapping from SIP caller ID to DB rows.

- **What would be required later for reliable caller ID capture?**
  - Most likely: capture `CALLERID(...)` in Asterisk dialplan and pass it to bridge via a supported side-channel or persist it from Asterisk side keyed by call/session correlation ID.
  - Then extend `onConnectionOpen(...)` / `createCallSession(...)` input to set `caller_phone_raw` + normalized value.
  - Exact implementation path is **Unknown / Requires Follow-up** until production dialplan visibility is confirmed.

## Transcript and Metadata Storage

- **Per-turn transcript text storage**
  - Inserted via `voice-bridge/src/persist.js`:
    - `onTurnTranscribed(...)` (caller turn)
    - `onAssistantResponseCreated(...)` (assistant turn)
  - Written by `voice-bridge/src/db.js` `insertCallTranscript(...)` into:
    - `voice.call_transcripts.text`
    - `voice.call_transcripts.content`
    - `voice.call_transcripts.metadata`

- **Where metadata fields are stored**
  - Fields such as `detected_intent`, `transcript_quality`, `used_template_response`, `used_clarification_fallback`, `turn_index`, `used_llm_response`, etc. are stored in:
    - `voice.call_transcripts.metadata` (JSONB)
    - `voice.call_events.payload` (JSONB), depending on event.

- **Can we add metadata like `contact_preference_detected`, `callback_requested`, etc. without migration?**
  - Yes, in principle, by adding keys to JSON payloads/metadata in existing insert functions.
  - No schema migration required for additional JSONB keys.

- **Which functions write this metadata?**
  - Transcript metadata:
    - `voice-bridge/src/persist.js` `onTranscriptCreated(...)`
    - `onTurnTranscribed(...)`
    - `onAssistantResponseCreated(...)`
  - Event payload metadata:
    - many `on*` functions in `voice-bridge/src/persist.js`, all calling `db.insertCallEvent(...)`.

## Conversation State Support

- **In-memory state across turns exists?**
  - Yes.
  - `voice-bridge/src/turn-assistant.js` uses `turnState(ctx)` -> `ctx.assistantTurn` object.

- **Can assistant remember previous turn question?**
  - Yes, partially.
  - `ctx.assistantTurn.history` stores caller/assistant pairs and is passed into `createAssistantResponse(...)` via `conversationHistoryText(history)`.
  - Existing example: max-turn close behavior checks prior assistant response via `asksForCallback(lastAssistant)`.

- **Where recent history is stored/passed**
  - Stored in `ctx.assistantTurn.history`.
  - Passed to `createAssistantResponse(config, ctx, turnIndex, callerText, history, timings, analysis)`.

- **State object suitable for intake state?**
  - Yes: `ctx.assistantTurn` in `turn-assistant.js` is the safest minimal existing state location.

- **If not, safest minimal place later**
  - Recommended minimal place: add an `intake` sub-object under `ctx.assistantTurn` (e.g., `ctx.assistantTurn.intake = { ... }`), avoiding architecture refactor.

## Intent Detection Findings

- **Where implemented**
  - `voice-bridge/src/turn-assistant.js` function `detectIntent(text)`.

- **Current intents**
  - `english_language`
  - `seo_guarantee_question`
  - `pricing_question`
  - `human_or_ai_question`
  - `callback_request`
  - `free_analysis_request`
  - `email_campaign_caller`
  - `technology_question`
  - `what`
  - `website`
  - `smart_website_interest`
  - `voice_assistant_question`
  - `inquiries`
  - `visibility`
  - fallback: `unknown` (derived when no match)

- **Existing callback/handoff/free-analysis/email-campaign intents**
  - `callback_request`: yes
  - `free_analysis_request`: yes
  - `email_campaign_caller`: yes
  - explicit `handoff_requested`: no dedicated intent key yet

- **Ease of adding soft-intake intents**
  - Reasonably straightforward in current pattern (regex in `detectIntent`, mapping in `templateResponseForIntent`, optional checks in `responseAddressesCaller`):
    - `handoff_requested`
    - `contact_preference_email`
    - `contact_preference_phone`
    - `email_provided`
    - `phone_provided`
    - `refuses_contact_details`
  - No structural blocker observed.

- **Existing email/phone string extraction helpers**
  - No dedicated helper found for email or phone extraction in `voice-bridge/src/turn-assistant.js`.
  - Current helpers are generic text normalization/tokenization (`normalizeForIntent`, `wordsFrom`, `extractKeywords`), not contact parsing.

## Template Response Findings

- **Where deterministic templates are defined**
  - `voice-bridge/src/turn-assistant.js` function `templateResponseForIntent(intent, config, callerText = "")`.

- **Can templates ask one short follow-up question?**
  - Yes (current templates already do this).

- **Can templates vary by intake state?**
  - Not currently by an explicit intake state object.
  - They can vary by `callerText` currently (example: `callback_request` checks for "morgen").

- **Are templates pure intent-only?**
  - Not pure intent-only; current signature includes `config` + `callerText`.
  - They do not currently consume full `history` or explicit state object.

- **Smallest safe change for soft-intake templates later**
  - Extend `templateResponseForIntent` signature to accept a small optional `intakeState` object from `ctx.assistantTurn`.
  - Keep deterministic logic in the same file, avoid architecture changes.

## Lead Table Status

- `voice.leads` exists in schema (`db/voice/migrations/001_voice_schema.sql`).
- Runtime currently does **not** write to `voice.leads` from `voice-bridge/src`.
- Postponing `voice.leads` writes is feasible; next phase can rely on transcript/event metadata only.
- If only soft-intake metadata/events are added to existing JSONB fields, migration is not required.

## Consent / Permission Event Feasibility

- **Current dedicated consent mechanism**
  - No dedicated consent persistence mechanism found.

- **Can we store `contact_permission_requested` / `contact_permission_granted` in `voice.call_events` without schema changes?**
  - Yes, feasible via `event_type` + JSON payload in existing `voice.call_events`.

- **Which function inserts call events**
  - Low-level: `voice-bridge/src/db.js` `insertCallEvent(config, input)`.
  - Runtime wrappers: multiple `on*` functions in `voice-bridge/src/persist.js`.

- **Safer than writing lead rows immediately?**
  - Likely yes for Soft Intake v1: event-based consent trail + metadata avoids premature lead pipeline coupling.

## Email and Phone Extraction Feasibility

- **German spoken email extraction reliability**
  - Likely limited reliability in current pipeline, especially for spelled emails (`punkt`, `minus`, `unterstrich`, domain spelling variants).
  - STT ambiguity risk is high for exact email capture by voice.

- **Existing normalization helpers**
  - No dedicated email/phone normalization/extraction helpers found in `voice-bridge/src/turn-assistant.js`.

- **Recommendation: email collection now?**
  - Lower risk approach: ask contact preference + permission, then handoff to human follow-up.
  - Offer `info@technolohit.com` when caller declines sharing details.

- **If caller ID unavailable, asking phone by voice reliable enough?**
  - Moderate/low reliability for exact digits in natural call conditions, especially with accents/noise and variable pacing.

- **Likely STT issues**
  - digit confusion (`zwei/drei`, `vier/fier`, etc.),
  - separators (`plus`, `minus`, spaces),
  - clipped utterances due turn boundaries,
  - domain/email token misrecognition,
  - repetition burden can degrade UX.

## Recommended Minimal Implementation Shape

Lowest-risk Soft Intake v1 shape (based on current code):

- **Likely files to change later**
  - `voice-bridge/src/turn-assistant.js`
    - add intake intents
    - add soft-intake template prompts
    - maintain one-question-at-a-time behavior
    - track lightweight intake state in `ctx.assistantTurn`
  - `voice-bridge/src/persist.js`
    - optionally add new call events for permission/intake milestones
    - optionally add extra transcript metadata keys
  - `voice-bridge/knowledge/technolohit.md`
    - add concise intake phrasing rules
  - `voice-bridge/README.md`
    - document behavior and privacy boundaries

- **Migrations needed?**
  - Not required if using existing JSONB metadata/event payload fields.

- **New env vars needed?**
  - Optional only, if policy toggles are desired (e.g., enable/disable contact preference prompts).
  - Not strictly required for minimal implementation.

- **Tests / QA needed**
  - At minimum: manual call scenario QA for intake prompts, permission language, decline flows, and no-over-collection behavior.
  - Static checks already used in repo (`node --check`, `npm run validate`) remain relevant.

- **Modularity**
  - Keep business phrases in knowledge file and deterministic template section.
  - Avoid adding external integrations in realtime path.
  - Keep state ephemeral per call in existing `ctx.assistantTurn`.

## Risks / Blockers

- **Privacy risk**
  - Over-collecting contact info without explicit permission event trail.

- **Caller ID uncertainty**
  - No reliable caller phone mapping currently visible in voice-bridge runtime.

- **STT reliability**
  - Spoken email/phone extraction risk of incorrect capture.

- **State management limitations**
  - Current state is in-memory only; no durable intake-state resume across restarts/call reconnect.

- **Conversation UX risk**
  - Assistant can become intrusive if intake questions trigger too often or too early.

- **Scope creep risk**
  - Accidental drift into lead extraction pipeline if intake storage is overextended in v1.

## Recommended Next Step

- Proceed with a minimal Soft Intake v1 design that:
  1. uses deterministic prompts only when interest/handoff intents are detected,
  2. asks only one short contact-preference question (`E-Mail oder telefonisch?`),
  3. records permission/intake milestones as `voice.call_events` + transcript metadata JSONB,
  4. avoids `voice.leads` writes for now,
  5. keeps human fallback path (`info@technolohit.com`) when caller declines sharing details.

- Before coding, confirm production dialplan visibility and caller-ID availability path (currently **Unknown / Requires Follow-up**).

