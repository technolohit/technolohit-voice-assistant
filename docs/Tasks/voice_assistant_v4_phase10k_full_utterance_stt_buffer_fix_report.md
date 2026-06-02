# v4 Phase 10K — Full Utterance STT Buffer Fix

Date: 2026-06-02
Status: **Implemented in repo; live PSTN retry pending**

Reference:

- [voice_assistant_v4_phase10h_live_qa_report.md](./voice_assistant_v4_phase10h_live_qa_report.md)
- [voice_assistant_v4_phase10j_stt_failure_and_session_hardening_report.md](./voice_assistant_v4_phase10j_stt_failure_and_session_hardening_report.md)
- [voice_assistant_v4_phase10h_live_qa_runbook.md](./voice_assistant_v4_phase10h_live_qa_runbook.md)

## Summary

The v1.21.0 supervised canary retry improved safety but failed live STT:

- STT preflight passed.
- VAD detected complete utterances.
- Fallback prompts played instead of long silence.
- No new stale call session was created.
- Live OpenAI STT still returned HTTP 400 `invalid_value` with "Audio file might be corrupted or unsupported."

The decisive clue was a mismatch in quality payloads:

- `utterance_frames` showed many frames, for example 176.
- `pcm_bytes` was only 320.
- `wav_bytes` was only 364.
- `utterance_duration_ms` was only 20.

This means the STT adapter sent only one 20 ms AudioSocket frame to OpenAI instead of the full captured utterance.

## Root Cause

`voice-bridge/src/v4/stt-adapter.js` pushed the first OpenAI frame, then marked the stream as `ERROR` when no direct `fetchImpl` was injected.

The live path uses `endpointTranscribeFn`, which already closes over `globalThis.fetch` and the OpenAI API key. Therefore a direct `fetchImpl` is not required on the adapter itself.

Because the stream entered `ERROR` after the first frame:

- `runtime.utterance.frames` counted the full utterance.
- `sttAdapter` only retained the first frame.
- `completeSttTurnAsync()` sent a tiny one-frame WAV to OpenAI.

## Fix

`stt-adapter.js` now allows OpenAI buffering when `endpointTranscribeFn` is present, even if `fetchImpl` is not directly injected.

The adapter still fails closed when neither `endpointTranscribeFn` nor `fetchImpl` is available.

## Regression Test

Added a 10J/10K regression test:

- Creates an OpenAI STT adapter with `endpointTranscribeFn` and no direct `fetchImpl`.
- Appends three 20 ms PCM frames.
- Completes STT.
- Asserts the transcribe function receives all three frames:
  - `frameCount = 3`
  - `pcmBytes = 960`

## Verification

Local verification:

- `cd voice-bridge && npm test` -> `309/309 pass`
- `python -m pytest rag-api/tests` -> `6/6 pass`
- `node --check` on changed JS -> pass

Production default behavior remains unchanged:

- `VOICE_RUNTIME_VERSION=v3`
- v4 live canary remains gated.
- Production v4 is still not enabled.

## Next Sysadmin Retry

Next supervised canary attempt must use image:

```text
thnhit/technhvoice:voice-bridge-v1.22.0
```

Required live evidence after retry:

- `stt_started stt_provider=openai`
- `stt_completed stt_provider=openai` for at least one normal utterance
- quality payload `pcm_bytes` must be much larger than 320 for multi-frame utterances
- `wav_bytes` must be `pcm_bytes + 44`
- semantic understanding must handle "Digitale Rezeption"
- if STT still fails, payload must show full utterance size, not one-frame size

## Acceptance Status

Phase 10H remains **not accepted** until supervised live PSTN QA passes.

Production v4 remains **blocked**.

