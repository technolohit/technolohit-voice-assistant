# TechnoloHit Voice Assistant v4 — Phase 10A Live Route Selection Report

Date: 2026-06-01  
Status: **Phase 10A implemented in repo** — production v4 **NOT enabled**  
Blueprint: [voice_assistant_v4_phase10_live_audiosocket_canary_wiring_blueprint.md](./voice_assistant_v4_phase10_live_audiosocket_canary_wiring_blueprint.md)

## Objective

Add the first live AudioSocket routing gate for future v4 canary: route selection, fail-closed v3 fallback, and `[v4-live]` lifecycle logs only. No STT/TTS/VAD/dialogue loop in this phase.

## Files inspected

| File | Purpose |
|------|---------|
| `voice-bridge/src/audiosocket.js` | Live call frame loop |
| `voice-bridge/src/media-outbound.js` | Greeting + turn-assistant start |
| `voice-bridge/src/config.js` | Env loading |
| `voice-bridge/src/v4/canary-runtime-loop.js` | Canary runtime factory |
| `voice-bridge/src/v4/runtime-router.js` | Stub route metadata |
| `voice-bridge/src/v4/runtime-context.js` | Agent/runtime context |
| Phase 10 blueprint | Architecture gates |

## Files changed

| File | Change |
|------|--------|
| `voice-bridge/src/config.js` | `liveAudioSocketEnabled`, `liveCanaryAllowlist` |
| `voice-bridge/src/v4/live-audiosocket-handler.js` | **New** — gates, selection, lifecycle |
| `voice-bridge/src/v4/canary-runtime-loop.js` | `createLiveCanaryRuntime()` |
| `voice-bridge/src/audiosocket.js` | Handler branch on UUID/inbound/finish |
| `voice-bridge/src/media-outbound.js` | `skipAssistant` option for v4 greeting |
| `voice-bridge/tests/v4-phase10-live-audiosocket-wiring.test.js` | **New** — T1–T6, T13–T14, T16 |
| `voice-bridge/.env.example` | New env vars |
| `.env.example` | New env vars |
| `docs/voice-bridge-runtime-env.md` | Phase 10A gate documentation |
| `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` | Phase 10A status |

**Not changed:** `turn-assistant.js`, production env, `docs/Tasks/logs.txt`.

## Code behavior changed?

**Yes — gated only.** Default production config behavior is unchanged (all calls remain v3). Live v4 activates only when every gate passes including non-empty allowlist match.

## Exact env flags (new)

```env
VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=false          # default
VOICE_V4_LIVE_CANARY_ALLOWLIST=                  # default empty → blocks live v4
```

Required together with existing flags for live v4 selection:

```env
VOICE_RUNTIME_VERSION=v4
VOICE_V4_REALTIME_ENABLED=true
VOICE_V4_CANARY_ENABLED=true
```

## Default production behavior

Unchanged when deploying with v1.11.0-style v3 env:

- `VOICE_RUNTIME_VERSION=v3`
- All `VOICE_V4_*` false
- `VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=false`
- Empty allowlist

All live PSTN calls continue through `turn-assistant` (v3).

## Safety gates

| Gate | Fail result |
|------|-------------|
| `runtimeVersion != v4` | v3 |
| `realtimeEnabled` false | v3 |
| `canaryEnabled` false | v3 |
| `liveAudioSocketEnabled` false | v3 |
| Empty allowlist | v3 |
| Allowlist no match on bridge/external id | v3 |
| Agent config load failure | v3 |
| Any UUID setup error | v3 + silence writer |

Logs use `bridge_call_id` and `call_session_id` only in `[v4-live]` lines.

## Tests / checks run

| Check | Result |
|-------|--------|
| `cd voice-bridge && npm test` | 226/226 pass |
| `python -m pytest rag-api/tests` | 6/6 pass |
| `node --check` on changed JS | pass |
| `git diff --check` | clean |

## Remaining work (10B–10H)

| Phase | Work |
|-------|------|
| 10B | Inbound PCM → audio session + VAD endpointing |
| 10C | STT adapter on endpoint |
| 10D | Dialogue orchestrator integration |
| 10E | TTS playback via playback-controller |
| 10F | Barge-in live path |
| 10G | Quality event DB flush on v4 close |
| 10H | Live QA runbook + Tier 9b-B execution |

## Production v4 status

**Not enabled.** Phase 10A does not approve production v4 or clear rollout blockers.

## Risks

- Operators must understand empty allowlist blocks live v4 even if other v4 flags are on.
- Phase 10A v4 calls play greeting + silence only (no assistant turns) — acceptable for canary window only.
- Mid-call v4→v3 fallback on init failure is at UUID time only; mid-call degrade remains 10D+ scope.
