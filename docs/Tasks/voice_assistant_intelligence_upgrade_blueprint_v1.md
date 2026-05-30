# TechnoloHit Voice Assistant Intelligence Upgrade Blueprint v1

Date: 2026-05-30

## Purpose

Upgrade the live TechnoloHit Voice Assistant from a mostly scripted phone intake bot into a more natural, privacy-safe, RAG-assisted AI receptionist.

This blueprint is the roadmap for implementation. Each item should be checked only after the implementation, tests, and production evidence for that item are complete.

Primary goals:

- Use caller ID for callback permission when available, instead of asking the caller to repeat their phone number.
- Ask for a phone number only when caller ID is missing, anonymous, or unusable.
- Avoid duplicate permission questions.
- Add a short privacy/AI/transcription notice at the start of the call.
- Make product and intent recognition more semantic and synonym-aware.
- Use RAG more effectively for company/product questions without breaking deterministic call control.
- Improve unclear-input handling so the assistant does not repeat the full intro.
- Tune speaking tempo after the conversational flow is shorter and safer.
- Keep DSGVO/GDPR data minimisation and auditability intact.

## Owners (pre-merge)

| Role | Status | Notes |
|------|--------|-------|
| Blueprint acceptance | Accepted 2026-05-30 | Local code/QA review complete; production rollout not started |
| Implementation owner | Unassigned | Assign a named owner before production deploy |
| Production rollout owner | Unassigned | Assign sysadmin/release owner before deploy |

- [x] Successful: Blueprint reviewed and accepted.
- [ ] Successful: Implementation owner assigned.
- [ ] Successful: Production rollout owner assigned.

## Existing System Findings

Relevant existing services:

```text
voice-bridge/
rag-api/
lead-dashboard/
```

Relevant current implementation:

- `voice-bridge/src/turn-assistant.js` controls the turn-based assistant, intake flow, callback permission, product routing, RAG fallback, STT, and TTS.
- `voice-bridge/src/product-intake-policy.js` contains product aliases and deterministic product intake text.
- `voice-bridge/src/rag-client.js` calls `rag-api` `/v1/retrieve` with a timeout-protected fail-closed behavior.
- `voice-bridge/src/config.js` already exposes RAG, knowledge retrieval, assistant response-length, and TTS model/voice settings.
- `voice-bridge/src/persist.js` persists caller phone fields into `voice.call_sessions`.
- `voice-bridge/src/post-call-lead.js` already uses the call session phone for lead extraction.
- `lead-dashboard/` now provides WireGuard-only reveal access for callback phone numbers.

Existing useful config:

```env
VOICE_RAG_ENABLED=false
VOICE_RAG_API_URL=
VOICE_RAG_TIMEOUT_MS=700
VOICE_RAG_MIN_SCORE=0.72
VOICE_RAG_QA_MODE=false
VOICE_ASSISTANT_MAX_RESPONSE_CHARS=160
VOICE_ASSISTANT_MAX_RESPONSE_SENTENCES=2
VOICE_ASSISTANT_TTS_MODEL=gpt-4o-mini-tts
VOICE_ASSISTANT_TTS_VOICE=marin
VOICE_LOG_TRANSCRIPT_PREVIEW=false
```

Existing Caller ID work:

- `voice_assistant_caller_id_capture_v1_report.md` says caller ID capture was implemented.
- The current flow should already be able to use `ctx.callerPhoneNormalized` or `ctx.callerPhoneRaw`.
- Production still needs evidence that Asterisk actually passes caller ID metadata into `voice-bridge` for all expected inbound call paths.

- [x] Successful: Current `turn-assistant.js` callback path inspected.
- [x] Successful: Current product alias map inspected.
- [x] Successful: Current RAG fallback path inspected.
- [x] Successful: Current CI/CD workflows inspected.
- [ ] Successful: Production caller ID evidence collected.

## Design Decision Summary

Recommended direction:

