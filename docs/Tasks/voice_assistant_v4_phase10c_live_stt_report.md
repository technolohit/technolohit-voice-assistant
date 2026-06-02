# TechnoloHit Voice Assistant v4 — Phase 10C Live STT on VAD Endpoint Report

Date: 2026-06-01  
Status: **Phase 10C implemented in repo** — production v4 **NOT enabled**; **live PSTN does not answer turns yet**  
Prior: [Phase 10B VAD endpointing report](./voice_assistant_v4_phase10b_vad_endpointing_report.md)

## Objective

On `v4_canary` calls, after Phase 10B VAD detects an endpoint, finalize the utterance PCM buffer and run the v4 STT adapter once. Store a redacted caller turn candidate in runtime memory. **No TTS, dialogue, or assistant audio.**

## Files changed

| File | Change |
|------|--------|
| `voice-bridge/src/v4/live-stt-endpoint.js` | **New** — utterance buffer, STT on endpoint, safe logs |
| `voice-bridge/src/v4/live-audiosocket-handler.js` | Async inbound processing; STT on endpoint |
| `voice-bridge/src/v4/canary-runtime-loop.js` | `sttAdapter`, `lastCallerTurnCandidate`, phase `phase10c_live_stt` |
| `voice-bridge/tests/v4-phase10-live-audiosocket-wiring.test.js` | Phase 10C tests; async VAD feeds |

**Not changed:** `turn-assistant.js`, production env, `docs/Tasks/logs.txt`.

## STT behavior

| Step | Action |
|------|--------|
| VAD speech start | `beginUtteranceCapture` — start STT stream, clear utterance buffer |
| During speech | `appendUtteranceFrame` — buffer PCM + `appendAudio` |
| VAD endpoint | `runLiveSttOnEndpoint` — `completeSttTurn`, store `lastCallerTurnCandidate` |
| STT failure | Log `[v4-live] stt_failed`, buffer `runtime_error` (subtype `stt_error`), reset buffer |
| Success | Log `[v4-live] stt_completed` with `transcript_chars` only |

Live canary uses `createLiveSttAdapter` with the **mock provider enabled** (`enabled: true`) regardless of `VOICE_V4_STREAMING_STT_ENABLED` or `VOICE_V4_STT_PROVIDER` until the OpenAI live path is wired with a real streaming implementation.

## Logs (safe metadata only)

- `[v4-live] stt_started` — `utterance_frames`
- `[v4-live] stt_completed` — `stt_ms`, `transcript_chars`
- `[v4-live] stt_failed` — `reason`, `stt_ms`

No raw audio or full transcript in logs.

## Quality events (memory buffer only)

- `stt_started`
- `stt_completed`
- `stt_final` (payload: `transcript_chars`, redacted `transcript_preview`)
- `runtime_error` with `event_subtype: stt_error` on failure

## Tests / checks

| Check | Result |
|-------|--------|
| `voice-bridge npm test` | **240/240 pass** |
| `python -m pytest rag-api/tests` | **6/6 pass** |
| `node --check` (changed JS) | Pass |
| `git diff --check` | Clean |
| `run-ci-dialogue-scenarios.ps1` | **25/25 pass** |

## Default production behavior

**Unchanged** — v3 env; live v4 gates off.

## Remaining work

| Phase | Scope |
|-------|--------|
| **10D** | Live dialogue orchestrator on `lastCallerTurnCandidate` transcript |
| 10E | TTS playback |
| 10F | Barge-in |
| 10G | Quality DB flush |
| 10H | Live QA runbook |

## Production v4 status

**Not enabled.** Callers on gated v4 canary hear greeting/silence; utterances are transcribed internally but receive **no assistant response**.
