# v4 Phase 10L — Successful STT Buffer Metrics

Date: 2026-06-02
Status: **Implemented in repo; live PSTN evidence retry pending**

Reference:

- [voice_assistant_v4_phase10h_live_qa_report.md](./voice_assistant_v4_phase10h_live_qa_report.md)
- [voice_assistant_v4_phase10k_full_utterance_stt_buffer_fix_report.md](./voice_assistant_v4_phase10k_full_utterance_stt_buffer_fix_report.md)
- [voice_assistant_v4_phase10h_live_qa_runbook.md](./voice_assistant_v4_phase10h_live_qa_runbook.md)

## Summary

The v1.22.0 supervised canary retry was a functional pass / partial pass:

- OpenAI STT completed.
- Dialogue and TTS completed.
- Barge-in mechanics worked.
- Quality flush worked.
- No new stale active session was created.
- Privacy scan passed.

Remaining gap: successful STT quality events did not persist buffer-size diagnostics, so SQL could not prove:

- `pcm_bytes > 320`
- `wav_bytes = pcm_bytes + 44`
- `wav_bytes_minus_pcm_bytes = 44`

## Fix

Successful OpenAI STT results now propagate safe, non-sensitive diagnostics into live quality events:

- `utterance_frames`
- `frame_count`
- `pcm_bytes`
- `wav_bytes`
- `wav_bytes_minus_pcm_bytes`
- `sample_rate`
- `utterance_duration_ms`
- `stt_http_status`
- `stt_error_code = null`
- `model`
- `language`

No transcript text, phone number, raw audio, API key, or OpenAI body content is stored.

## Notes

There are currently multiple event sources named `stt_completed`:

- Live STT audio event: includes `pcm_bytes`.
- Dialogue/orchestrator event: may not include audio buffer metrics.

Therefore the runbook validates only `stt_completed` rows where `payload ? 'pcm_bytes'`.

## Verification

Local verification:

- `cd voice-bridge && npm test` -> `311/311 pass`
- `python -m pytest rag-api/tests` -> `6/6 pass`
- `node --check` on changed JS -> pass

## Next Sysadmin Retry

Next supervised evidence retry should use:

```text
thnhit/technhvoice:voice-bridge-v1.23.0
```

Required SQL proof:

```sql
SELECT
  payload->>'utterance_frames' AS utterance_frames,
  payload->>'pcm_bytes' AS pcm_bytes,
  payload->>'wav_bytes' AS wav_bytes,
  payload->>'wav_bytes_minus_pcm_bytes' AS wav_bytes_minus_pcm_bytes,
  payload->>'stt_http_status' AS stt_http_status
FROM voice.call_quality_events
WHERE call_session_id = '<CALL_SESSION_ID>'::uuid
  AND event_type = 'stt_completed'
  AND payload ? 'pcm_bytes';
```

Pass:

- at least one row exists
- `pcm_bytes > 320` for normal multi-frame utterances
- `wav_bytes = pcm_bytes + 44`
- `wav_bytes_minus_pcm_bytes = 44`
- `stt_http_status` is 2xx
- privacy scan returns zero rows

Production v4 remains **not globally enabled** until the full rollout blockers are closed.