```text
Keep one voice-bridge runtime, but make its conversation policy smarter.
Do not move live call orchestration into rag-api.
Do not make RAG a hard dependency for live calls.
```

Reason:

- `voice-bridge` owns the realtime call path and must stay resilient.
- `rag-api` should remain a retrieval service, not a call state machine.
- Deterministic control is still needed for consent, callback, email, and hangup behavior.
- RAG should help with answers and semantic understanding, but must fail closed.

Core principle:

```text
Rules for safety and privacy. RAG/LLM for understanding and helpful answers.
```

- [x] Successful: Architecture decision accepted.
- [x] Successful: RAG remains optional and timeout-protected.
- [x] Successful: Deterministic privacy/control paths remain protected.

## Tempo Decision

Tempo should be included in this blueprint, but not as the first implementation item.

Recommended order:

1. Shorten and fix conversation flow first.
2. Remove duplicate questions.
3. Improve product/intent/RAG behavior.
4. Then tune TTS speed.

Reason:

- If we increase speed before fixing the content, the assistant will only speak the same repetitive text faster.
- Shorter answers reduce perceived slowness more than raw TTS speed.
- TTS speed should be rolled out behind an environment variable so it can be adjusted without code changes.

Recommended future config:

```env
VOICE_ASSISTANT_TTS_SPEED=1.08
```

Implementation note:

- Verify the current OpenAI TTS SDK parameter support before coding.
- Start with a conservative value such as `1.05` or `1.08`.
- Do not exceed `1.15` without live-call QA, because phone audio at 8 kHz can become less clear.

- [x] Successful: Tempo included as controlled phase.
- [ ] Successful: First rollout target speed selected.

## Privacy And DSGVO/GDPR Guardrails

This is a technical privacy-by-design plan, not legal advice.

Rules:

- Do not include full phone numbers in Telegram, email, n8n payloads, or normal logs.
- Use caller ID only for the callback purpose requested by the caller.
- Ask permission before using the caller ID for callback.
- If caller ID is missing or anonymous, ask for a phone number only once.
- Full phone reveal remains inside the internal Lead Dashboard.
- Keep `VOICE_LOG_TRANSCRIPT_PREVIEW=false` by default.
- Do not automatically ingest raw call transcripts into long-term knowledge/RAG.
- Avoid storing more transcript detail than needed for lead summary and audit.

Recommended intro wording if calls are transcribed/summarized but not necessarily stored as full audio recordings:

```text
Guten Tag, Sie sprechen mit dem KI-Assistenten von TechnoloHit.
Zur Bearbeitung Ihres Anliegens kann dieses Gespraech verarbeitet und zusammengefasst werden.
Wie kann ich Ihnen helfen?
```

If full audio recording is enabled and retained, the wording must explicitly mention recording:

```text
Guten Tag, Sie sprechen mit dem KI-Assistenten von TechnoloHit.
Dieses Gespraech kann zur Bearbeitung Ihres Anliegens aufgezeichnet, verarbeitet und zusammengefasst werden.
Wie kann ich Ihnen helfen?
```

Before production wording is finalized, confirm with the responsible legal/privacy person which version matches the actual runtime behavior.

References already used in earlier privacy planning:

- European Commission: data minimisation
- European Commission: data protection by design/default
- European Commission: lawful processing and consent
- EDPB: secure personal data

- [x] Successful: Runtime recording/transcription behavior confirmed.
- [x] Successful: Intro privacy text selected.
- [ ] Successful: Legal/privacy responsible person reviewed intro text.
- [x] Successful: Logs verified to exclude full phone and transcript previews.

## Desired Callback Flow

### Caller ID available

When caller chooses phone callback and caller ID exists:

```text
Assistant:
Gerne. Darf unser Team Sie unter der Nummer zurueckrufen, von der Sie gerade anrufen?

Caller:
Ja.

Assistant:
Danke, ich habe es notiert. Unser Team meldet sich so bald wie moeglich.
```

