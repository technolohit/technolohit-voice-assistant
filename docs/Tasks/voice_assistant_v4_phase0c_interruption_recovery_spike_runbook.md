# Phase 0C — Interruption Recovery Spike Manual QA Runbook

Date: 2026-06-01  
Related: [voice_assistant_v4_phase0_decision_report.md](./voice_assistant_v4_phase0_decision_report.md) §3C

## Purpose

Validate that after **playback cancellation** (Phase 0B), the assistant **repairs dialogue context** on the next caller turn — especially when the caller switches product or topic.

## Prerequisites

- Phase 0B repeatability QA already passed on this host
- QA phone route available
- `VOICE_ASSISTANT_ENABLED=true`
- Deploy image includes Phase 0C code (post Phase 0C commit)

## Enable spikes (QA host only)

Add to `/opt/technolohit-voice/voice-bridge/.env`:

```env
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=true
VOICE_V4_PLAYBACK_CANCEL_SPIKE_RMS_THRESHOLD=450
VOICE_V4_PLAYBACK_CANCEL_SPIKE_SPEECH_FRAMES=3
VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED=true
```

Restart voice-bridge:

```bash
cd /opt/technolohit-voice/asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
docker exec technolohit-voice-bridge sh -lc 'printenv | sort | egrep "^VOICE_V4_(PLAYBACK_CANCEL|INTERRUPTION_CONTEXT)_SPIKE_"'
```

## Log monitoring

```bash
docker logs -f technolohit-voice-bridge 2>&1 | egrep -i "v4-playback-spike|v4-interruption-spike|interruption_product_switch|cancelled sending"
```

Expected on interrupt + product switch:

```text
[v4-playback-spike] playback_cancelled ...
[v4-interruption-spike] interruption_recorded ...
[v4-interruption-spike] interruption_product_switch ...
```

## Test scenarios

### 1. Digitale Rezeption → Smart Website

1. Ask about Voice Assistant / Digitale Rezeption; let assistant speak.
2. Interrupt clearly while assistant is explaining.
3. Ask: `Erzählen Sie mir bitte über Smart Website` or `Was ist Smart Website?`
4. **Pass:** Assistant answers Smart Website context; does not continue Digitale Rezeption pitch.

### 2. Smart Website → AI Voice Assistant

1. Start Smart Website explanation; interrupt.
2. Ask: `Und was ist der AI Voice Assistant?`
3. **Pass:** Assistant switches to voice-agent context.

### 3. Stopp repair phrase

1. During any long product explanation, interrupt.
2. Say: `Stopp, ich meine Smart Website`
3. **Pass:** Assistant pivots to Smart Website; no forced old-product flow.

## Classify result

| Result | Meaning |
|--------|---------|
| **pass** | All three scenarios correct; logs show interruption_recorded + product_switch when applicable |
| **partial** | Playback stops but wrong product/context on 1 scenario |
| **fail** | Assistant continues previous topic after clear product switch |
| **unsafe** | Call drop, garbled audio, crash |

## Disable immediately after QA

```env
VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=false
VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED=false
```

```bash
cd /opt/technolohit-voice/asterisk
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## Notes

- This is **not** full v4 barge-in acceptance — only interruption recovery after cancel.
- Phase 1 tenant/schema work must **not** start until team reviews Phase 0C live QA results.
- Do not enable spikes on production main DID without approval.
