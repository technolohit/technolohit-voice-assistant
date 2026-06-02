/**
 * Phase 10P/10Q — post-barge-in listen window before answering marker-only interruptions.
 */

import { normalizeText } from "./redaction.js";
import { V4_STATES, transitionState } from "./state-machine.js";
import {
  isInterruptionFollowUpPhrase,
  isDefiniteCallerGoodbye,
} from "./transcript-intent.js";
import {
  detectShortFollowUpCategory,
  hasSubstantiveFollowUpContent,
} from "./playbook-short-answer.js";
import { matchProductAlias } from "./agent-config.js";
import {
  splitInterruptMarkerAndContinuation,
  markerCharCount,
  continuationCharCount,
  isHardStopMarkerText,
  resolveSingleStopDetected,
} from "./interrupt-marker-split.js";
import {
  resetInterruptFollowupForNewBargeIn,
  finalizeInterruptFollowupAfterContinuation,
  clearStaleInterruptionRecovery,
} from "./interrupt-followup-cycle.js";
import {
  beginInterruptFollowupLatency,
  markInterruptFollowupLatency,
} from "./interrupt-followup-latency.js";
import {
  resolveInterruptSequenceId,
} from "./product-context-persistence.js";
import {
  buildInterruptFollowupStartedEvent,
  buildInterruptFollowupWaitingEvent,
  buildInterruptFollowupContinuationReceivedEvent,
  buildInterruptFollowupTimeoutEvent,
} from "./quality-events.js";

const MARKER_ONLY = /^(stopp|stop|halt|moment|warte)[.!?,]*$/i;

export function resolveInterruptFollowupWaitConfig(config) {
  const v4 = config?.v4 ?? {};
  const waitMs = Math.max(500, Number(v4.interruptFollowupWaitMs ?? 2200));
  const maxMs = Math.max(waitMs, Number(v4.interruptFollowupMaxMs ?? 3000));
  const minChars = Math.max(8, Number(v4.interruptMarkerOnlyMinChars ?? 12));
  return { waitMs, maxMs, minChars };
}

export function isInterruptMarkerOnly(transcript = "", { minChars = 12 } = {}) {
  const split = splitInterruptMarkerAndContinuation(transcript);
  if (split.marker_only) return true;

  const text = normalizeText(transcript);
  if (!text) return true;
  const lower = text.toLowerCase();

  if (hasSubstantiveFollowUpContent(text)) return false;
  if (detectShortFollowUpCategory(text)) return false;
  if (isDefiniteCallerGoodbye(text)) return false;

  if (MARKER_ONLY.test(lower.trim()) || isHardStopMarkerText(text)) return true;

  if (isInterruptionFollowUpPhrase(text)) {
    const stripped = lower
      .replace(/\b(stopp|stop|halt|moment|warte)\b/gi, "")
      .replace(
        /\b(kurze frage|noch eine frage|darf ich kurz fragen|ich habe eine frage|ich habe noch eine frage)\b/gi,
        "",
      )
      .replace(/[.,!?]/g, "")
      .trim();
    if (stripped.length < minChars) return true;
  }

  return text.length < minChars;
}

export function resolveEffectiveInterruptTranscript(
  markerTranscript = "",
  continuationTranscript = "",
) {
  const split = splitInterruptMarkerAndContinuation(
    continuationTranscript && !markerTranscript
      ? continuationTranscript
      : markerTranscript && continuationTranscript
        ? `${markerTranscript} ${continuationTranscript}`.trim()
        : markerTranscript || continuationTranscript,
  );
  if (split.continuation && !split.marker_only) return split.continuation;

  const marker = normalizeText(markerTranscript);
  const continuation = normalizeText(continuationTranscript);
  if (!continuation) return marker;
  if (!marker || isInterruptMarkerOnly(marker)) return continuation;
  if (isInterruptMarkerOnly(continuation)) return marker;
  return `${marker} ${continuation}`.trim();
}