Expected data:

```text
contact_preference=phone
permission=granted
contact_detail_source=caller_id
phone stored in DB only
no full phone in email/Telegram/n8n
```

### Caller ID missing

When caller chooses phone callback and caller ID is missing, anonymous, or unusable:

```text
Assistant:
Gerne. Unter welcher Telefonnummer darf unser Team Sie zurueckrufen?
```

This question already includes permission. After a valid phone number is captured, do not ask another generic permission question.

Expected data:

```text
contact_preference=phone
permission=granted_by_phone_capture
contact_detail_source=voice
phone stored in DB only
no full phone in email/Telegram/n8n
```

### Email path

When caller chooses email:

```text
Assistant:
Gerne. Schreiben Sie uns bitte kurz per E-Mail an ...
```

Do not force phone capture when email is preferred.

- [x] Successful: Caller ID path asks permission under current number.
- [x] Successful: Missing Caller ID path asks for callback number once.
- [x] Successful: Duplicate permission prompt removed.
- [x] Successful: Email path remains unchanged and safe.
- [x] Successful: Post-call lead summary correctly records phone source.

## RAG And Intelligence Design

Current pain:

- The assistant behaves too much like a scripted menu.
- It repeats long intro/product text when it does not understand.
- It does not reliably understand common synonyms such as `AI Assistant`, `KI Assistent`, `Telefonassistent`, or `Voice Assistant`.
- RAG exists, but the live assistant does not use it deeply enough for natural company/product questions.

Recommended model:

```text
Conversation Orchestrator
  - owns call state and safety-critical branches

Intent/Product Resolver
  - semantic and synonym-aware mapping of caller text

RAG Answerer
  - answers company/product questions with short, phone-friendly text

Lead Capture Policy
  - gathers callback/email only after intent is clear enough

Privacy Guardrail
  - prevents phone/transcript leakage into notifications/logs
```

RAG must be used for:

- product explanation questions
- company/service questions
- product synonyms and fuzzy user language
- follow-up questions after the caller has already selected a product

RAG must not control:

- permission yes/no
- phone/email capture
- caller ID consent
- hangup/closing
- retry limits
- raw transcript storage

- [x] Successful: RAG use cases accepted.
- [x] Successful: RAG exclusion list accepted.
- [x] Successful: Runtime keeps fail-closed behavior on RAG timeout/error.

## Product Synonym Map

The product resolver should map common German/English caller phrases to product IDs.

Minimum synonym improvements:

```text
voice_agent:
  - ai assistant
  - ai voice assistant
  - voice assistant
  - ki assistent
  - ki telefonassistent
  - telefonassistent
  - anrufassistent
  - digitale rezeption
  - digitaler assistent
  - telefon ki
  - voice bot
  - call bot

smart_website:
  - smart website
  - intelligente website
  - intelligente webseite
  - ki website
  - website mit ki
  - neue website
  - homepage

botinteg:
  - chatbot
  - ki chatbot
  - automation
  - automatisierung
  - lead erfassung

lokalki:
  - private ki
  - lokale ki
  - interne dokumente
  - sensible daten
  - datenschutz ki

aiseoq:
  - seo tool
  - wettbewerberanalyse
  - google sichtbarkeit
  - suchmaschinenoptimierung
```

Expected example:

```text
Caller:
Ich interessiere mich fuer AI Assistant.

Assistant:
Verstanden, es geht um unseren KI-Telefonassistenten beziehungsweise die digitale Rezeption.
Moechten Sie dazu eine kurze Erklaerung, oder soll unser Team Sie zurueckrufen?
```

- [x] Successful: Alias map expanded.
- [x] Successful: `AI Assistant` maps to `voice_agent`.
- [x] Successful: `KI Assistent` maps to `voice_agent`.
- [x] Successful: `Telefonassistent` maps to `voice_agent`.
- [x] Successful: Product resolver tests added.

