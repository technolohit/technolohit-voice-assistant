/**
 * Phase 10P — post-barge-in listen window before answering marker-only interruptions.
 */

import { normalizeText } from "./redaction.js";
import { V4_STATES, transitionState } from "./state-machine.js";
import {
  isInterruptionFollowUpPhrase,
  isDefiniteCallerGoodbye
} from "./transcript-intent.js";
import {
  detectShortFollowUpCategory,
  hasSubstantiveFollowUpContent
} from "./playbook-short-answer.js";
import { matchProductAlias } from "./agent-config.js";
import {
  beginInterruptFollowupLatency,
  markInterruptFollowupLatency
} from "./interrupt-followup-latency.js";
import { buildTurnStartedEvent } from "./quality-events.js";

const MARKER_ONLY =
  /^(stopp|stop|moment|warte)[.!?,]*$/i;

export function resolveInterruptFollowupWaitConfig(config) {
  const v4 = config?.v4 ?? {};
  const waitMs = Math.max(500, Number(v4.interruptFollowupWaitMs ?? 2200));
  const maxMs = Math.max(waitMs, Number(v4.interruptFollowupMaxMs ?? 3000));
  const minChars = Math.max(8, Number(v4.interruptMarkerOnlyMinChars ?? 12));
  return { waitMs, maxMs, minChars };
}

export function isInterruptMarkerOnly(transcript = "", { minChars = 12 } = {}) {
  const text = normalizeText(transcript);
  if (!text) return true;
  const lower = text.toLowerCase();

  if (hasSubstantiveFollowUpContent(text)) return false;
  if (detectShortFollowUpCategory(text)) return false;
  if (isDefiniteCallerGoodbye(text)) return false;

  if (MARKER_ONLY.test(lower.trim())) return true;

  if (isInterruptionFollowUpPhrase(text)) {
    const stripped = lower
      .replace(/\b(stopp|stop|moment|warte)\b/gi, "")
      .replace(/\b(kurze frage|noch eine frage|darf ich kurz fragen|ich habe eine frage|ich habe noch eine frage)\b/gi, "")
      .replace(/[.,!?]/g, "")
      .trim();
    if (stripped.length < minChars) return true;
  }

  return text.length < minChars;
}

export function resolveEffectiveInterruptTranscript(markerTranscript = "", continuationTranscript = "") {
  const marker = normalizeText(markerTranscript);
  const continuation = normalizeText(continuationTranscript);
  if (!continuation) return marker;
  if (!marker || isInterruptMarkerOnly(marker)) return continuation;
  if (isInterruptMarkerOnly(continuation)) return marker;
  return `${marker} ${continuation}`.trim();
}

export function beginInterruptFollowupWaitOnBargeIn(runtime, config, atMs = Date.now()) {
  if (!runtime) return;
  const { maxMs } = resolveInterruptFollowupWaitConfig(config);
  runtime.waitingForInterruptionFollowup = true;
  runtime.interruptFollowup = {
    bargeInAt: atMs,
    markerTranscript: null,
    waitUntilMs: null,
    timedOut: false,
    timeoutResponseStarted: false
  };
  beginInterruptFollowupLatency(runtime, atMs);
  markInterruptFollowupLatency(runtime, "playback_cancelled", atMs);

  if (runtime.runtimeContext?.stateMachine) {
    runtime.runtimeContext.stateMachine = transitionState(
      runtime.runtimeContext.stateMachine,
      V4_STATES.WAITING_FOR_INTERRUPTION_FOLLOWUP,
      "barge_in_await_followup"
    );
    runtime.runtimeContext.memory = {
      ...runtime.runtimeContext.memory,
      current_state: V4_STATES.WAITING_FOR_INTERRUPTION_FOLLOWUP,
      updated_at: Date.now()
    };
    if (runtime.orchestrator) {
      runtime.orchestrator.stateMachine = runtime.runtimeContext.stateMachine;
      runtime.orchestrator.memory = runtime.runtimeContext.memory;
    }
  }
}

function bufferQualityEvent(runtime, event) {
  if (!runtime || !event) return;
  if (!Array.isArray(runtime.qualityEventsBuffer)) runtime.qualityEventsBuffer = [];
  runtime.qualityEventsBuffer.push(event);
}

