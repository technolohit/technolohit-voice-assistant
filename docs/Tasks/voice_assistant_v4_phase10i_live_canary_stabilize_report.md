# v4 Phase 10I — Live Canary Stabilization Report (post failed 10H)

Date: 2026-06-01
Scope: **Code + tests + docs only** — no deploy, no production env edits, no production v4 enablement.

Reference QA failure: [voice_assistant_v4_phase10h_live_qa_report.md](./voice_assistant_v4_phase10h_live_qa_report.md)

---

## Root causes

| Issue | Root cause | Fix |
|-------|------------|-----|
| Utterance not understood | `createLiveSttAdapter()` always forced `mock` STT despite `VOICE_V4_STT_PROVIDER` | OpenAI endpoint/batch STT on VAD endpoint via `openai-stt-provider.js` + `completeSttTurnAsync` |
| Choppy assistant audio | Silence keepalive writer ran concurrently with v4 TTS PCM stream | Pause silence writer before playback; resume in `finally` after complete/cancel |
| Stale `call_session` | Socket error path did not run call teardown; finish not idempotent | `call-finish.js` idempotent finalize; socket error + hangup invoke finish; `onCallEnded` even if v4 flush throws |
| Misleading startup log | `v4_active=true` meant selected route active, not v4 runtime | `selected_runtime_*`, `v4_requested`, `v4_runtime_active` in startup log |

---

## Files changed

| Area | Files |
|------|--------|
| STT | `voice-bridge/src/v4/openai-stt-provider.js`, `pcm-wav.js`, `stt-adapter.js`, `live-stt-endpoint.js` |
| TTS/audio | `voice-bridge/src/v4/live-tts-playback-endpoint.js` |
| Call finish | `voice-bridge/src/call-finish.js`, `audiosocket.js` |
| Config/router | `voice-bridge/src/config.js`, `runtime-router.js`, `index.js`, `canary-runtime-loop.js` |
| Tests | `voice-bridge/tests/v4-phase10i-stabilize.test.js` (+ env helper updates in 10e2/10f/10g/wiring) |
| Docs | `voice_assistant_v4_phase10h_live_qa_runbook.md`, this report |

---

## Production behavior

**Unchanged** when default v3 env is used (`VOICE_RUNTIME_VERSION=v3`, live canary gates off). All v4 changes remain behind explicit canary flags.

---

## Phase 10H retry allowed?

**Yes — after** shipping image tag **≥ v1.20.0** (or commit containing 10I) and applying supervised env below. Do **not** retry on v1.19.0.

---

## Exact env for next supervised 10H retry

```env
VOICE_RUNTIME_VERSION=v4
VOICE_V4_REALTIME_ENABLED=true
VOICE_V4_CANARY_ENABLED=true
VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=true
VOICE_V4_LIVE_CANARY_ALLOWLIST=bridge:
VOICE_V4_STT_PROVIDER=openai
VOICE_V4_TTS_PROVIDER=openai
VOICE_V4_BARGE_IN_ENABLED=true
OPENAI_API_KEY=<set>
VOICE_RAG_ENABLED=false
```

Verify after restart:

- `stt_provider=openai` in container env
- Startup: `selected_runtime=v3 ...` on v3 rollback; on canary window logs show `stt_provider=openai` in `[voice-runtime]` line
- Live call: `[v4-live] stt_started stt_provider=openai`
- Playback: `silence_writer_paused` then `silence_writer_resumed`
- After hangup: `call_finish_persisted`; SQL stale-active query (runbook A.4c) shows session completed

Rollback:

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_LIVE_CANARY_ALLOWLIST=
VOICE_V4_STT_PROVIDER=mock
VOICE_V4_TTS_PROVIDER=mock
```

---

## Remaining blockers

- Broad allowlist `bridge:` still requires zero concurrent PSTN traffic during the window.
- Full streaming STT (incremental partials) remains future work; endpoint transcription is sufficient for 10H semantic QA.
- Production v4 GA still blocked pending successful supervised 10H pass + Phase 9c items.

---

## Verification (local)

```bash
cd voice-bridge && npm test
python -m pytest rag-api/tests
node --check voice-bridge/src/call-finish.js voice-bridge/src/v4/openai-stt-provider.js voice-bridge/src/v4/live-stt-endpoint.js
git diff --check
./scripts/run-ci-dialogue-scenarios.ps1
```
