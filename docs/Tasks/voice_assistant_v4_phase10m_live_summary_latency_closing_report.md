# v4 Phase 10M — Live Summary Persistence, Latency Metrics, Goodbye Handling

Date: 2026-06-02
Scope: **Code + tests + docs only** — no deploy, no production env edits.

Reference: v1.23.0 supervised evidence retry (STT buffer PASS/PARTIAL); [phase10l report](./voice_assistant_v4_phase10l_stt_success_buffer_metrics_report.md).

---

## Root cause: missing `live_call_quality_summary` in SQL

**Symptom:** Logs showed `quality_flush_completed inserted_count=46` and `audio_session_closed` in SQL, but:

```sql
SELECT * FROM voice.call_quality_events
WHERE call_session_id = '<id>' AND event_type = 'live_call_quality_summary';
```

returned **0 rows**.

**Cause:** `validateQualityEventInput` scanned the full JSON payload for phone-like digit runs (`\b\d{8,}\b`). The summary payload includes `bridge_call_id` (UUID). UUID substrings such as `36481679` falsely failed validation. The flush loop **silently skipped** invalid events (`continue` without insert). `audio_session_closed` could still appear from earlier buffered events or flush paths with smaller payloads.

**Fix (10M):**

- Exempt correlation IDs from digit scan: `bridge_call_id`, `call_session_id`, `external_call_id`, `audiosocket_uuid`.
- Log `quality_flush_skip_event` when validation fails.
- Direct capstone retry insert if summary/close still fail after batch flush.

**Inserted `event_type`:** exactly `live_call_quality_summary` (unchanged).

---

## Latency metrics (10M)

Per-turn safe metrics in `turn_latency_metrics` events and `live_call_quality_summary.payload.turn_latency`:

| Field | Meaning |
|-------|---------|
| `endpoint_to_stt_completed_ms` | VAD endpoint → STT done |
| `stt_completed_to_dialogue_plan_ms` | STT → dialogue plan |
| `dialogue_plan_to_tts_started_ms` | Plan → TTS start |
| `tts_started_to_first_chunk_ms` | TTS start → first audio chunk |
| `tts_completed_to_playback_started_ms` | First chunk → playback start (proxy) |
| `endpoint_to_first_playback_ms` | Endpoint → first playback frame |
| `total_turn_response_ms` | Endpoint → playback complete (or start if incomplete) |

Null when a stage did not run (e.g. STT failure before dialogue).

---

## Goodbye handling (10M)

Definite German closings (`Auf Wiederhören`, `Tschüss`, `Nein danke`, `Das war alles`, `Bis dann`, …) now receive:

> Vielen Dank für Ihren Anruf. Auf Wiederhören.

instead of the open-ended closing question. No banned Rückruf wording.

---

## Production behavior

**Unchanged** for default v3.

---

## Tests

- `voice-bridge`: **317/317** pass
- `rag-api/tests`: **6/6** pass

---

## Recommended tag

**`voice-bridge-v1.24.0`** after merge (commit locally; no deploy from this task).

---

## Sysadmin SQL after next short canary

### Summary row (required)

```sql
SELECT
  created_at,
  event_type,
  payload->>'close_reason' AS close_reason,
  payload->'live_counters'->>'stt_completed_count' AS stt_completed_count,
  payload->'turn_latency'->>'endpoint_to_first_playback_ms' AS endpoint_to_first_playback_ms,
  payload->'turn_latency'->>'total_turn_response_ms' AS total_turn_response_ms
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'live_call_quality_summary';
```

**Pass:** ≥ 1 row.

### Session close

```sql
SELECT event_type, created_at
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type IN ('audio_session_closed', 'live_call_quality_summary')
ORDER BY created_at;
```

### Turn latency detail

```sql
SELECT
  created_at,
  metric_value AS total_turn_response_ms,
  payload->>'endpoint_to_stt_completed_ms' AS endpoint_to_stt_completed_ms,
  payload->>'stt_completed_to_dialogue_plan_ms' AS stt_completed_to_dialogue_plan_ms,
  payload->>'dialogue_plan_to_tts_started_ms' AS dialogue_plan_to_tts_started_ms,
  payload->>'endpoint_to_first_playback_ms' AS endpoint_to_first_playback_ms
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'turn_latency_metrics'
ORDER BY created_at DESC
LIMIT 5;
```