export function buildInterruptFollowupQualityPayload(runtime, extra = {}) {
  const mem = runtime?.runtimeContext?.memory ?? {};
  return {
    interrupt_marker_detected: Boolean(runtime?.interruptFollowup?.markerTranscript),
    waiting_for_interruption_followup: Boolean(runtime?.waitingForInterruptionFollowup),
    effective_transcript_chars: extra.effective_transcript_chars ?? null,
    ...extra
  };
}

/**
 * After STT on live path — defer dialogue if marker-only and wait for continuation.
 */
export function processInterruptFollowupAfterStt(config, ctx, runtime, transcript, atMs = Date.now()) {
  if (!runtime?.waitingForInterruptionFollowup) {
    return { defer: false, transcript };
  }

  const { waitMs, maxMs, minChars } = resolveInterruptFollowupWaitConfig(config);
  const followup = runtime.interruptFollowup ?? {};
  const agentConfig = runtime?.runtimeContext?.agentConfig ?? null;

  if (!followup.followupSpeechMarked && transcript) {
    markInterruptFollowupLatency(runtime, "followup_speech_start", atMs);
    followup.followupSpeechMarked = true;
  }

  const markerOnly = isInterruptMarkerOnly(transcript, { minChars });

  if (markerOnly && !followup.markerTranscript) {
    followup.markerTranscript = transcript;
    followup.waitUntilMs = atMs + waitMs;
    runtime.interruptFollowup = followup;

    console.log(
      `[v4-live] interrupt_followup_waiting wait_ms=${waitMs} transcript_chars=${transcript.length} bridge_call_id=${ctx?.bridgeCallId ?? "pending"}`
    );

    bufferQualityEvent(
      runtime,
      buildTurnStartedEvent({
        config,
        agentConfigResult: agentConfig,
        callSessionId: ctx?.callSessionId ?? null,
        payload: {
          bridge_call_id: ctx?.bridgeCallId ?? null,
          live_phase: "phase10p_interrupt_wait",
          ...buildInterruptFollowupQualityPayload(runtime, {
            effective_transcript_chars: transcript.length
          })
        }
      })
    );

    return { defer: true, reason: "marker_only_waiting", transcript };
  }

  if (markerOnly && followup.markerTranscript) {
    followup.waitUntilMs = Math.min(atMs + maxMs, (followup.waitUntilMs ?? atMs) + waitMs);
    runtime.interruptFollowup = followup;
    return { defer: true, reason: "marker_only_extend_wait", transcript };
  }

  const effective = resolveEffectiveInterruptTranscript(followup.markerTranscript ?? "", transcript);
  const hasProduct = agentConfig && matchProductAlias(agentConfig, effective);

  runtime.waitingForInterruptionFollowup = false;
  runtime.interruptFollowup = null;
  if (runtime.runtimeContext?.stateMachine?.state === V4_STATES.WAITING_FOR_INTERRUPTION_FOLLOWUP) {
    runtime.runtimeContext.stateMachine = transitionState(
      runtime.runtimeContext.stateMachine,
      V4_STATES.LISTENING,
      "interrupt_followup_received"
    );
    runtime.runtimeContext.memory = {
      ...runtime.runtimeContext.memory,
      current_state: V4_STATES.LISTENING,
      updated_at: Date.now()
    };
  }

  markInterruptFollowupLatency(runtime, "followup_endpoint", atMs);

  return {
    defer: false,
    transcript: effective,
    substantive: true,
    product_detected: Boolean(hasProduct?.id),
    effective_transcript_chars: effective.length
  };
}

export function isInterruptFollowupWaitExpired(runtime, atMs = Date.now()) {
  const followup = runtime?.interruptFollowup;
  if (!runtime?.waitingForInterruptionFollowup || !followup?.waitUntilMs) return false;
  return atMs >= followup.waitUntilMs;
}

export function shouldRunInterruptFollowupTimeout(runtime) {
  if (!runtime?.waitingForInterruptionFollowup) return false;
  const followup = runtime.interruptFollowup;
  if (!followup?.markerTranscript || followup.timedOut || followup.timeoutResponseStarted) return false;
  if (runtime.utterance?.capturing) return false;
  if (runtime.playbackInFlight) return false;
  return isInterruptFollowupWaitExpired(runtime);
}

export function markInterruptFollowupTimeoutStarted(runtime) {
  if (!runtime?.interruptFollowup) return;
  runtime.interruptFollowup.timeoutResponseStarted = true;
  runtime.interruptFollowup.timedOut = true;
}

export function clearInterruptFollowupWait(runtime) {
  runtime.waitingForInterruptionFollowup = false;
  runtime.interruptFollowup = null;
}
