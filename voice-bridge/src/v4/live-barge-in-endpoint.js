/**
 * Phase 10F — live v4 barge-in / playback cancel on gated AudioSocket canary path.
 * Uses VOICE_V4_BARGE_IN_ENABLED (not Phase 0B/0C spike flags).
 */

import { pcmFrameRms } from "./pcm-rms.js";
import { V4_STATES, transitionState } from "./state-machine.js";
import {
  createBargeInDetectorFromConfig,
  observeInboundDuringPlayback,
  shouldCancelPlaybackForSpeech,
  markBargeInTriggered,
  resetBargeInDetector,
  getBargeInMetrics,
} from "./barge-in-detector.js";
import {
  requestPlaybackCancel,
  finalizePlayback,
  getPlaybackMetrics,
} from "./playback-controller.js";
import {
  captureInterruptedAssistantState,
  applyInterruptionToMemory,
  applyInterruptionToStateMachine,
} from "./interruption-context.js";
import { markInterrupted } from "./audio-session.js";
import { resetUtteranceBuffer, ensureInterruptUtteranceAfterBargeIn } from "./live-stt-endpoint.js";
import { beginInterruptFollowupWaitOnBargeIn } from "./interrupt-followup-wait.js";
import { isPhoneCaptureLocked } from "./phone-capture-policy.js";
import {
  buildBargeInDetectedEvent,
  buildPlaybackCancelRequestedEvent,
  buildPlaybackCancelledEvent,
  buildInterruptionContextCapturedEvent,
  buildRuntimeErrorEvent,
} from "./quality-events.js";

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

function safeBargeInPayload(detector) {
  const metrics = getBargeInMetrics(detector);
  return {
    rms_threshold: metrics.rms_threshold,
    speech_frames_required: metrics.speech_frames_required,
    min_playback_ms: metrics.min_playback_ms,
    consecutive_speech_frames: metrics.consecutive_speech_frames,
    speech_detected: metrics.speech_detected,
    barge_in_triggered: metrics.barge_in_triggered,
    playback_ms_at_trigger: metrics.playback_ms_at_trigger,
    last_rms: metrics.last_rms,
    trigger_count: metrics.trigger_count,
  };
}

function buildLiveBargeQualityEvent(
  config,
  ctx,
  runtime,
  builder,
  metricValue,
  payload = {},
) {
  return builder({
    config,
    agentConfigResult: runtime?.runtimeContext?.agentConfig ?? null,
    callSessionId:
      ctx?.callSessionId ?? runtime?.audioSession?.callSessionId ?? null,
    metricValue,
    payload: {
      bridge_call_id: ctx?.bridgeCallId ?? null,
      live_phase: runtime?.phase ?? "phase10f_live_barge_in",
      ...payload,
    },
  });
}

export function isLiveV4BargeInEnabled(config) {
  return Boolean(config?.v4?.bargeInEnabled);
}

export function createLivePlaybackCancelSession() {
  return {
    cancelled: false,
    cancelReason: null,
    cancelRequestedAt: null,
  };
}

export function isLivePlaybackInFlight(runtime) {
  if (!runtime) return false;
  if (runtime.playbackInFlight) return true;
  const status = String(runtime.playback?.status ?? "");
  return status === "playing" || status === "cancel_requested";
}

export function ensureLiveBargeInDetector(runtime, config) {
  if (!isLiveV4BargeInEnabled(config)) {
    runtime.bargeInDetector = null;
    return null;
  }
  if (!runtime.bargeInDetector) {
    runtime.bargeInDetector = createBargeInDetectorFromConfig(config);
  }
  return runtime.bargeInDetector;
}

function isPhoneCaptureContinuationState(runtime) {
  const memory = runtime?.orchestrator?.memory ?? runtime?.runtimeContext?.memory ?? {};
  if (isPhoneCaptureLocked(memory)) return true;
  const responseType =
    runtime?.lastAssistantPlanCandidate?.response_type ??
    runtime?.playback?.label ??
    null;
  return responseType === "request_phone_once" || responseType === "request_phone_once_retry";
}

/**
 * Cancel playback during phone capture without product interruption recovery.
 */
