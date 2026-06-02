# v4 Phase 10H — Supervised Live PSTN QA Report (Template)

Date: _______________  
Operator: _______________  
Maintenance window (UTC): _______________  
Runbook: [voice_assistant_v4_phase10h_live_qa_runbook.md](./voice_assistant_v4_phase10h_live_qa_runbook.md)

**Status:** Documentation template — fill after execution. **Does not** approve production v4.

---

## 1. Deployment baseline

| Item | Value |
|------|--------|
| Target image | `thnhit/technhvoice:voice-bridge-v1.19.0` |
| Running image (before QA) | |
| Running image (during canary) | |
| Running image (after rollback) | |
| Rollback image (if used) | |

```text
# Paste output (no secrets):
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
```

---

## 2. Precondition gate

| Check | Pass / Fail | Notes |
|-------|-------------|--------|
| A.1 Written approval | | |
| A.2 Image v1.19.0 | | |
| A.3 Migration 009 `voice.call_quality_events` | | |
| A.4 `OPENAI_API_KEY` set (yes/no only) | | |
| A.5 RAG `http://127.0.0.1:8080/healthz` | | |
| A.6 v3 baseline call (pre-canary) | | |
| A.7 `.env` backup path | | |

Migration 009 check:

```text
(paste to_regclass result)
```

---

## 3. Env flags (names and safe values only — no secrets)

### 3.1 Before canary (baseline)

```text
VOICE_RUNTIME_VERSION=
VOICE_V4_REALTIME_ENABLED=
VOICE_V4_CANARY_ENABLED=
VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=
VOICE_V4_LIVE_CANARY_ALLOWLIST=
VOICE_V4_BARGE_IN_ENABLED=
VOICE_V4_TTS_PROVIDER=
VOICE_RAG_ENABLED=
VOICE_RAG_SALES_ANSWERER_ENABLED=
```

### 3.2 During canary (QA window)

```text
VOICE_RUNTIME_VERSION=
VOICE_V4_REALTIME_ENABLED=
VOICE_V4_CANARY_ENABLED=
VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=
VOICE_V4_LIVE_CANARY_ALLOWLIST=
VOICE_V4_BARGE_IN_ENABLED=
VOICE_V4_TTS_PROVIDER=
VOICE_RAG_ENABLED=
VOICE_RAG_SALES_ANSWERER_ENABLED=
```

### 3.3 After rollback

```text
VOICE_RUNTIME_VERSION=
VOICE_V4_LIVE_AUDIOSOCKET_ENABLED=
VOICE_V4_LIVE_CANARY_ALLOWLIST=
VOICE_V4_TTS_PROVIDER=
```

---

## 4. Allowlist procedure used

| Item | Value |
|------|--------|
| Procedure | `bridge:` maintenance window / other: _______________ |
| Other PSTN traffic during window? | yes / no |
| Allowlist blocker noted? | yes / no |

Notes:

```text
(free text — no phone numbers)
```

---

## 5. Scenario results

| ID | Scenario | Pass / Fail / N/A | Notes |
|----|----------|-------------------|--------|
| E1 | v3 baseline before canary | | |
| E2 | v4 route selected | | |
| E3 | Greeting heard | | |
| E4 | VAD speech start + endpoint | | |
| E5 | STT completed | | |
| E6 | Dialogue plan created | | |
| E7 | OpenAI TTS intelligible | | |
| E8 | Barge-in stops playback | | |
| E9 | Switch → Smart Website | | |
| E10 | Switch → AI Voice Assistant / voice_agent | | |
| E11 | Quality flush completed | | |
| E12 | SQL summary + session close | | |
| E13 | Privacy (logs + SQL) | | |
| E14 | v3 works after rollback | | |

---

## 6. Call identifiers (no phone numbers)

| Field | Value |
|-------|--------|
| `call_session_id` (canary) | |
| `bridge_call_id` (canary) | |
| `external_call_id` (canary) | |
| QA route label (internal name only) | |

---

## 7. Log excerpts (redacted)

Attach file: `/tmp/voice-bridge-10h-<STAMP>.log`

```text
(paste 15–40 lines: call_handler, [v4-live] milestones, quality_flush, call_end)
```

Required lines present?

| Pattern | Seen? |
|---------|--------|
| `call_handler selected=v4_canary` | |
| `vad_speech_started` | |
| `vad_endpoint_detected` | |
| `stt_completed` | |
| `dialogue_plan_created` | |
| `tts_completed` | |
| `playback_started` | |
| `barge_in_detected` | |
| `playback_cancelled` | |
| `quality_flush_completed` | |
| `call_end` | |

---

## 8. SQL evidence

`call_session_id`: _______________

### 8.1 Event counts

```text
(paste GROUP BY event_type output)
```

### 8.2 Summary row

```text
(paste live_call_quality_summary query)
```

### 8.3 Privacy scan (`\+?\d{8,}` in payload)

| Rows returned | Expected: 0 |
|---------------|---------------|
| | |

---

## 9. Stop criteria / incidents

| Triggered? | Which (H1–H10) | Action taken |
|------------|----------------|--------------|
| no / yes | | |

---

## 10. Rollback

| Item | Value |
|------|--------|
| Rollback completed | yes / no |
| `.env` restored from backup | yes / no |
| v3 verification call (E14) | pass / fail |
| Time rollback completed (UTC) | |

---

## 11. Final classification

Select **one**:

- [ ] **pass** — All critical scenarios E1–E14 pass; privacy OK; v3 restored
- [ ] **partial** — Canary mostly works; list failures: _______________
- [ ] **fail** — Critical path broken; v3 restored
- [ ] **unsafe** — Privacy/routing safety issue; immediate escalation

### Engineering follow-ups

```text
- 
```

### Production v4 recommendation

```text
Production v4 for all traffic: STILL BLOCKED / recommend re-review after: _______________
```

---

## 12. Sign-off

| Role | Name | Date |
|------|------|------|
| Sysadmin | | |
| Engineering observer | | |
| Approval (if required) | | |