## Clarification And Fallback Behavior

Bad current behavior:

- Caller says something simple.
- Assistant fails to classify.
- Assistant repeats a long intro/product menu.

Desired behavior:

If transcript is unclear:

```text
Entschuldigung, ich habe Sie akustisch nicht gut verstanden.
Koennen Sie Ihr Anliegen bitte kurz wiederholen?
```

If transcript is clear but intent is unknown:

```text
Ich bin nicht ganz sicher, ob es um Website, KI-Assistent, SEO oder Automatisierung geht.
Worum geht es bei Ihnen?
```

If caller says a likely product synonym:

```text
Meinen Sie unseren KI-Telefonassistenten beziehungsweise die digitale Rezeption?
```

Rules:

- Do not repeat the full greeting after turn 1.
- Do not repeat the full product menu unless the caller explicitly asks for products.
- Ask one short clarification question.
- If RAG finds a safe answer, answer briefly and then offer callback/email.

- [x] Successful: Full intro repeat removed from fallback.
- [x] Successful: Short clarification used for unclear audio.
- [x] Successful: Product synonym clarification works.
- [x] Successful: QA proves no long loop on unknown input.

## Implementation Phases

### Phase 0: Baseline And Server Evidence

Collect current production facts before code changes:

```bash
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
docker logs --tail=160 technolohit-voice-bridge
```

Check caller ID persistence:

```sql
SELECT
  id,
  started_at,
  caller_phone_raw,
  caller_phone_normalized,
  metadata->>'caller_phone_source' AS caller_phone_source
FROM voice.call_sessions
ORDER BY started_at DESC
LIMIT 20;
```