export function executeLivePhoneCapturePlaybackCancel(
  config,
  ctx,
  runtime,
  atMs = Date.now(),
  triggerPayload = null,
  playback = runtime?.playback,
) {
  const ts = Number(atMs) || Date.now();
  const cancelResult = requestPlaybackCancel(playback, "phone_capture_continuation", ts);
  runtime.playback = cancelResult.controller;

  if (runtime.livePlaybackSession) {
    runtime.livePlaybackSession.cancelled = true;
    runtime.livePlaybackSession.cancelReason = "phone_capture_continuation";
    runtime.livePlaybackSession.cancelRequestedAt = ts;
  }

  const cancelMetrics = getPlaybackMetrics(runtime.playback);
  const cancelLatencyMs = cancelMetrics.cancel_latency_ms ?? null;
  const framesBeforeCancel =
    runtime.livePlaybackSession?.framesSent ?? cancelMetrics.frames_sent ?? 0;

  console.log(
    `[v4-live] phone_capture_playback_cancel cancel_latency_ms=${cancelLatencyMs ?? "unknown"} frames_sent_before_cancel=${framesBeforeCancel} ${liveLogIds(ctx)}`,
  );

  runtime.pendingInterruptionRecovery = false;
  runtime.highPriorityInterruptionTurn = false;
  runtime.interruptionContext = null;
  runtime.bargeInCount = (runtime.bargeInCount ?? 0) + 1;
  runtime.bargeInHandledPlaybackId = playback?.playbackId ?? null;

  ensureListeningAfterBargeIn(runtime);
  if (runtime.runtimeContext?.memory) {
    runtime.runtimeContext.memory = {
      ...runtime.runtimeContext.memory,
      current_state: V4_STATES.COLLECTING_PHONE_NUMBER,
      callback_flow_state: "phone_number_pending",
      interruption_context: null,
      updated_at: Date.now(),
    };
    if (runtime.orchestrator) {
      runtime.orchestrator.memory = runtime.runtimeContext.memory;
    }
  }
  ensureInterruptUtteranceAfterBargeIn(runtime, ctx, triggerPayload);
  runtime.bargeInDetector = resetBargeInDetector(runtime.bargeInDetector);

  return {
    ok: true,
    observed: true,
    cancelled: true,
    cancelLatencyMs,
    framesSentBeforeCancel: framesBeforeCancel,
    reason: "phone_capture_continuation",
  };
}

/**
 * Observe inbound PCM during assistant playback; cancel when speech threshold met.
 */
export function observeLiveCanaryBargeIn(
  config,
  ctx,
  runtime,
  payload,
  atMs = Date.now(),
) {
  if (!isLiveV4BargeInEnabled(config)) {
    return {
      ok: true,
      observed: false,
      cancelled: false,
      reason: "barge_in_disabled",
    };
  }
  if (!isLivePlaybackInFlight(runtime)) {
    return {
      ok: true,
      observed: false,
      cancelled: false,
      reason: "playback_not_active",
    };
  }

  const playback = runtime.playback;
  if (!playback?.enabled) {
    return {
      ok: true,
      observed: false,
      cancelled: false,
      reason: "playback_missing",
    };
  }

  try {
    const detector = ensureLiveBargeInDetector(runtime, config);
    const rms = pcmFrameRms(payload);
    const nextDetector = observeInboundDuringPlayback(
      detector,
      payload,
      playback,
      atMs,
    );
    runtime.bargeInDetector = nextDetector;

    if (!shouldCancelPlaybackForSpeech(nextDetector, playback, atMs)) {
      return {
        ok: true,
        observed: true,
        cancelled: false,
        reason: "threshold_not_met",
      };
    }

    if (isPhoneCaptureContinuationState(runtime)) {
      return executeLivePhoneCapturePlaybackCancel(config, ctx, runtime, atMs, payload, playback);
    }

    if (runtime.bargeInHandledPlaybackId === playback.playbackId) {
      return {
        ok: true,
        observed: true,
        cancelled: true,
        reason: "already_cancelled",
      };
    }

    return executeLiveBargeInCancel(config, ctx, runtime, atMs, payload);
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 120);
    console.warn(
      `[v4-live] barge_in_error reason=${message} ${liveLogIds(ctx)}`,
    );
    bufferQualityEvent(
      runtime,
      buildLiveBargeQualityEvent(
        config,
        ctx,
        runtime,
        buildRuntimeErrorEvent,
        null,
        {
          error_class: "barge_in_failed",
          message,
          event_subtype: "barge_in_error",
        },
      ),
    );
    ensureListeningAfterBargeInError(runtime);
    return {
      ok: false,
      observed: false,
      cancelled: false,
      reason: "barge_in_error",
      error: message,
    };
  }
}

