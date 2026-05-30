# Voice Assistant Intelligence Upgrade v1 — Implementation Report

Date: 2026-05-30

## Summary

Implemented Phases 0–8 of `voice_assistant_intelligence_upgrade_blueprint_v1.md` in `voice-bridge/` with supporting CI, docs, and QA. Production deploy, greeting audio regeneration, live PSTN QA, and sysadmin evidence collection remain pending explicit rollout approval.

## Phases Completed (code + local QA)

| Phase | Status | Notes |
|-------|--------|-------|
| 0 Baseline | Verified locally | Production docker/DB evidence documented for sysadmin |
| 1 Caller ID callback | Done | Usable caller ID helper, updated prompts, no duplicate permission after voice phone capture |
| 2 Privacy intro | Done (text) | Greeting script + `VOICE_GREETING_PRIVACY_MODE`; audio regen requires OpenAI key |
| 3 Product synonyms | Done | Expanded aliases + compact voice-agent offer |
| 4 RAG-first answers | Done | Broader safe-question routing, follow-up question, fail-closed unchanged |
| 5 Clarification / loops | Done | Short unclear/unknown responses, loop handoff after repeated unknown |
| 6 TTS tempo | Done (config) | `VOICE_ASSISTANT_TTS_SPEED`; production value pending PSTN QA |
| 7 CI/CD | Done | Unit tests + dialogue QA in CI; deploy remains manual |
| 8 Rollout docs | Done | `docs/release-and-cicd.md` updated |

## Key Files Changed

- `voice-bridge/src/turn-assistant.js` — callback flow, product compact offer, RAG/clarification/loop logic, TTS speed
- `voice-bridge/src/caller-id.js` — `hasUsableCallerId`, anonymous detection
- `voice-bridge/src/greeting-text.js` — privacy intro wording
- `voice-bridge/src/product-intake-policy.js` — synonym map
- `voice-bridge/src/config.js` — TTS speed, default max chars 160
- `voice-bridge/scripts/qa-dialogue-text.js` — new scenarios
- `voice-bridge/tests/intelligence-upgrade.test.js` — unit tests
- `voice-bridge/scripts/generate-greeting-openai.js` — privacy greeting
- `.github/workflows/ci.yml` — dialogue QA + unit tests
- `voice-bridge/README.md`, `voice-bridge/.env.example`, `.env.example`, `docs/release-and-cicd.md`

## Local Tests Run

```bash
node --check voice-bridge/src/turn-assistant.js
node --check voice-bridge/src/caller-id.js
cd voice-bridge && npm test
# From voice-bridge/ (Windows PowerShell: use node directly, not npm run -- --scenario)
node scripts/qa-dialogue-text.js --scenario caller_id_callback
# All dialogue QA scenarios in ci.yml, including hotfix scenarios, pass
# npm test includes RAG fail-closed: missing URL, timeout (local hang server), unreachable port
```

## Pre-production cleanup (2026-05-30)

- Added `lead-dashboard/**/__pycache__/` and `lead-dashboard/**/*.pyc` to `.gitignore` (aligned with `rag-api/`).
- Removed nine accidentally tracked `lead-dashboard` `.pyc` files from git index; bytecode should never be committed.

## Live-call hotfix (2026-05-30)

Live testing of `voice-bridge-v1.1.0` showed two regressions:

- `Kurze Erklaerung` after the AI Assistant compact offer repeated the compact offer instead of explaining the product.
- User-facing responses still used `Rueckruf` / `zurueckrufen` wording, which must be avoided in spoken output.

Implemented hotfix:

- Added deterministic handling for short explanation requests after `product_compact_offer`.
- Added a concise Digitale Rezeption explanation followed by an email/phone choice.
- Added outbound response sanitization that replaces Rueckruf/zurueckrufen variants with telephone/contact wording.
- Kept inbound Rueckruf recognition as a phone/contact signal.
- Added dialogue QA scenarios: `voice_agent_short_explanation`, `rueckruf_input_maps_to_phone`, and `no_rueckruf_output`.
- Updated last-call SQL examples to exclude NULL `started_at` smoke rows and use `ORDER BY started_at DESC NULLS LAST`.

Caller ID production finding:

- Production `voice.call_sessions.caller_phone_raw` and `caller_phone_normalized` are empty for real calls.
- The assistant must therefore keep asking for the phone number when caller ID is absent.
- Sysadmin must wire caller ID into the AudioSocket UUID payload if caller-ID-based callback permission is required.

## Runtime Behavior Verified (local code inspection)

| Setting | Default in repo | Greeting mode |
|---------|-----------------|---------------|
| `VOICE_RECORDING_ENABLED` | `true` | `auto` → recording wording |
| `VOICE_TRANSCRIPTION_ENABLED` | `false` | post-call summary enabled |
| `VOICE_RAG_ENABLED` | `false` | optional, fail-closed |

## Pending (sysadmin / legal / production)

1. **Legal/privacy approval** for final greeting wording (`VOICE_GREETING_PRIVACY_MODE`).
2. **Regenerate greeting audio** on a machine with OpenAI quota: `cd voice-bridge && npm run audio:build`.
3. **Production caller ID DB evidence** (SQL in blueprint).
4. **RAG network path confirmation** from voice-bridge container.
5. **Immutable image publish + manual deploy** via GitHub Actions.
6. **Live PSTN call QA** including TTS speed candidate `1.08`.
7. **Production env review** without exposing secrets.

## Sysadmin Commands (production evidence)

```bash
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
docker exec technolohit-voice-bridge sh -lc 'printenv | sort | egrep "^(VOICE_ASSISTANT|VOICE_RAG|VOICE_GREETING|VOICE_RECORDING|VOICE_TRANSCRIPTION|VOICE_LOG_TRANSCRIPT_PREVIEW|BUILD_VERSION|IMAGE_TAG)=" || true'
docker logs --tail=160 technolohit-voice-bridge
docker exec technolohit-voice-bridge sh -lc 'ls -lah /app/audio && file /app/audio/greeting.slin || true'
```

Caller ID DB:

```sql
SELECT id, started_at, caller_phone_raw, caller_phone_normalized,
       metadata->>'caller_phone_source' AS caller_phone_source
FROM voice.call_sessions
WHERE started_at IS NOT NULL
ORDER BY started_at DESC NULLS LAST
LIMIT 20;
```

RAG:

```bash
docker exec technolohit-voice-bridge sh -lc 'getent hosts technolohit-rag-api || true'
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://technolohit-rag-api:8080/healthz || true'
```

## Next Production Rollout Step

1. Merge branch; confirm CI green.
2. Tag release (e.g. `v1.x.x`); wait for Docker publish.
3. Deploy with pinned `voice-bridge` tag via manual Deploy workflow.
4. Keep `VOICE_RAG_ENABLED=false` until controlled RAG QA.
5. Regenerate/deploy greeting audio after legal sign-off.
6. Run live call QA matrix from `docs/release-and-cicd.md`.

## Rollback

```bash
VOICE_RAG_ENABLED=false
```

or redeploy previous image tag (documented in `docs/release-and-cicd.md`).
