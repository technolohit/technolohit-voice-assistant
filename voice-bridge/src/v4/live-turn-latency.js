/**
 * Phase 10M — per-turn response latency markers for v4 live canary (metrics only).
 */

function deltaMs(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return Math.max(0, Math.round(toMs - fromMs));
}

export function beginLiveTurnLatency(runtime, endpointIndex = null) {
  if (!runtime) return null;
  const now = Date.now();
  runtime.currentTurnLatency = {
    endpoint_index: endpointIndex,
    endpoint_detected_at: now,
    stt_completed_at: null,
    dialogue_plan_at: null,
    tts_started_at: null,
    tts_first_chunk_at: null,
    playback_started_at: null,
    playback_completed_at: null
  };
  return runtime.currentTurnLatency;
}

export function markLiveTurnLatency(runtime, field, atMs = Date.now()) {
  if (!runtime?.currentTurnLatency) return;
  const key = `${field}_at`;
  if (Object.prototype.hasOwnProperty.call(runtime.currentTurnLatency, key)) {
    runtime.currentTurnLatency[key] = Number(atMs) || Date.now();
  }
}

export function finalizeLiveTurnLatencyMetrics(runtime) {
  const t = runtime?.currentTurnLatency;
  if (!t?.endpoint_detected_at) return null;

  const endpointAt = t.endpoint_detected_at;
  const sttAt = t.stt_completed_at;
  const dialogueAt = t.dialogue_plan_at;
  const ttsStartAt = t.tts_started_at;
  const firstChunkAt = t.tts_first_chunk_at;
  const playbackStartAt = t.playback_started_at;
  const playbackDoneAt = t.playback_completed_at;

  const metrics = {
    endpoint_index: t.endpoint_index ?? null,
    endpoint_to_stt_completed_ms: deltaMs(endpointAt, sttAt),
    stt_completed_to_dialogue_plan_ms: deltaMs(sttAt, dialogueAt),
    dialogue_plan_to_tts_started_ms: deltaMs(dialogueAt, ttsStartAt),
    tts_started_to_first_chunk_ms: deltaMs(ttsStartAt, firstChunkAt),
    tts_completed_to_playback_started_ms: deltaMs(firstChunkAt, playbackStartAt),
    endpoint_to_first_playback_ms: deltaMs(endpointAt, playbackStartAt),
    total_turn_response_ms: deltaMs(endpointAt, playbackDoneAt ?? playbackStartAt)
  };

  if (!Array.isArray(runtime.turnLatencyHistory)) {
    runtime.turnLatencyHistory = [];
  }
  runtime.turnLatencyHistory.push(metrics);
  runtime.lastTurnLatencyMetrics = metrics;
  runtime.currentTurnLatency = null;

  return metrics;
}

export function pickLatestTurnLatencyForSummary(runtime) {
  return runtime?.lastTurnLatencyMetrics ?? runtime?.turnLatencyHistory?.at(-1) ?? null;
}
