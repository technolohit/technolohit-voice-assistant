# TechnoloHit Voice Assistant v4 — Phase 10E Live TTS/Playback Report

Date: 2026-06-01  
Status: **Phase 10E implemented in repo** — gated `v4_canary` has TTS/playback plumbing with a mock-safe TTS adapter; **production v4 NOT enabled**; **not ready for intelligible live-call answer QA yet**; **barge-in not active**  
Prior: [Phase 10D live dialogue report](./voice_assistant_v4_phase10d_live_dialogue_report.md)

## Objective

After Phase 10D stores `runtime.lastAssistantPlanCandidate`, run the planned assistant response through the v4 TTS/playback path and stream the resulting audio buffer to AudioSocket via the playback controller. This phase validates **playback plumbing, state transitions, safe text handling, duplicate guards, and failure handling**.

Important: the current live adapter is intentionally **mock-safe**. It does not yet synthesize real OpenAI speech for intelligible live-call answers. Real provider-backed TTS is tracked as **Phase 10E2** and must be completed before supervised human QA expects understandable assistant speech.

## Files changed

| File | Change |
|------|--------|
| `voice-bridge/src/v4/live-tts-playback-endpoint.js` | **New** — TTS, playback, safe text prep, logs |
| `voice-bridge/src/v4/live-stt-endpoint.js` | Invoke TTS/playback after successful dialogue |
| `voice-bridge/src/v4/canary-runtime-loop.js` | `ttsAdapter`, playback counters, phase `phase10e` |
| `voice-bridge/src/v4/live-audiosocket-handler.js` | Store `v4LiveSocket`, call-end TTS/playback counts |
| `voice-bridge/tests/v4-phase10-live-audiosocket-wiring.test.js` | Phase 10E tests + mock socket helper |

**Not changed:** `turn-assistant.js`, production env, `docs/Tasks/logs.txt`.

## Runtime flow

```text
VAD endpoint → STT → dialogue plan → TTS synthesize → AudioSocket playback → LISTENING
```

| Step | Module |
|------|--------|
| Plan | `live-dialogue-endpoint.js` (10D) |
| Safe text | `prepareLiveAssistantSpeechText` — sanitize, redact, max chars, phone fail-closed → safe fallback |
| TTS | `createLiveTtsAdapter` (mock-safe for live canary; real provider-backed TTS deferred to Phase 10E2) |
| Playback | `playback-controller.js` + `streamPcmToSocket` |
| State | SPEAKING during playback → LISTENING after complete/failure |

## Logs (safe metadata only)

- `[v4-live] tts_started` — `response_chars`, `plan_type`
- `[v4-live] tts_completed` — `tts_ms`, `first_chunk_ms`, `chunks`
- `[v4-live] tts_failed` — `reason`
- `[v4-live] tts_text_fallback` — when phone-like text blocked
- `[v4-live] playback_started` / `playback_completed` / `playback_failed`

No raw assistant text or phone numbers in logs.

## Quality events (memory buffer only)

- `tts_started`, `tts_first_chunk`, `tts_completed`
- `playback_started`, `playback_completed`
- `runtime_error` with `event_subtype: tts_error` or `playback_error`

## Safety

- TTS/playback failures do not crash or drop calls.
- Duplicate playback guarded per plan key + `ttsPlaybackProcessed`.
- Phone-like assistant text is not synthesized; safe fallback phrase used instead.
- Barge-in / playback cancel **not implemented** (Phase 10F).

## Tests / checks

| Check | Result |
|-------|--------|
| `voice-bridge npm test` | **256/256 pass** |
| `python -m pytest rag-api/tests` | **6/6 pass** |
| `node --check` (changed JS) | Pass |
| `git diff --check` | Clean |
| `run-ci-dialogue-scenarios.ps1` | **25/25 pass** |

## Default production behavior

**Unchanged** — v3 env; all Phase 10A gates off; empty allowlist blocks live v4.

## Remaining work

| Phase | Scope |
|-------|--------|
| **10E2** | Real provider-backed TTS for intelligible live-call answers |
| 10F | Live barge-in / playback cancel |
| 10G | Quality DB flush |
| 10H | Live QA runbook |

## Production v4 status

**Not approved for production enablement.** Gated canary must not be used for intelligible answer QA until Phase 10E2 wires real provider-backed TTS. Tier 9b-B supervised canary still requires Phase 10E2, Phase 10F–10H, and operational sign-off.
