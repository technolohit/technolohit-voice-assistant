# Phase 0B — Playback Cancel Spike Manual QA Runbook

Date: 2026-06-01  
Related: [voice_assistant_v4_phase0_decision_report.md](./voice_assistant_v4_phase0_decision_report.md)

## Purpose

Validate whether **bridge-side playback cancellation** plus **inbound speech detection during assistant TTS** can stop outbound AudioSocket frames quickly enough for v4 barge-in.

**Important:** Code-level cancellation stopping the frame loop is **necessary but not sufficient**. Asterisk/PSTN may buffer outbound audio. The caller must **audibly** stop hearing the assistant within the target window.

## Prerequisites

- QA phone route or internal extension (not production main DID unless explicitly approved)
- `VOICE_ASSISTANT_ENABLED=true` on a test voice-bridge instance
- OpenAI key configured for STT/TTS
- Ability to edit `/opt/technolohit-voice/voice-bridge/.env` on the test host
- A test call scenario that produces a **long assistant response** (product explanation, not a one-line clarification)

## Enable spike (test host only)

Add to `/opt/technolohit-voice/voice-bridge/.env`:

```env
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=true
VOICE_V4_PLAYBACK_CANCEL_SPIKE_RMS_THRESHOLD=450
VOICE_V4_PLAYBACK_CANCEL_SPIKE_SPEECH_FRAMES=3
```

Optional tuning for noisy lines:

```env
VOICE_V4_PLAYBACK_CANCEL_SPIKE_RMS_THRESHOLD=550
VOICE_V4_PLAYBACK_CANCEL_SPIKE_SPEECH_FRAMES=4
```

Restart voice-bridge only (no Asterisk change required):

```bash
cd /opt/technolohit-voice/asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

Verify flag (no secrets):

```bash
docker exec technolohit-voice-bridge sh -lc 'printenv | sort | egrep "^VOICE_V4_PLAYBACK_CANCEL_SPIKE_"'
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
```

Expected: `VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=true`

## Test call procedure

1. Start log tail in a separate terminal:

```bash
docker logs -f technolohit-voice-bridge 2>&1 | egrep -i "v4-playback-spike|cancelled sending|finished sending assistant|inbound audio"
```

2. Place test call to QA route.
3. Trigger a **long assistant TTS response** (e.g. ask for product explanation after initial greeting).
4. While assistant is speaking, **interrupt clearly** — speak over the assistant for at least 1 second.
5. Note subjectively:
   - Did assistant audio stop audibly?
   - How quickly (immediate / delayed / no stop)?
   - Did assistant continue talking over you?

6. End call normally.

## Log evidence to collect

Save log excerpt containing (if spike worked at bridge level):

```text
[v4-playback-spike] playback_started ...
[v4-playback-spike] playback_cancel_requested ... cancellation_reason=inbound_speech_detected
[v4-playback-spike] playback_cancelled ... frames_sent_before_cancel=... cancel_latency_ms=...
[voice-bridge] cancelled sending assistant response ...
```

Also capture:

```bash
docker logs --since=10m technolohit-voice-bridge 2>&1 | egrep -i "v4-playback-spike|cancelled sending|playback_cancel" > /tmp/v4-playback-spike-evidence.txt
```

Do not commit log files with phone numbers or transcript previews.

## Classify result

| Classification | Bridge logs | Caller hears |
|----------------|-------------|--------------|
| **immediate_stop** | `playback_cancelled` with `cancel_latency_ms` ≤ 400 | Assistant stops within ~0.5 s |
| **delayed_stop** | Cancel logged but audible stop 0.5–2 s | Usable with tuning? |
| **no_stop** | No cancel logs OR cancel logs but caller hears full TTS | Fail |
| **unsafe** | Socket errors, call drop, overlapping/garbled audio, crash | Fail — disable spike |

## Disable spike immediately

```env
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=false
```

```bash
cd /opt/technolohit-voice/asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
docker exec technolohit-voice-bridge sh -lc 'printenv VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED'
```

Expected: `false` or unset.

## Decision mapping

| Outcome | Media path recommendation |
|---------|---------------------------|
| **immediate_stop** on QA route | Continue Phase 0 validation; may proceed toward **AudioSocket path** if repeated on PSTN |
| **delayed_stop** only | Tune thresholds; re-test; do not accept Phase 0 yet |
| **no_stop** or **unsafe** | Move to **ARI/ExternalMedia / new realtime media bridge** (Option B in Phase 0 report) |

## Warnings

- Do not enable spike on production main DID without approval.
- Do not set `VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=true` in committed env files.
- Spike does **not** implement v4 dialogue recovery after cancel — it only tests media-path feasibility.
- Prior manual test (pre-spike) showed playback did **not** stop — that reflects v3 default behavior with flag off.