function bufferQualityEvent(runtime, event) {
  if (!runtime || !event) return;
  if (!Array.isArray(runtime.qualityEventsBuffer))
    runtime.qualityEventsBuffer = [];
  runtime.qualityEventsBuffer.push(event);
}

function buildFollowupEventPayload(runtime, extra = {}) {
  const followup = runtime?.interruptFollowup ?? {};
  const latency = runtime?.interruptFollowupLatency ?? {};
  const interruptSequenceId = resolveInterruptSequenceId(runtime);
  return {
    bridge_call_id: runtime?.runtimeContext?.memory?.bridge_call_id ?? null,
    live_phase: "phase10s_interrupt_followup",
    interrupt_sequence_id: interruptSequenceId,
    single_stop_detected: Boolean(followup.singleStopDetected),
    marker_only: Boolean(followup.markerOnly ?? extra.marker_only),
    marker_chars: followup.markerChars ?? extra.marker_chars ?? null,
    continuation_chars: followup.continuationChars ?? extra.continuation_chars ?? null,
    waiting_for_interruption_followup: Boolean(runtime?.waitingForInterruptionFollowup),
    stop_detected_ms: followup.stopDetectedMs ?? latency.barge_in_detected_at ?? null,
    playback_cancelled_ms: followup.playbackCancelledMs ?? latency.playback_cancelled_at ?? null,
    wait_window_started_ms: followup.waitWindowStartedMs ?? null,
    continuation_speech_started_ms: latency.followup_speech_start_at ?? null,
    continuation_endpoint_ms: latency.followup_endpoint_at ?? null,
    effective_transcript_chars: extra.effective_transcript_chars ?? null,
    ...extra,
  };
}

function bufferFollowupQualityEvent(config, ctx, runtime, builder, extra = {}) {
  bufferQualityEvent(
    runtime,
    builder({
      config,
      agentConfigResult: runtime?.runtimeContext?.agentConfig ?? null,
      callSessionId: ctx?.callSessionId ?? null,
      payload: {
        bridge_call_id: ctx?.bridgeCallId ?? null,
        ...buildFollowupEventPayload(runtime, extra),
      },
    }),
  );
}

export function buildInterruptFollowupQualityPayload(runtime, extra = {}) {
  return buildFollowupEventPayload(runtime, extra);
}

export function beginInterruptFollowupWaitOnBargeIn(
  runtime,
  config,
  ctx,
  atMs = Date.now(),
) {
  if (!runtime) return;

  resetInterruptFollowupForNewBargeIn(runtime);

  runtime.waitingForInterruptionFollowup = true;
  runtime.interruptFollowup = {
    bargeInAt: atMs,
    stopDetectedMs: atMs,
    playbackCancelledMs: atMs,
    markerTranscript: null,
    waitUntilMs: null,
    waitWindowStartedMs: null,
    timedOut: false,
    timeoutResponseStarted: false,
    singleStopDetected: true,
    markerOnly: false,
    markerChars: 0,
    continuationChars: 0,
    interruptCycle: (runtime.interruptFollowupCycleCount ?? 0) + 1,
  };
  runtime.interruptFollowupCycleCount = runtime.interruptFollowup.interruptCycle;
  runtime.activeInterruptSequenceId = `interrupt-${runtime.interruptFollowup.interruptCycle}`;
  beginInterruptFollowupLatency(runtime, atMs);
  markInterruptFollowupLatency(runtime, "playback_cancelled", atMs);
  markInterruptFollowupLatency(runtime, "stop_detected", atMs);

  if (runtime.runtimeContext?.stateMachine) {
    runtime.runtimeContext.stateMachine = transitionState(
      runtime.runtimeContext.stateMachine,
      V4_STATES.WAITING_FOR_INTERRUPTION_FOLLOWUP,
      "barge_in_await_followup",
    );
    runtime.runtimeContext.memory = {
      ...runtime.runtimeContext.memory,
      current_state: V4_STATES.WAITING_FOR_INTERRUPTION_FOLLOWUP,
      updated_at: Date.now(),
    };
    if (runtime.orchestrator) {
      runtime.orchestrator.stateMachine = runtime.runtimeContext.stateMachine;
      runtime.orchestrator.memory = runtime.runtimeContext.memory;
    }
  }

  bufferFollowupQualityEvent(config, ctx, runtime, buildInterruptFollowupStartedEvent, {
    playback_cancelled_ms: atMs,
    stop_detected_ms: atMs,
    single_stop_detected: true,
    marker_only: false,
    interrupt_sequence_id: runtime.activeInterruptSequenceId,
  });
}

