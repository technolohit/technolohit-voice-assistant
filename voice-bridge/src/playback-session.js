/**
 * Phase 0B spike: cancellable playback session for AudioSocket barge-in feasibility.
 * Active only when VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED=true.
 */

function pcmRms(buffer) {
  if (!buffer?.length) return 0;
  const samples = Math.floor(buffer.length / 2);
  if (!samples) return 0;

  let sumSquares = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / samples);
}

function spikeLogLabel(ctx, session) {
  const bridge = ctx?.bridgeCallId ?? "pending";
  const turn = session?.turnIndex ?? "unknown";
  const label = session?.label ?? "unknown";
  return `bridge_call_id=${bridge} turn_index=${turn} label=${label}`;
}

export function isPlaybackCancelSpikeEnabled(config) {
  return Boolean(config?.v4PlaybackCancelSpike?.enabled);
}

export function createPlaybackSession(config, ctx, { label, turnIndex }) {
  return {
    label: String(label ?? "playback"),
    turnIndex: Number.isFinite(Number(turnIndex)) ? Number(turnIndex) : null,
    startedAt: Date.now(),
    cancelRequestedAt: null,
    cancelCompletedAt: null,
    cancelled: false,
    cancelReason: null,
    cancelLatencyMs: null,
    framesSent: 0,
    bytesSent: 0,
    consecutiveSpeechFrames: 0,
    firstSpeechAt: null
  };
}

export function logPlaybackStarted(config, ctx, session) {
  if (!isPlaybackCancelSpikeEnabled(config)) return;
  console.log(
    `[v4-playback-spike] playback_started ${spikeLogLabel(ctx, session)} pcm_bytes=${session.pcmBytes ?? 0}`
  );
}

export function requestPlaybackCancel(config, ctx, session, reason) {
  if (!session || session.cancelled) return false;
  session.cancelRequestedAt = Date.now();
  session.cancelReason = String(reason ?? "unknown");
  session.cancelled = true;
  if (isPlaybackCancelSpikeEnabled(config)) {
    console.log(
      `[v4-playback-spike] playback_cancel_requested ${spikeLogLabel(ctx, session)} cancellation_reason=${session.cancelReason} frames_sent_before_cancel=${session.framesSent}`
    );
  }
  return true;
}

export function logPlaybackCancelled(config, ctx, session) {
  if (!isPlaybackCancelSpikeEnabled(config) || !session?.cancelled) return;
  const cancelLatencyMs =
    session.cancelLatencyMs ??
    (session.cancelRequestedAt && session.cancelCompletedAt
      ? Math.max(0, session.cancelCompletedAt - session.cancelRequestedAt)
      : null);
  console.log(
    `[v4-playback-spike] playback_cancelled ${spikeLogLabel(ctx, session)} cancellation_reason=${session.cancelReason ?? "unknown"} frames_sent_before_cancel=${session.framesSent} cancel_latency_ms=${cancelLatencyMs ?? "unknown"}`
  );
}

export function monitorInboundDuringPlayback(config, ctx, session, payload) {
  if (!isPlaybackCancelSpikeEnabled(config)) return;
  if (!session || session.cancelled || !payload?.length) return;

  const threshold = Math.max(
    100,
    Number(config.v4PlaybackCancelSpike?.speechRmsThreshold ?? 450)
  );
  const framesRequired = Math.max(
    1,
    Number(config.v4PlaybackCancelSpike?.speechFramesRequired ?? 3)
  );

  const rms = pcmRms(payload);
  if (rms >= threshold) {
    session.consecutiveSpeechFrames += 1;
    if (!session.firstSpeechAt) {
      session.firstSpeechAt = Date.now();
    }
  } else {
    session.consecutiveSpeechFrames = 0;
  }

  if (session.consecutiveSpeechFrames >= framesRequired) {
    requestPlaybackCancel(config, ctx, session, "inbound_speech_detected");
  }
}

export function attachActivePlaybackSession(ctx, session) {
  ctx.activePlaybackSession = session;
}

export function detachActivePlaybackSession(ctx) {
  ctx.activePlaybackSession = null;
}

export function getActivePlaybackSession(ctx) {
  return ctx?.activePlaybackSession ?? null;
}

export function finalizePlaybackSession(config, ctx, session) {
  if (!session) return;
  if (session.cancelled) {
    session.cancelCompletedAt = Date.now();
    if (session.cancelRequestedAt) {
      session.cancelLatencyMs = Math.max(0, session.cancelCompletedAt - session.cancelRequestedAt);
    }
    logPlaybackCancelled(config, ctx, session);
  }
}
