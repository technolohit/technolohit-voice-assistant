# v4 Phase 10J — STT Failure Diagnostics, Fallback Prompt, Session Hardening

Date: 2026-06-01
Scope: **Code + tests + docs only** — no deploy, no production env edits, no production v4 enablement.

Prior live QA: [voice_assistant_v4_phase10h_live_qa_report.md](./voice_assistant_v4_phase10h_live_qa_report.md) — **v1.20.0 retry failed** (not accepted).

---

## Root cause hypothesis (updated)

| Observation (v1.20.0 retry) | Likely cause | 10J mitigation |
|-----------------------------|--------------|----------------|
| `stt_started` but no `stt_completed` (~530 ms) | OpenAI transcription HTTP/API error without actionable diagnostics in logs/SQL | Safe `stt_http_status`, `stt_error_code`, PCM/WAV byte metadata in `runtime_error` |
| Long caller silence after utterance | No dialogue/TTS on STT failure; silence writer only | Deterministic **acoustic retry** TTS prompt (no dialogue/RAG/leads) |
| Stale `call_session` after abort/restart | Process exit without finalizing in-flight AudioSocket calls | In-process registry + `process_shutdown` finalize on SIGTERM/SIGINT |
| Preflight not run before canary | Operator gap | Mandatory `npm run stt:preflight` gate in runbook |

---

## Files changed

| Area | Files |
|------|--------|
| STT diagnostics | `openai-stt-diagnostics.js`, `openai-stt-provider.js`, `stt-adapter.js`, `live-stt-endpoint.js` |
| STT fallback | `live-stt-fallback-endpoint.js` |
| Preflight | `openai-stt-preflight.js`, `scripts/openai-stt-preflight.js`, `package.json` |
| Session hardening | `active-call-registry.js`, `call-finish.js`, `audiosocket.js`, `index.js` |
| Tests | `v4-phase10j-stabilize.test.js`, `v4-phase10-live-audiosocket-wiring.test.js` |
| Docs | `voice_assistant_v4_phase10h_live_qa_runbook.md`, this report |

---

## Production behavior

**Unchanged** for default v3. Canary-only: richer STT errors, fallback prompt on STT failure, shutdown finalization.

---

## Phase 10H retry allowed?

**Not accepted** after v1.20.0 failure. A **new** supervised attempt requires image **≥ v1.21.0** (10J), passing preflight, and updated runbook gates. Passing 10J in CI does **not** constitute live QA pass.

---

## Sysadmin preflight + retry instructions

### 1. Deploy image ≥ `voice-bridge-v1.21.0` (after build from 10J commit)

### 2. Mandatory STT preflight (abort if fail)

```bash
docker exec technolohit-voice-bridge npm run stt:preflight
```

Expect: `openai_stt_preflight=pass`, `http_status=200` (or another 2xx), and `error_code=none` or `error_code=empty_transcript_on_tone`. The preflight uses a synthetic tone, so a 2xx empty transcript is acceptable for API/model/connectivity validation; live speech understanding is validated by the supervised call.

### 3. Stale session check (read-only, before window)

```sql
SELECT id, status, started_at, ended_at, external_call_id
FROM voice.call_sessions
WHERE status = 'active' AND ended_at IS NULL
ORDER BY started_at DESC
LIMIT 10;
```

### 4. Canary env (supervised window only)

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
```

### 5. During call — STT failure must not be silence

Logs: `stt_failed … http_status=…` then `stt_fallback_started` / `stt_fallback_completed`.

SQL: G.6 in runbook — `stt_failed_fallback_prompted=true` when fallback played.

### 6. Before rollback — collect logs (runbook I.0)

### 7. Rollback v3 + empty allowlist + mock STT/TTS

---

## Remaining blockers

- Root OpenAI STT failure on production utterances may still occur; 10J makes it **visible** and **audible**, not guaranteed fixed.
- `bridge:` allowlist still requires zero concurrent PSTN traffic.
- Production v4 GA blocked until successful supervised QA + Phase 9c.