Check RAG service reachability from server:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Networks}}' | grep -E 'technolohit-rag-api|voice-bridge|NAME'
docker logs --tail=100 technolohit-rag-api
```

If the voice-bridge container should call RAG over Docker DNS, sysadmin should verify:

```bash
docker exec technolohit-voice-bridge sh -lc 'getent hosts technolohit-rag-api || true'
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://technolohit-rag-api:8080/healthz || true'
```

If DNS is not available, use the confirmed internal route/IP in `VOICE_RAG_API_URL`.

- [ ] Successful: Current production image recorded.
- [ ] Successful: Caller ID DB evidence collected.
- [ ] Successful: RAG API network path selected.
- [ ] Successful: Current env variables recorded without secrets.

### Phase 1: Caller ID Callback Flow Fix

Code areas:

```text
voice-bridge/src/turn-assistant.js
voice-bridge/src/persist.js
voice-bridge/src/post-call-lead.js
voice-bridge/src/config.js if needed
```

Tasks:

- Verify `ctx.callerPhoneNormalized` and `ctx.callerPhoneRaw` are populated.
- Treat caller ID as preferred callback phone when contact preference is phone.
- Ask for permission under current caller ID number.
- Ask for spoken phone only when caller ID is missing/anonymous.
- Remove second permission question after spoken callback number capture.
- Persist `contact_detail_source=caller_id|voice`.

- [x] Successful: Caller ID path implemented or confirmed already working.
- [x] Successful: Missing caller ID fallback implemented.
- [x] Successful: Duplicate permission removed.
- [x] Successful: Lead metadata records phone source.
- [x] Successful: Full phone remains out of notifications/logs.

### Phase 2: Privacy Intro

Code areas:

```text
voice-bridge/scripts/generate-greeting-openai.js
voice-bridge/audio/greeting.wav
voice-bridge/audio/greeting.slin
voice-bridge/.env.example
voice-bridge/README.md
```

Tasks:

- Select the correct intro wording depending on actual recording/transcription behavior.
- Regenerate greeting audio.
- Convert to `.slin` for Asterisk playback.
- Keep intro short and natural.
- Document the chosen wording and reason.

Commands likely needed locally or in CI:

```bash
cd voice-bridge
npm run audio:build
```

Sysadmin production verification:

```bash
docker exec technolohit-voice-bridge sh -lc 'ls -lah /app/audio && file /app/audio/greeting.slin || true'
docker logs --tail=120 technolohit-voice-bridge | grep -i greeting || true
```

- [ ] Successful: Intro text approved.
- [ ] Successful: Greeting audio regenerated.
- [ ] Successful: Greeting audio included in Docker image.
- [ ] Successful: Live call confirms intro is understandable.

### Phase 3: Product Intent And Synonyms

Code areas:

```text
voice-bridge/src/product-intake-policy.js
voice-bridge/knowledge/products.technolohit.json
voice-bridge/scripts/qa-dialogue-text.js
```

Tasks:

- Expand product aliases.
- Add normalization for common STT variants.
- Ensure `voice_agent` and `digital_assistant` are not split inconsistently.
- Add QA scenarios for German and English product names.

Required test phrases:

```text
Ich interessiere mich fuer AI Assistant.
Ich brauche einen KI Assistenten am Telefon.
Kann ich so einen Telefonassistenten fuer meine Firma bekommen?
Was ist eure digitale Rezeption?
```

- [x] Successful: Alias map updated.
- [x] Successful: QA scenarios added.
- [x] Successful: All required phrases route to `voice_agent`.

### Phase 4: RAG-First Answers For Safe Questions

Code areas:

```text
voice-bridge/src/turn-assistant.js
voice-bridge/src/rag-client.js
rag-api/app/retrieval.py if retrieval quality needs tuning
voice-bridge/knowledge/
```

Tasks:

- Keep deterministic safety routes first.
- Use RAG earlier for clear company/product questions, not only after brittle fixed templates fail.
- Generate short phone-friendly answers from retrieved context.
- Add source-aware telemetry without logging raw caller text by default.
- Add a maximum response length suitable for telephone audio.

Suggested behavior:

```text
Caller asks product/company question.
Assistant detects it is not permission/contact capture.
Assistant calls RAG with strict timeout.
If hit is strong, answer briefly and ask one useful next question.
If no hit, use safe fallback.
```

Production flags:

```env
VOICE_RAG_ENABLED=false
VOICE_RAG_QA_MODE=true
VOICE_RAG_API_URL=http://technolohit-rag-api:8080
VOICE_RAG_TIMEOUT_MS=700
VOICE_RAG_MIN_SCORE=0.72
```

Promotion rule:

- First QA with `VOICE_RAG_ENABLED=true` only in a controlled environment.
- Production enablement needs explicit approval.
- Rollback is one env change: `VOICE_RAG_ENABLED=false`.

- [x] Successful: RAG answer path designed.
- [x] Successful: RAG exclusion list protected.
- [x] Successful: RAG timeout path tested (local `retrieveRagContext` hang test in `npm test`).
- [x] Successful: RAG unavailable path tested (local unreachable-port test in `npm test`).
- [ ] Successful: QA mode evidence collected.

### Phase 5: Natural Clarification And Loop Prevention

Code areas:

```text
voice-bridge/src/turn-assistant.js
voice-bridge/scripts/qa-dialogue-text.js
```

Tasks:

- Replace repeated long intro with short clarification.
- Add loop counters for repeated misunderstanding.
- Avoid reading the product menu unless requested.
- Preserve human-like concise language.

Expected QA:

```text
Caller: Ich interessiere mich fuer AI Assistant.
Expected: recognized or short confirmation, no intro loop.

Caller: unklarer Satz / bad audio
Expected: asks to repeat briefly, no full menu.

