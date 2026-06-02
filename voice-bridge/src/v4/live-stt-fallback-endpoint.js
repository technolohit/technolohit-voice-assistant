/**
 * Phase 10J — deterministic acoustic retry prompt when live STT fails (no dialogue/RAG/leads).
 */

import { runLiveTtsAndPlayback } from "./live-tts-playback-endpoint.js";
import { buildRuntimeErrorEvent } from "./quality-events.js";

export const LIVE_STT_FAILURE_FALLBACK_TEXT =
  "Entschuldigung, ich habe Sie akustisch nicht sicher verstanden. Können Sie das bitte kurz wiederholen?";

function liveLogIds(ctx) {
  return `bridge_call_id=${ctx?.bridgeCallId ?? "pending"} call_session_id=${ctx?.callSessionId ?? "pending"}`;
}

function bufferQualityEvent(runtime, event) {
  if (!runtime || !event) return;
  if (!Array.isArray(runtime.qualityEventsBuffer)) {
    runtime.qualityEventsBuffer = [];
  }
  runtime.qualityEventsBuffer.push(event);
}

function buildLiveSttFallbackQualityEvent(config, ctx, runtime, metricValue, payload = {}) {
  return buildRuntimeErrorEvent({
    config,
    agentConfigResult: runtime?.runtimeContext?.agentConfig ?? null,
    callSessionId: ctx?.callSessionId ?? runtime?.audioSession?.callSessionId ?? null,
    metricValue,
    payload: {
      bridge_call_id: ctx?.bridgeCallId ?? null,
      live_phase: runtime?.phase ?? "phase10j_live_stt_fallback",
      error_class: "stt_failed",
      event_subtype: "stt_failure_fallback",
      ...payload
    }
  });
}

/**
 * Play short retry prompt after STT failure. Does not run dialogue or mutate product/lead state.
 */
export async function runLiveSttFailureFallback(config, ctx, runtime, options = {}) {
  const socket = ctx?.v4LiveSocket ?? runtime?.liveSocket ?? null;
  if (!socket?.writable || ctx?.closed) {
    console.warn(
      `[v4-live] stt_fallback_skipped reason=socket_not_writable ${liveLogIds(ctx)} stt_reason=${options.sttReason ?? "unknown"}`
    );
    return { ok: false, reason: "socket_not_writable", fallbackPrompted: false };
  }

  const priorHooks = runtime?.liveTtsHooks ?? {};
  runtime.liveTtsHooks = {
    ...priorHooks,
    assistantText: LIVE_STT_FAILURE_FALLBACK_TEXT,
    sttFailureFallback: true
  };

  const endpointIndex = runtime?.endpointCount ?? 0;
  runtime.lastAssistantPlanCandidate = {
    ok: true,
    response_type: "stt_failure_fallback",
    turn_index: null,
    endpoint_index: endpointIndex,
    atMs: Date.now(),
    ttsPlaybackProcessed: false,
    sttFailureFallback: true
  };

  console.log(
    `[v4-live] stt_fallback_started stt_reason=${String(options.sttReason ?? "unknown").slice(0, 80)} ${liveLogIds(ctx)}`
  );

  let playback = { ok: false, reason: "not_run" };
  try {
    playback = await runLiveTtsAndPlayback(config, ctx, runtime, {
      ok: true,
      sttFailureFallback: true
    });
  } catch (err) {
    console.warn(
      `[v4-live] stt_fallback_playback_error error=${String(err?.message ?? err).slice(0, 120)} ${liveLogIds(ctx)}`
    );
    playback = { ok: false, reason: "stt_fallback_exception" };
  }

  const fallbackPrompted = Boolean(playback?.ok);
  bufferQualityEvent(
    runtime,
    buildLiveSttFallbackQualityEvent(config, ctx, runtime, options.sttMs ?? null, {
      stt_failed_fallback_prompted: fallbackPrompted,
      stt_reason: String(options.sttReason ?? "unknown").slice(0, 80),
      playback_ok: fallbackPrompted,
      playback_reason: playback?.reason ?? null,
      stt_provider: options.diagnostics?.stt_provider ?? runtime?.sttAdapter?.provider ?? null
    })
  );

  if (fallbackPrompted) {
    console.log(`[v4-live] stt_fallback_completed playback_ok=true ${liveLogIds(ctx)}`);
  } else {
    console.warn(
      `[v4-live] stt_fallback_failed playback_reason=${playback?.reason ?? "unknown"} ${liveLogIds(ctx)}`
    );
  }

  return {
    ok: fallbackPrompted,
    fallbackPrompted,
    playback,
    reason: playback?.reason ?? null
  };
}