export function executeLiveBargeInCancel(
  config,
  ctx,
  runtime,
  atMs = Date.now(),
  triggerPayload = null,
) {
  const ts = Number(atMs) || Date.now();
  const playback = runtime.playback;
  const metricsBefore = getPlaybackMetrics(playback);
  const responseType =
    runtime.lastAssistantPlanCandidate?.response_type ??
    playback?.label ??
    null;

  runtime.bargeInDetector = markBargeInTriggered(
    runtime.bargeInDetector,
    playback,
    ts,
  );
  const cancelResult = requestPlaybackCancel(playback, "barge_in", ts);
  runtime.playback = cancelResult.controller;

  if (runtime.livePlaybackSession) {
    runtime.livePlaybackSession.cancelled = true;
    runtime.livePlaybackSession.cancelReason = "barge_in";
    runtime.livePlaybackSession.cancelRequestedAt = ts;
  }

  const cancelMetrics = getPlaybackMetrics(runtime.playback);
  const cancelLatencyMs = cancelMetrics.cancel_latency_ms ?? null;
  const framesBeforeCancel =
    runtime.livePlaybackSession?.framesSent ??
    cancelMetrics.frames_sent ??
    metricsBefore.frames_sent ??
    0;

  console.log(
    `[v4-live] barge_in_detected cancel_latency_ms=${cancelLatencyMs ?? "unknown"} frames_sent_before_cancel=${framesBeforeCancel} response_type=${responseType ?? "unknown"} ${liveLogIds(ctx)}`,
  );
  console.log(
    `[v4-live] playback_cancel_requested cancel_latency_ms=${cancelLatencyMs ?? "unknown"} frames_sent_before_cancel=${framesBeforeCancel} ${liveLogIds(ctx)}`,
  );

  bufferQualityEvent(
    runtime,
    buildLiveBargeQualityEvent(
      config,
      ctx,
      runtime,
      buildBargeInDetectedEvent,
      cancelLatencyMs,
      {
        response_type: responseType,
        frames_sent_before_cancel: framesBeforeCancel,
        ...safeBargeInPayload(runtime.bargeInDetector),
      },
    ),
  );
  bufferQualityEvent(
    runtime,
    buildLiveBargeQualityEvent(
      config,
      ctx,
      runtime,
      buildPlaybackCancelRequestedEvent,
      cancelLatencyMs,
      {
        response_type: responseType,
        frames_sent_before_cancel: framesBeforeCancel,
        bytes_sent: cancelMetrics.bytes_sent,
        stopped_by_barge_in: cancelMetrics.stopped_by_barge_in,
      },
    ),
  );

  const assistantPreview = runtime.orchestrator?.lastAssistantText ?? "";
  runtime.interruptionContext = captureInterruptedAssistantState({
    memory: runtime.runtimeContext?.memory,
    stateMachine: runtime.runtimeContext?.stateMachine,
    playback: runtime.playback,
    assistantText: assistantPreview,
    turnIndex: runtime.playback?.turnIndex,
  });

  runtime.runtimeContext.memory = applyInterruptionToMemory(
    runtime.runtimeContext.memory,
    runtime.interruptionContext,
  );
  runtime.runtimeContext.stateMachine = applyInterruptionToStateMachine(
    runtime.runtimeContext.stateMachine,
    "barge_in",
  );
  runtime.runtimeContext.memory = {
    ...runtime.runtimeContext.memory,
    current_state: runtime.runtimeContext.stateMachine.state,
    updated_at: Date.now(),
  };

  if (runtime.orchestrator) {
    runtime.orchestrator.memory = runtime.runtimeContext.memory;
    runtime.orchestrator.stateMachine = runtime.runtimeContext.stateMachine;
  }

  if (runtime.audioSession) {
    runtime.audioSession = markInterrupted(runtime.audioSession, ts);
  }

  runtime.pendingInterruptionRecovery = true;
  runtime.highPriorityInterruptionTurn = true;
  beginInterruptFollowupWaitOnBargeIn(runtime, config, ctx, ts);
  runtime.bargeInCount = (runtime.bargeInCount ?? 0) + 1;
  runtime.bargeInHandledPlaybackId = playback.playbackId;

  bufferQualityEvent(
    runtime,
    buildLiveBargeQualityEvent(
      config,
      ctx,
      runtime,
      buildInterruptionContextCapturedEvent,
      null,
      {
        response_type: responseType,
        interrupted_product_id:
          runtime.interruptionContext?.interrupted_product_id ?? null,
        interrupted_state:
          runtime.interruptionContext?.interrupted_state ?? null,
        frames_sent_before_cancel: framesBeforeCancel,
        recovery_pending: true,
      },
    ),
  );

  ensureInterruptUtteranceAfterBargeIn(runtime, ctx, triggerPayload);
  runtime.bargeInDetector = resetBargeInDetector(runtime.bargeInDetector);

  return {
    ok: true,
    observed: true,
    cancelled: true,
    cancelLatencyMs,
    framesSentBeforeCancel: framesBeforeCancel,
    interruptionContext: runtime.interruptionContext,
  };
}

