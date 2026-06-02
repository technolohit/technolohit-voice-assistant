/**
 * Phase 10P/10Q — interruption / follow-up latency metrics (no PII).
 */

function deltaMs(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return Math.max(0, Math.round(toMs - fromMs));
}

export function beginInterruptFollowupLatency(
  runtime,
  bargeInAtMs = Date.now(),
) {
  if (!runtime) return null;
  runtime.interruptFollowupLatency = {
    barge_in_detected_at: Number(bargeInAtMs) || Date.now(),
    stop_detected_at: Number(bargeInAtMs) || Date.now(),
    playback_cancelled_at: null,
    wait_window_started_at: null,
    followup_speech_start_at: null,
    continuation_speech_start_at: null,
    followup_endpoint_at: null,
    continuation_endpoint_at: null,
    followup_stt_completed_at: null,
    followup_dialogue_plan_at: null,
    followup_playback_started_at: null,
    followup_timeout_at: null,
  };
  return runtime.interruptFollowupLatency;
}

export function markInterruptFollowupLatency(
  runtime,
  field,
  atMs = Date.now(),
) {
  if (!runtime?.interruptFollowupLatency) return;
  const key = `${field}_at`;
  if (
    Object.prototype.hasOwnProperty.call(runtime.interruptFollowupLatency, key)
  ) {
    runtime.interruptFollowupLatency[key] = Number(atMs) || Date.now();
  }
}

export function finalizeInterruptFollowupLatencyMetrics(runtime) {
  const t = runtime?.interruptFollowupLatency;
  if (!t?.barge_in_detected_at) return null;

  const stopAt = t.stop_detected_at ?? t.barge_in_detected_at;
  const cancelAt = t.playback_cancelled_at ?? stopAt;
  const waitAt = t.wait_window_started_at;
  const contSpeechAt = t.continuation_speech_start_at ?? t.followup_speech_start_at;

  const metrics = {
    stop_detected_ms: stopAt,
    playback_cancelled_ms: cancelAt,
    wait_window_started_ms: waitAt,
    continuation_speech_started_ms: contSpeechAt,
    continuation_endpoint_ms: t.continuation_endpoint_at ?? t.followup_endpoint_at,
    stop_to_cancel_ms: deltaMs(stopAt, cancelAt),
    stop_to_wait_window_ms: deltaMs(stopAt, waitAt),
    wait_window_to_continuation_ms: deltaMs(waitAt, contSpeechAt),
    barge_in_detected_to_playback_cancelled_ms: deltaMs(
      t.barge_in_detected_at,
      cancelAt,
    ),
    barge_in_detected_to_followup_speech_start_ms: deltaMs(
      t.barge_in_detected_at,
      t.followup_speech_start_at,
    ),
    followup_endpoint_to_stt_completed_ms: deltaMs(
      t.followup_endpoint_at,
      t.followup_stt_completed_at,
    ),
    followup_stt_completed_to_plan_ms: deltaMs(
      t.followup_stt_completed_at,
      t.followup_dialogue_plan_at,
    ),
    followup_plan_to_first_playback_ms: deltaMs(
      t.followup_dialogue_plan_at,
      t.followup_playback_started_at,
    ),
  };

  if (!Array.isArray(runtime.interruptFollowupLatencyHistory)) {
    runtime.interruptFollowupLatencyHistory = [];
  }
  runtime.interruptFollowupLatencyHistory.push(metrics);
  runtime.lastInterruptFollowupLatency = metrics;
  return metrics;
}