function clearWaitStateToListening(runtime) {
  runtime.waitingForInterruptionFollowup = false;
  if (
    runtime.runtimeContext?.stateMachine?.state ===
    V4_STATES.WAITING_FOR_INTERRUPTION_FOLLOWUP
  ) {
    runtime.runtimeContext.stateMachine = transitionState(
      runtime.runtimeContext.stateMachine,
      V4_STATES.LISTENING,
      "interrupt_followup_received",
    );
    runtime.runtimeContext.memory = {
      ...runtime.runtimeContext.memory,
      current_state: V4_STATES.LISTENING,
      updated_at: Date.now(),
    };
  }
}

function applyContinuationResult(
  config,
  ctx,
  runtime,
  effective,
  split,
  atMs,
) {
  const followup = runtime.interruptFollowup ?? {};
  followup.continuationChars = continuationCharCount(effective);
  runtime.interruptFollowup = followup;

  const parentSingleStop = Boolean(followup.singleStopDetected);

  bufferFollowupQualityEvent(
    config,
    ctx,
    runtime,
    buildInterruptFollowupContinuationReceivedEvent,
    {
      marker_chars: markerCharCount(split.marker),
      continuation_chars: effective.length,
      effective_transcript_chars: effective.length,
      marker_only: false,
      single_stop_detected: split.single_stop_detected,
      parent_single_stop_detected: parentSingleStop,
      interrupt_sequence_id: resolveInterruptSequenceId(runtime),
    },
  );

  markInterruptFollowupLatency(runtime, "followup_endpoint", atMs);
  markInterruptFollowupLatency(runtime, "continuation_endpoint", atMs);

  finalizeInterruptFollowupAfterContinuation(runtime);

  clearWaitStateToListening(runtime);

  const agentConfig = runtime?.runtimeContext?.agentConfig ?? null;
  const hasProduct = agentConfig && matchProductAlias(agentConfig, effective);

  return {
    defer: false,
    transcript: effective,
    substantive: true,
    product_detected: Boolean(hasProduct?.id),
    effective_transcript_chars: effective.length,
    single_stop_detected: split.single_stop_detected,
  };
}

/**
 * After STT on live path — defer dialogue if marker-only and wait for continuation.
 */
