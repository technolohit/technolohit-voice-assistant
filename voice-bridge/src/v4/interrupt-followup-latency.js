/**
 * Phase 10P — interruption / follow-up latency metrics (no PII).
 */

function deltaMs(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return Math.max(0, Math.round(toMs - fromMs));
}

export function beginInterruptFollowupLatency(runtime, bargeInAtMs = Date.now()) {
  if (!runtime) return null;
  runtime.interruptFollowupLatency = {
    barge_in_detected_at: Number(bargeInAtMs) || Date.now(),
    playback_cancelled_at: null,
    followup_speech_start_at: null,
    followup_endpoint_at: null,
    followup_stt_completed_at: null,
    followup_dialogue_plan_at: null,
    followup_playback_started_at: null
  };
  return runtime.interruptFollowupLatency;
}

export function markInterruptFollowupLatency(runtime, field, atMs = Date.now()) {
  if (!runtime?.interruptFollowupLatency) return;
  const key = `${field}_at`;
  if (Object.prototype.hasOwnProperty.call(runtime.interruptFollowupLatency, key)) {
    runtime.interruptFollowupLatency[key] = Number(atMs) || Date.now();
  }
}

export function finalizeInterruptFollowupLatencyMetrics(runtime) {
  const t = runtime?.interruptFollowupLatency;
  if (!t?.barge_in_detected_at) return null;

  const metrics = {
    barge_in_detected_to_playback_cancelled_ms: deltaMs(
      t.barge_in_detected_at,
      t.playback_cancelled_at
    ),
    barge_in_detected_to_followup_speech_start_ms: deltaMs(
      t.barge_in_detected_at,
      t.followup_speech_start_at
    ),
    followup_endpoint_to_stt_completed_ms: deltaMs(t.followup_endpoint_at, t.followup_stt_completed_at),
    followup_stt_completed_to_plan_ms: deltaMs(t.followup_stt_completed_at, t.followup_dialogue_plan_at),
    followup_plan_to_first_playback_ms: deltaMs(t.followup_dialogue_plan_at, t.followup_playback_started_at)
  };

  if (!Array.isArray(runtime.interruptFollowupLatencyHistory)) {
    runtime.interruptFollowupLatencyHistory = [];
  }
  runtime.interruptFollowupLatencyHistory.push(metrics);
  runtime.lastInterruptFollowupLatency = metrics;
  return metrics;
}