export function finalizeLivePlaybackAfterStream(
  config,
  ctx,
  runtime,
  playbackController,
  streamOutcome = {},
) {
  const atMs = Date.now();
  const wasCancelled =
    Boolean(streamOutcome.cancelled) ||
    runtime.playback?.status === "cancel_requested" ||
    Boolean(runtime.livePlaybackSession?.cancelled);

  const finalized = finalizePlayback(
    playbackController,
    wasCancelled ? "cancelled" : "completed",
    atMs,
  );
  runtime.playback = finalized.controller;
  runtime.playbackInFlight = false;

  const metrics = getPlaybackMetrics(finalized.controller);
  if (wasCancelled) {
    console.log(
      `[v4-live] playback_cancelled cancel_latency_ms=${metrics.cancel_latency_ms ?? "unknown"} frames_sent_before_cancel=${metrics.frames_sent ?? 0} ${liveLogIds(ctx)}`,
    );
    bufferQualityEvent(
      runtime,
      buildLiveBargeQualityEvent(
        config,
        ctx,
        runtime,
        buildPlaybackCancelledEvent,
        metrics.cancel_latency_ms,
        {
          frames_sent_before_cancel: metrics.frames_sent,
          bytes_sent: metrics.bytes_sent,
          stopped_by_barge_in: metrics.stopped_by_barge_in,
        },
      ),
    );
    ensureListeningAfterBargeIn(runtime);
    return {
      ok: true,
      cancelled: true,
      metrics,
      framesSent: metrics.frames_sent,
      bytesSent: metrics.bytes_sent,
    };
  }

  return {
    ok: true,
    cancelled: false,
    metrics,
    framesSent: streamOutcome.frames ?? metrics.frames_sent,
    bytesSent: streamOutcome.bytes ?? metrics.bytes_sent,
  };
}

export function ensureListeningAfterBargeIn(runtime) {
  if (!runtime?.runtimeContext?.stateMachine) return;
  const sm = runtime.runtimeContext.stateMachine;
  const target =
    sm.state === V4_STATES.INTERRUPTED
      ? V4_STATES.LISTENING
      : sm.state === V4_STATES.SPEAKING
        ? V4_STATES.LISTENING
        : sm.state;
  if (target === V4_STATES.LISTENING && sm.state !== V4_STATES.LISTENING) {
    runtime.runtimeContext.stateMachine = transitionState(
      sm,
      V4_STATES.LISTENING,
      "barge_in_listen",
    );
  } else if (sm.state === V4_STATES.SPEAKING) {
    runtime.runtimeContext.stateMachine = transitionState(
      sm,
      V4_STATES.LISTENING,
      "barge_in_listen",
    );
  }
  runtime.runtimeContext.memory = {
    ...runtime.runtimeContext.memory,
    current_state: runtime.runtimeContext.stateMachine.state,
    updated_at: Date.now(),
  };
  if (runtime.orchestrator) {
    runtime.orchestrator.stateMachine = runtime.runtimeContext.stateMachine;
    runtime.orchestrator.memory = runtime.runtimeContext.memory;
  }
}

function ensureListeningAfterBargeInError(runtime) {
  if (!runtime?.runtimeContext) return;
  runtime.runtimeContext.stateMachine = transitionState(
    runtime.runtimeContext.stateMachine ?? { state: V4_STATES.LISTENING },
    V4_STATES.LISTENING,
    "barge_in_error_recovery",
  );
  runtime.runtimeContext.memory = {
    ...runtime.runtimeContext.memory,
    current_state: V4_STATES.LISTENING,
    updated_at: Date.now(),
  };
}