Caller: Was macht TechnoloHit?
Expected: short RAG/knowledge answer, then useful follow-up.
```

- [x] Successful: Intro repeat loop removed.
- [x] Successful: Short clarification implemented.
- [x] Successful: Loop prevention tested.

### Phase 6: TTS Tempo And Response Length

Code areas:

```text
voice-bridge/src/config.js
voice-bridge/src/turn-assistant.js
voice-bridge/.env.example
voice-bridge/README.md
```

Tasks:

- Add `VOICE_ASSISTANT_TTS_SPEED`.
- Pass the speed to the TTS request if supported by the current SDK/API.
- Log selected speed at startup.
- Keep defaults conservative.
- Tune response length alongside speed.

Recommended first values:

```env
VOICE_ASSISTANT_TTS_SPEED=1.08
VOICE_ASSISTANT_MAX_RESPONSE_CHARS=160
VOICE_ASSISTANT_MAX_RESPONSE_SENTENCES=2
```

QA:

- Test at `1.00`, `1.05`, `1.08`, and `1.12`.
- Verify German phone audio remains clear over real PSTN.
- Verify callback permission is still easy to understand.

- [x] Successful: TTS speed config added.
- [x] Successful: Speed default remains safe.
- [ ] Successful: Real-call QA selects production value.

### Phase 7: CI/CD And Test Automation

Current CI:

- Runs Node dependency install.
- Checks JavaScript syntax.
- Checks Python/RAG syntax.
- Runs RAG static contract tests.
- Guards secrets and runtime artifacts.

Needed improvements:

- Add automated voice dialogue QA to CI.
- Add tests for product synonym routing.
- Add tests for caller ID callback flow.
- Add tests proving no full phone appears in logs/notification payload fixtures.
- Add tests for RAG fail-closed behavior if practical without external services.

Recommended CI command:

```bash
cd voice-bridge
npm run qa:dialogue
```

Release policy:

- Push to GitHub should run CI automatically.
- Production deployment should not happen on every push to `main`.
- Docker image build/push should happen on semver tag or controlled workflow dispatch.
- Production deploy should be manual or protected by GitHub Environment approval.

Reason:

- This is a live phone system.
- A bad deploy immediately affects real callers.
- Safe automation means automatic tests and image creation, not uncontrolled production rollout.

- [x] Successful: CI runs dialogue QA.
- [x] Successful: CI includes synonym tests.
- [x] Successful: CI includes callback flow tests.
- [x] Successful: Docker publish remains tag-based or protected.
- [x] Successful: Production deploy remains pinned to immutable image tag.

### Phase 8: Production Rollout

Recommended staged rollout:

1. Build image from branch.
2. Run local/static tests.
3. Push branch and confirm CI green.
4. Create release tag.
5. Wait for Docker image publish.
6. Deploy `voice-bridge` with pinned tag.
7. Keep RAG disabled first unless QA is explicitly approved.
8. Test real calls with a fixed matrix.
9. Enable RAG in QA mode / controlled production only after evidence.
10. Tune tempo after flow improvements are verified.

Example deploy verification:

```bash
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
docker exec technolohit-voice-bridge sh -lc 'printenv | sort | egrep "^(VOICE_ASSISTANT|VOICE_RAG|VOICE_GREETING|VOICE_LOG_TRANSCRIPT_PREVIEW|BUILD_VERSION|IMAGE_TAG)=" || true'
docker logs --tail=160 technolohit-voice-bridge
```

Rollback:

```bash
VOICE_RAG_ENABLED=false
```

or redeploy previous immutable image:

```bash
VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-previous-tag docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

- [ ] Successful: CI green on branch.
- [ ] Successful: Immutable image published.
- [ ] Successful: Production deploy completed with pinned tag.
- [ ] Successful: Real call smoke test passed.
- [ ] Successful: Rollback path verified.

## Sysadmin Preparation

Ask sysadmin to provide or verify these before production rollout.

### Caller ID Evidence

```bash
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -P pager=off -c "
SELECT id, started_at, caller_phone_raw, caller_phone_normalized, metadata->>'caller_phone_source' AS source
FROM voice.call_sessions
ORDER BY started_at DESC
LIMIT 20;"
```

Need to know:

- Are `caller_phone_raw` and `caller_phone_normalized` populated for real inbound calls?
- Are anonymous/withheld numbers represented clearly?
- Is caller ID present before the assistant asks for callback preference?

### RAG Runtime Path

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Networks}}' | grep -E 'technolohit-rag-api|technolohit-voice-bridge|NAME'
docker exec technolohit-voice-bridge sh -lc 'getent hosts technolohit-rag-api || true'
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://technolohit-rag-api:8080/healthz || true'
```

Need to know final:

```env
VOICE_RAG_API_URL=http://technolohit-rag-api:8080
```

or another confirmed internal URL.

### Production Env Review

Confirm current values without exposing secrets:

```bash
docker exec technolohit-voice-bridge sh -lc 'printenv | sort | egrep "^(VOICE_ASSISTANT|VOICE_RAG|VOICE_GREETING|VOICE_RECORDING|VOICE_TRANSCRIPTION|VOICE_LOG_TRANSCRIPT_PREVIEW)=" || true'
```

Need to know:

- Is `VOICE_RECORDING_ENABLED=true`?
- Is full audio retained?
- Is transcription enabled?
- What exact privacy intro wording is required?
- Is `VOICE_RAG_ENABLED` currently false in production?

- [ ] Successful: Caller ID evidence received.
- [ ] Successful: RAG internal URL confirmed.
- [ ] Successful: Recording/transcription facts confirmed.
- [ ] Successful: Production env reviewed without secrets.

## Acceptance Criteria

Functional:

- Caller ID callback path does not ask the caller to read their phone number.
- Missing caller ID path asks for callback phone only once.
- Duplicate permission question is gone.
- `AI Assistant`, `KI Assistent`, and `Telefonassistent` map to the voice assistant product.
- Unknown/unclear input triggers short clarification, not full intro repeat.
- RAG answers safe company/product questions when enabled and confidence is sufficient.
- RAG timeout/unavailable does not break the call.
- TTS tempo is configurable and QA-approved before production use.

Privacy/security:

- Full phone remains out of email, Telegram, n8n payloads, and default logs.
- Caller ID use is purpose-limited to callback flow.
- Lead Dashboard remains the only full-phone reveal surface.
- Transcript preview logging remains disabled by default.
- Privacy intro wording matches actual processing/recording behavior.

CI/CD:

- Push to GitHub runs CI automatically.
- CI includes syntax checks and dialogue/intelligence tests.
- Docker images use immutable tags.
- Production deploy is protected/manual or otherwise explicitly approved.
- Rollback path is documented and tested.

Local acceptance (code + automated QA only; production evidence still pending):

- [x] Successful: Local functional acceptance passed.
- [x] Successful: Local privacy/security guardrail acceptance passed.
- [x] Successful: Local CI/CD acceptance passed.

Production acceptance (pending):

- [ ] Successful: Production functional acceptance passed.
- [ ] Successful: Production privacy/security acceptance passed.
- [ ] Successful: Production CI/CD and deploy acceptance passed.

## Production rollout blockers (pending)

- Legal/privacy greeting approval (`VOICE_GREETING_PRIVACY_MODE` wording).
- Greeting audio regeneration and inclusion in Docker image.
- Immutable Docker image publish (semver tag).
- Manual production deploy (pinned tag).
- Live PSTN QA (including TTS speed candidate).
- Caller ID DB evidence on production inbound calls.
- RAG production QA with `VOICE_RAG_ENABLED=false` initially; enable only after controlled evidence.

## Open Questions

- Does production Asterisk always pass caller ID into AudioSocket metadata, or only in some paths?
- Is full audio recording retained, or only transcript/summary processing?
- Should RAG be enabled only for specific products first?
- What TTS speed feels natural on real German PSTN calls?
- Should the assistant mention `KI-Assistent` at greeting, or only when asked?
- Who is responsible for approving privacy intro wording?

- [ ] Successful: Open questions resolved before production rollout.