export function processInterruptFollowupAfterStt(
  config,
  ctx,
  runtime,
  transcript,
  atMs = Date.now(),
) {
  if (!runtime?.waitingForInterruptionFollowup) {
    return { defer: false, transcript };
  }

  const { waitMs, maxMs, minChars } =
    resolveInterruptFollowupWaitConfig(config);
  const followup = runtime.interruptFollowup ?? {};
  const split = splitInterruptMarkerAndContinuation(transcript);

  if (!followup.followupSpeechMarked && transcript) {
    markInterruptFollowupLatency(runtime, "followup_speech_start", atMs);
    markInterruptFollowupLatency(runtime, "continuation_speech_start", atMs);
    followup.followupSpeechMarked = true;
  }

  if (split.continuation && !split.marker_only) {
    const effective = split.continuation;
    return applyContinuationResult(config, ctx, runtime, effective, split, atMs);
  }

  const markerOnly =
    split.marker_only || isInterruptMarkerOnly(transcript, { minChars });

  if (markerOnly && !followup.markerTranscript) {
    followup.markerTranscript = split.marker ?? transcript;
    followup.waitUntilMs = atMs + waitMs;
    followup.waitWindowStartedMs = atMs;
    followup.singleStopDetected = resolveSingleStopDetected(transcript, split);
    followup.markerOnly = true;
    followup.markerChars = markerCharCount(followup.markerTranscript);
    followup.continuationChars = 0;
    runtime.interruptFollowup = followup;

    markInterruptFollowupLatency(runtime, "wait_window_started", atMs);

    console.log(
      `[v4-live] interrupt_followup_waiting wait_ms=${waitMs} single_stop_detected=${followup.singleStopDetected} transcript_chars=${transcript.length} bridge_call_id=${ctx?.bridgeCallId ?? "pending"}`,
    );

    bufferFollowupQualityEvent(
      config,
      ctx,
      runtime,
      buildInterruptFollowupWaitingEvent,
      {
        marker_only: true,
        single_stop_detected: followup.singleStopDetected,
        marker_chars: followup.markerChars,
        continuation_chars: 0,
        effective_transcript_chars: transcript.length,
        wait_window_started_ms: atMs,
        interrupt_sequence_id: resolveInterruptSequenceId(runtime),
      },
    );

    return {
      defer: true,
      reason: "marker_only_waiting",
      transcript,
      single_stop_detected: followup.singleStopDetected,
    };
  }

  if (markerOnly && followup.markerTranscript) {
    followup.singleStopDetected = resolveSingleStopDetected(transcript, split);
    followup.waitUntilMs = Math.min(
      atMs + maxMs,
      (followup.waitUntilMs ?? atMs) + waitMs,
    );
    runtime.interruptFollowup = followup;
    return {
      defer: true,
      reason: "marker_only_extend_wait",
      transcript,
      single_stop_detected: followup.singleStopDetected,
    };
  }

  const effective = resolveEffectiveInterruptTranscript(
    followup.markerTranscript ?? "",
    transcript,
  );
  return applyContinuationResult(
    config,
    ctx,
    runtime,
    effective,
    splitInterruptMarkerAndContinuation(effective),
    atMs,
  );
}

export function isInterruptFollowupWaitExpired(runtime, atMs = Date.now()) {
  const followup = runtime?.interruptFollowup;
  if (!runtime?.waitingForInterruptionFollowup || !followup?.waitUntilMs)
    return false;
  return atMs >= followup.waitUntilMs;
}

export function shouldRunInterruptFollowupTimeout(runtime) {
  if (!runtime?.waitingForInterruptionFollowup) return false;
  const followup = runtime.interruptFollowup;
  if (
    !followup?.markerTranscript ||
    followup.timedOut ||
    followup.timeoutResponseStarted
  )
    return false;
  if (runtime.utterance?.capturing) return false;
  if (runtime.playbackInFlight) return false;
  return isInterruptFollowupWaitExpired(runtime);
}

export function markInterruptFollowupTimeoutStarted(runtime, atMs = Date.now()) {
  if (!runtime?.interruptFollowup) return;
  runtime.interruptFollowup.timeoutResponseStarted = true;
  runtime.interruptFollowup.timedOut = true;
  markInterruptFollowupLatency(runtime, "followup_timeout", atMs);
}

export function bufferInterruptFollowupTimeoutEvent(config, ctx, runtime) {
  bufferFollowupQualityEvent(
    config,
    ctx,
    runtime,
    buildInterruptFollowupTimeoutEvent,
    {
      marker_only: true,
      single_stop_detected: Boolean(runtime?.interruptFollowup?.singleStopDetected),
      wait_window_started_ms: runtime?.interruptFollowup?.waitWindowStartedMs ?? null,
      interrupt_sequence_id: resolveInterruptSequenceId(runtime),
    },
  );
}

export function clearInterruptFollowupWait(runtime) {
  runtime.waitingForInterruptionFollowup = false;
  runtime.interruptFollowup = null;
}

export { clearStaleInterruptionRecovery, finalizeInterruptFollowupAfterContinuation };
