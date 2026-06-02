# TechnoloHit Voice Assistant v4 — Phase 10F Live Barge-In Report

Date: 2026-06-01  
Status: **Phase 10F implemented in repo** — live `v4_canary` barge-in via `VOICE_V4_BARGE_IN_ENABLED`; **production v4 NOT enabled**  
Prior: [Phase 10E2 real TTS report](./voice_assistant_v4_phase10e2_real_tts_report.md)

## Objective

Wire production-intended v4 barge-in / playback cancellation into the gated AudioSocket canary path. Caller speech during assistant playback cancels playback, preserves interruption context, and the next STT turn uses high-priority interruption recovery (product/topic switch, stop/correction).

## Files changed

| File | Change |
|------|--------|
| `voice-bridge/src/v4/live-barge-in-endpoint.js` | **New** — live barge-in observe/cancel/finalize |
| `voice-bridge/src/v4/live-audiosocket-handler.js` | Observe barge-in on each inbound frame during playback |
| `voice-bridge/src/v4/live-tts-playback-endpoint.js` | Cancellable PCM stream + `finalizeLivePlaybackAfterStream` |
| `voice-bridge/src/v4/live-dialogue-endpoint.js` | `resolveInterruptionRecovery` on next caller turn |
| `voice-bridge/src/v4/canary-runtime-loop.js` | Phase `phase10f_live_barge_in`, barge-in runtime fields |
| `voice-bridge/tests/v4-phase10f-live-barge-in.test.js` | **New** — Phase 10F suite |
| `voice-bridge/tests/v4-phase10-live-audiosocket-wiring.test.js` | Phase string update |
| `voice-bridge/tests/v4-phase10e2-real-tts.test.js` | Phase string update |

**Not changed:** `turn-assistant.js`, production env, `docs/Tasks/logs.txt`, Phase 0B/0C spike flags (not used on live path).

## Configuration

| Variable | Role |
|----------|------|
| `VOICE_V4_BARGE_IN_ENABLED` | **Required** for live barge-in (default `false`) |
| `VOICE_V4_BARGE_IN_RMS_THRESHOLD` | Speech RMS threshold during playback |
| `VOICE_V4_BARGE_IN_SPEECH_FRAMES` | Consecutive speech frames to trigger cancel |
| `VOICE_V4_BARGE_IN_MIN_PLAYBACK_MS` | Minimum playback before barge-in allowed |
| `VOICE_V4_BARGE_IN_CANCEL_TIMEOUT_MS` | Cancel timeout metadata |

All Phase 10A gates still required for live `v4_canary`.

## Behavior

| Case | Result |
|------|--------|
| `VOICE_V4_BARGE_IN_ENABLED=false` | Playback runs to completion; no cancel |
| `VOICE_V4_BARGE_IN_ENABLED=true` + speech during playback | Cancel stream, safe logs, interruption context, state → interrupted/listening |
| Next STT after barge-in | `resolveInterruptionRecovery` + `decideNextAction({ interruptionRecovery })` |
| Product/topic switch utterance | New `selected_product_id`; `INTERRUPTION_RECOVERY` plan when applicable |
| Detector/cancel/state errors | Warn + fail closed to listening; call not dropped |

## Safe logs (no raw transcript/phone/assistant text)

- `[v4-live] barge_in_detected` — `cancel_latency_ms`, `frames_sent_before_cancel`, `response_type`
- `[v4-live] playback_cancel_requested`
- `[v4-live] playback_cancelled`

Quality events: `barge_in_detected`, `playback_cancel_requested`, `playback_cancelled`, `interruption_context_captured` (no epoch timestamps in payload that resemble phone numbers).

## Supervised live-call QA readiness

| Phase | Requirement |
|-------|-------------|
| **10F** | Live barge-in on gated canary |
| **10G** | Quality DB flush |
| **10H** | Live QA runbook |

**Human PSTN QA should start only after 10G–10H**, with all gates and allowlist on a dedicated QA route.

## Production v4 status

**Not enabled.** Default route remains **v3**. Live barge-in is opt-in via `VOICE_V4_BARGE_IN_ENABLED` on the allowlisted canary path only.
