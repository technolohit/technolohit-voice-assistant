# TechnoloHit Voice Assistant v4 — Phase 3 Realtime Audio Foundation Report

Date: 2026-06-01  
Status: **Ready for review** (media/canary foundation; production remains v3)  
Blueprint: [voice_assistant_v4_realtime_tenant_ready_blueprint.md](./voice_assistant_v4_realtime_tenant_ready_blueprint.md)  
Phase 2: tagged `v1.5.0`

## Objective

Build the v4 **media layer foundation** (audio session, VAD, STT/TTS adapters, TTS cache, canary-safe AudioSocket routing) while **keeping production on v3** and **not implementing production barge-in** (Phase 4).

## Implemented vs deferred

| Area | Status |
|------|--------|
| Audio session | **Implemented** — frame/timing metrics, memory/state refs |
| VAD / endpointing | **Implemented** — RMS-based, 8 kHz PSTN frame assumptions |
| STT adapter | **Implemented** — mock provider + OpenAI placeholder (fail-closed) |
| TTS adapter | **Implemented** — sentence-chunk mock + cache integration |
| TTS phrase cache | **Implemented** — static phrases only; rejects phone/caller text |
| Canary AudioSocket routing | **Implemented** — `routeAudioSocketCall` / `prepareCanaryMediaContext` (harness-only) |
| Media quality events | **Implemented** — vad/stt/tts/session builders with redaction |
| Live OpenAI STT/TTS | **Deferred** — no live provider calls without test injection |
| Production barge-in | **Deferred** → Phase 4 (`VOICE_V4_BARGE_IN_ENABLED`) |
| Live dialogue orchestrator | **Deferred** → Phase 5 |
| Quality event DB persistence | **Deferred** → Phase 5/8 |

## Files changed / added

| File | Change |
|------|--------|
| `voice-bridge/src/v4/audio-session.js` | Full audio session API |
| `voice-bridge/src/v4/vad-endpointing.js` | RMS VAD + endpoint detection |
| `voice-bridge/src/v4/pcm-rms.js` | **New** shared PCM RMS helper |
| `voice-bridge/src/v4/stt-adapter.js` | Provider-neutral STT interface |
| `voice-bridge/src/v4/tts-adapter.js` | Sentence-chunk TTS interface |
| `voice-bridge/src/v4/tts-cache.js` | **New** static phrase cache |
| `voice-bridge/src/v4/audiosocket-runtime.js` | **New** canary routing skeleton |
| `voice-bridge/src/v4/runtime-context.js` | **New** extracted runtime context builder |
| `voice-bridge/src/v4/runtime-router.js` | Canary-aware route resolution |
| `voice-bridge/src/v4/quality-events.js` | Media event builders |
| `voice-bridge/src/config.js` | Phase 3 env flags |
| `voice-bridge/tests/v4-phase3-realtime-audio-foundation.test.js` | **New** Phase 3 tests |
| `voice-bridge/.env.example` | Phase 3 flags documented |
| `.env.example` | Phase 3 flags documented |
| `docs/voice-bridge-runtime-env.md` | Phase 3/canary flag docs |

## Flags and default behavior

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_V4_STREAMING_STT_ENABLED=false
VOICE_V4_STREAMING_TTS_ENABLED=false
VOICE_V4_CANARY_ENABLED=false
VOICE_V4_VAD_RMS_THRESHOLD=450
VOICE_V4_VAD_SPEECH_FRAMES=3
VOICE_V4_ENDPOINT_SILENCE_MS=600
VOICE_V4_ENDPOINT_MIN_SPEECH_MS=240
VOICE_V4_STT_PROVIDER=openai
VOICE_V4_TTS_PROVIDER=openai
VOICE_V4_TTS_CACHE_ENABLED=true
```

Production safety:

- Default config → `resolveRuntimeRoute` selects **v3**.
- `VOICE_RUNTIME_VERSION=v4` + `VOICE_V4_REALTIME_ENABLED=true` without canary → **v4 stub, handler v3**.
- Canary enabled → media context only when `harnessExplicit: true` (tests/QA harness); live calls still **handler v3**, **no call drop**.
- Phase 0B/0C spike flags unchanged and QA-only.

## Rollback

1. Keep `VOICE_RUNTIME_VERSION=v3` and all v4 flags off (defaults).
2. Deploy previous image tag (e.g. `voice-bridge-v1.5.0`) if needed.
3. No new DB migrations in Phase 3.

## Production-rollout blockers (tracked, not Phase 3 blockers)

- Final retention approval — Mojtaba, Founder of TechnoloHit
- Backup encryption confirmation
- Dedicated QA route
- Overload fallback destination
- OpenAI streaming/realtime limits

## Remaining work by blueprint phase

| Phase | Work |
|-------|------|
| **Phase 4** | Production barge-in via `VOICE_V4_BARGE_IN_ENABLED`; playback cancel in live v4 path |
| **Phase 5** | Live dialogue orchestrator; wire memory/state; quality event persistence |
| **Phase 6–9** | Live RAG, post-call, observability, production rollout |

## Risks

- RMS VAD is a foundation only; noisy PSTN lines may need Silero/WebRTC VAD later.
- OpenAI streaming STT/TTS interfaces are placeholders until provider wiring with secrets via env (not code).
- Canary skeleton does not exercise full AudioSocket PCM loop yet — Phase 4/5 integration required.

## Test results

- `voice-bridge npm test`: **132/132 pass**
- `python -m pytest rag-api/tests`: **6/6 pass**
- `node --check` on changed JS files: **pass**
- `git diff --check`: clean

## Next phase

**Phase 4 — Barge-In And Interruption Runtime Implementation** (`VOICE_V4_BARGE_IN_ENABLED`, not spike flags).
