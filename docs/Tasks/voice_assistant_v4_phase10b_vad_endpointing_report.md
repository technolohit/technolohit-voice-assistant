# TechnoloHit Voice Assistant v4 — Phase 10B VAD Endpointing Report

Date: 2026-06-01  
Status: **Phase 10B implemented in repo** — production v4 **NOT enabled**; live PSTN still does not answer turns  
Prior: [Phase 10A live route selection report](./voice_assistant_v4_phase10a_live_route_selection_report.md)

## Objective

When a call is selected as `v4_canary` (Phase 10A gates), feed inbound AudioSocket PCM into the v4 audio session and RMS VAD endpointing. Log safe lifecycle events only — no STT, TTS, or dialogue responses.

## Files inspected

| File | Purpose |
|------|---------|
| `voice-bridge/src/v4/live-audiosocket-handler.js` | Phase 10A handler |
| `voice-bridge/src/v4/canary-runtime-loop.js` | `createLiveCanaryRuntime` |
| `voice-bridge/src/v4/audio-session.js` | Frame + speech/endpoint markers |
| `voice-bridge/src/v4/vad-endpointing.js` | RMS VAD |
| `voice-bridge/src/v4/pcm-rms.js` | Frame RMS |
| `voice-bridge/src/v4/quality-events.js` | VAD event builders |
| `voice-bridge/src/v4/audiosocket-runtime.js` | `createVadStateFromConfig` |

## Files changed

| File | Change |
|------|--------|
| `voice-bridge/src/v4/live-audiosocket-handler.js` | `processLiveCanaryInboundFrame`, VAD logs, quality buffer |
| `voice-bridge/src/v4/canary-runtime-loop.js` | VAD state init; phase `phase10b_live_vad` |
| `voice-bridge/tests/v4-phase10-live-audiosocket-wiring.test.js` | Phase 10B tests |

**Not changed:** `turn-assistant.js`, production env, `docs/Tasks/logs.txt`.

## Exact env flags (unchanged from 10A)

Live v4 requires all gates; defaults keep production on v3:

```env
VOICE_RUNTIME_VERSION=v3                    # default
VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=false       # default
VOICE_V4_LIVE_CANARY_ALLOWLIST=               # default empty → blocks live v4
```

## Default production behavior

**Unchanged.** With v3 env, calls use `turn-assistant` exclusively. Phase 10B code runs only on `v4_canary` handler after all gates pass.

## Phase 10B behavior (gated v4_canary only)

Per inbound PCM frame:

1. `appendInboundFrame` on v4 audio session
2. `observeAudioFrame` on VAD state
3. On speech start → `[v4-live] vad_speech_started` + buffered `vad_speech_start` quality event
4. On endpoint → `[v4-live] vad_endpoint_detected` + buffered `vad_endpoint_detected` event
5. Periodic `[v4-live] inbound_frame_count=...`

Logs use `bridge_call_id` and `call_session_id` only. Quality events buffered in-memory (no DB flush in 10B).

## Safety gates

| Check | Result |
|-------|--------|
| v3 path unchanged | Yes — no VAD when `callHandler !== v4_canary` |
| Empty allowlist blocks live v4 | Yes |
| VAD/init failure → v3 | Yes — `validateLiveCanaryMediaRuntime` at selection |
| Inbound errors caught | Yes — no socket loop crash |
| No transcript/phone in logs | Yes |

## Tests / checks run

| Check | Result |
|-------|--------|
| `voice-bridge npm test` | **233/233 pass** |
| `python -m pytest rag-api/tests` | **6/6 pass** |
| `node --check` (changed JS) | Pass |
| `git diff --check` | Clean |
| `voice-bridge/scripts/run-ci-dialogue-scenarios.ps1` | **25/25 pass** |

## Remaining work

| Phase | Scope |
|-------|--------|
| **10C** | Live STT on VAD endpoint |
| 10D | Dialogue orchestrator on transcript |
| 10E | TTS playback |
| 10F | Barge-in |
| 10G | Quality DB flush |
| 10H | Live QA runbook |

## Production v4 status

**Not enabled.** Live canary calls detect speech/endpoints but **do not produce assistant responses** yet.

## Risks

- VAD quality on real PSTN may differ from synthetic PCM tests — tune thresholds in supervised window.
- Buffered quality events are not persisted until Phase 10G.
