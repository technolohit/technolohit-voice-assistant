# TechnoloHit Voice Assistant v4 — Phase 10E2 Real Provider-Backed Live TTS Report

Date: 2026-06-01  
Status: **Phase 10E2 implemented in repo** — intelligible live TTS when explicitly configured; **production v4 NOT enabled**  
Prior: [Phase 10E live TTS/playback report](./voice_assistant_v4_phase10e_live_tts_playback_report.md)

## Objective

Phase 10E proved mock-safe TTS/playback plumbing. Phase 10E2 wires **real OpenAI TTS** into the gated `v4_canary` live path, converts WAV output to **8 kHz s16le mono PCM** for AudioSocket, and preserves all Phase 10E safety behavior.

## Files changed

| File | Change |
|------|--------|
| `voice-bridge/src/v4/openai-tts-provider.js` | **New** — OpenAI speech API + PCM pipeline |
| `voice-bridge/src/v4/tts-pcm-convert.js` | **New** — ffmpeg WAV → 8 kHz PCM |
| `voice-bridge/src/v4/tts-adapter.js` | `synthesizeSentenceChunkAsync` for OpenAI |
| `voice-bridge/src/v4/live-tts-playback-endpoint.js` | `resolveLiveTtsProvider`, OpenAI live adapter |
| `voice-bridge/src/config.js` | `VOICE_V4_TTS_PROVIDER` default **mock** |
| `voice-bridge/src/v4/canary-runtime-loop.js` | Phase `phase10e2_live_real_tts` |
| `voice-bridge/tests/v4-phase10e2-real-tts.test.js` | **New** — injected fetch/ffmpeg, no network |
| `voice-bridge/.env.example` | Document mock vs openai for live QA |

**Not changed:** `turn-assistant.js`, production env, `docs/Tasks/logs.txt`.

## Configuration (live canary QA only)

| Variable | Role |
|----------|------|
| `VOICE_V4_TTS_PROVIDER` | `mock` (default) or `openai` for real speech |
| `OPENAI_API_KEY` | Required when provider is `openai` |
| `VOICE_ASSISTANT_TTS_MODEL` | OpenAI TTS model (e.g. `gpt-4o-mini-tts`) |
| `VOICE_ASSISTANT_TTS_VOICE` | Voice (e.g. `marin`) |
| `VOICE_ASSISTANT_TTS_SPEED` | Clamped 0.75–1.15 |

All Phase 10A gates still required (`VOICE_RUNTIME_VERSION=v4`, realtime, canary, live AudioSocket, non-empty allowlist).

## Behavior

| Case | Result |
|------|--------|
| Default / unset `VOICE_V4_TTS_PROVIDER` | Mock TTS (Phase 10E behavior) |
| `openai` + valid API key on live path | Fetch WAV → ffmpeg → PCM → playback |
| `openai` without API key | Fail closed to mock adapter selection |
| Phone-like assistant text | Safe fallback phrase; no raw phone synthesis |
| TTS or conversion failure | `[v4-live] tts_failed`, `tts_error` event, call continues |
| Playback failure | `[v4-live] playback_failed`, `playback_error` event |

## Quality events (unchanged + metadata)

- `tts_started` / `tts_first_chunk` / `tts_completed` — includes `tts_provider` in payload
- `playback_started` / `playback_completed`
- `runtime_error` with `tts_error` or `playback_error` subtypes

No raw assistant text in logs.

## Tests / checks

| Check | Result |
|-------|--------|
| `voice-bridge npm test` | **267/267 pass** |
| `python -m pytest rag-api/tests` | **6/6 pass** |
| `node --check` (changed JS) | Pass |
| `git diff --check` | Clean |
| `run-ci-dialogue-scenarios.ps1` | **25/25 pass** |

Unit tests use **injected** `fetchImpl`, `execFileImpl`, and `synthesizeImplAsync` — no live OpenAI calls.

## Supervised live-call QA readiness

| Phase | Requirement |
|-------|-------------|
| 10E2 | Real intelligible TTS when operator sets `VOICE_V4_TTS_PROVIDER=openai` |
| **10F** | Barge-in / playback cancel |
| **10G** | Quality DB flush |
| **10H** | Live QA runbook |

**Human PSTN QA should start only after 10E2 + 10F–10H**, with all gates and allowlist on a dedicated QA route.

## Production v4 status

**Not approved.** Default production remains v3 with mock TTS provider default.
