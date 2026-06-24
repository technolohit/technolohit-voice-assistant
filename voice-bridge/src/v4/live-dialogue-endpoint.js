/**
 * Phase 10D — live v4 dialogue on STT transcript (plan in memory; TTS/playback in Phase 10E).
 */

import { createMediaAdaptersFromConfig } from "./audiosocket-runtime.js";
import { createQualityEventSink } from "./quality-event-sink.js";
import {
  createDialogueOrchestrator,
  startTurn,
  acceptUserTranscript,
  decideNextAction,
  prepareAssistantResponse,
  commitAssistantPlanWithoutPlayback,
  completeTurn
} from "./dialogue-orchestrator.js";
import { V4_STATES, transitionState } from "./state-machine.js";
import { redactPhoneLikeText } from "./redaction.js";
import { buildRuntimeErrorEvent } from "./quality-events.js";
import { resolveInterruptionRecovery } from "./interruption-context.js";
import { markLiveTurnLatency } from "./live-turn-latency.js";
import {
  finalizeInterruptFollowupLatencyMetrics,
  markInterruptFollowupLatency
} from "./interrupt-followup-latency.js";
import { buildInterruptFollowupLatencyMetricsEvent } from "./quality-events.js";
import { clearStaleInterruptionRecovery } from "./interrupt-followup-wait.js";

function liveLogIds(ctx) {
  return `bridge_call_id=${ctx?.bridgeCallId ?? "pending"} call_session_id=${ctx?.callSessionId ?? "pending"}`;
}

function safeTranscriptPreview(text, maxLen = 48) {
  const redacted = redactPhoneLikeText(text);
  if (!redacted) return "";
  if (redacted.length <= maxLen) return redacted;
  return `${redacted.slice(0, maxLen)}…`;
}

function bufferQualityEvent(runtime, event) {
  if (!runtime || !event) return;
  if (!Array.isArray(runtime.qualityEventsBuffer)) {
    runtime.qualityEventsBuffer = [];
  }
  runtime.qualityEventsBuffer.push(event);
}

function buildLiveDialogueQualityEvent(config, ctx, runtime, builder, metricValue, payload = {}) {
  return builder({
    config,
    agentConfigResult: runtime?.runtimeContext?.agentConfig ?? null,
    callSessionId: ctx?.callSessionId ?? runtime?.audioSession?.callSessionId ?? null,
    metricValue,
    payload: {
      bridge_call_id: ctx?.bridgeCallId ?? null,
      live_phase: runtime?.phase ?? "phase10d_live_dialogue",
      ...payload
    }
  });
}

function createLiveDialogueQualitySink(runtime) {
  const inner = createQualityEventSink({ v4PathActive: true, insertFn: null });
  return {
    v4PathActive: true,
    insertFn: null,
    bufferedCount: () => inner.bufferedCount(),
    bufferQualityEvent(event) {
      const result = inner.bufferQualityEvent(event);
      if (result?.ok) {
        bufferQualityEvent(runtime, event);
      }
      return result;
    },
    getBufferedQualityEvents: () => inner.getBufferedQualityEvents(),
    flushQualityEvents: (...args) => inner.flushQualityEvents(...args),
    discardQualityEvents: (...args) => inner.discardQualityEvents(...args),
    lastFlushFailures: () => inner.lastFlushFailures()
  };
}

function isClosingPlan(plan) {
  return (
    plan?.response_type === "closing" ||
    plan?.next_state === V4_STATES.COMPLETED ||
    Boolean(plan?.memory_patch?.call_closing)
  );
}

export function ensureLiveDialogueOrchestrator(config, ctx, runtime) {
  if (runtime?.orchestrator) {
    return runtime.orchestrator;
  }

  const runtimeContext = runtime?.runtimeContext;
  if (!runtimeContext?.agentConfig?.ok) {
    return null;
  }

  const orchestrator = createDialogueOrchestrator({
    config: runtime.config ?? config,
    runtimeContext,
    audioSession: runtime.audioSession,
    memory: runtimeContext.memory,
    stateMachine: runtimeContext.stateMachine,
    agentConfig: runtimeContext.agentConfig,
    adapters: createMediaAdaptersFromConfig(runtime.config ?? config),
    qualitySink: createLiveDialogueQualitySink(runtime),
    v4PathActive: true,
    callerPhoneNormalized: ctx?.callerPhoneNormalized ?? null,
    callerPhoneRaw: ctx?.callerPhoneRaw ?? null
  });

  const initialState = orchestrator.stateMachine?.state ?? orchestrator.memory?.current_state;
  if (initialState === V4_STATES.GREETING || initialState === V4_STATES.IDLE || !initialState) {
    orchestrator.stateMachine = transitionState(
      orchestrator.stateMachine,
      V4_STATES.LISTENING,
      "live_canary_ready"
    );
    orchestrator.memory = {
      ...orchestrator.memory,
      current_state: V4_STATES.LISTENING,
      updated_at: Date.now()
    };
  }

  runtime.orchestrator = orchestrator;
  runtime.runtimeContext.memory = orchestrator.memory;
  runtime.runtimeContext.stateMachine = orchestrator.stateMachine;
  return orchestrator;
}

/**
 * Run dialogue orchestrator once for a successful STT caller candidate (no TTS).
 */
export async function runLiveDialogueOnCallerTranscript(config, ctx, runtime, callerCandidate) {
  if (!callerCandidate?.ok) {
    return { ok: false, reason: "caller_candidate_invalid" };
  }
  if (callerCandidate.dialogueProcessed) {
    return { ok: false, reason: "dialogue_already_processed" };
  }

  // Phase 12H: keep raw STT for deterministic phone capture during callback flow.
  // Redaction happens in call-session memory, currentTurn snapshots, and quality
  // payloads — not before intent detection / spoken-phone-capture parsing.
  const transcript = String(callerCandidate.transcript ?? "").trim();
  if (!transcript) {
    return { ok: false, reason: "empty_transcript" };
  }

  const stateBefore =
    runtime?.runtimeContext?.stateMachine?.state ??
    runtime?.runtimeContext?.memory?.current_state ??
    V4_STATES.LISTENING;

  console.log(
    `[v4-live] dialogue_started state=${stateBefore} transcript_chars=${transcript.length} transcript_preview="${safeTranscriptPreview(transcript)}" ${liveLogIds(ctx)}`
  );

  try {
    const orchestrator = ensureLiveDialogueOrchestrator(config, ctx, runtime);
    if (!orchestrator) {
      throw new Error("dialogue_orchestrator_unavailable");
    }

    startTurn(orchestrator);
    acceptUserTranscript(orchestrator, transcript);

    let interruptionRecovery = null;
    if (runtime.pendingInterruptionRecovery && runtime.interruptionContext) {
      const recovery = resolveInterruptionRecovery({
        agentConfig: orchestrator.agentConfig,
        memory: orchestrator.memory,
        stateMachine: orchestrator.stateMachine,
        context: runtime.interruptionContext,
        callerText: transcript
      });
      orchestrator.memory = recovery.memory;
      orchestrator.stateMachine = recovery.stateMachine;
      runtime.runtimeContext.memory = recovery.memory;
      runtime.runtimeContext.stateMachine = recovery.stateMachine;
      runtime.interruptionContext = recovery.context;
      interruptionRecovery = recovery;
      runtime.pendingInterruptionRecovery = false;
      runtime.highPriorityInterruptionTurn = false;
    }

    const decideFn = runtime?.liveDialogueHooks?.decideNextAction ?? decideNextAction;
    orchestrator.activeInterruptSequenceId = runtime.activeInterruptSequenceId ?? null;
    const action = await decideFn(orchestrator, {
      transcript,
      interruptionRecovery,
      interruptFollowupTimeout: Boolean(callerCandidate.interruptFollowupTimeout),
      waitingForInterruptionFollowup: Boolean(runtime.waitingForInterruptionFollowup),
      interruptMarkerDetected: Boolean(runtime.interruptFollowup?.markerTranscript),
      interrupt_sequence_id: runtime.activeInterruptSequenceId ?? null,
    });
    const prepared = prepareAssistantResponse(orchestrator, action.plan);
    if (!prepared?.ok) {
      throw new Error(prepared?.reason ?? "prepare_failed");
    }

    const committed = commitAssistantPlanWithoutPlayback(orchestrator, prepared.text, action.plan);
    if (!isClosingPlan(action.plan)) {
      completeTurn(orchestrator);
    }

    runtime.runtimeContext.memory = orchestrator.memory;
    runtime.runtimeContext.stateMachine = orchestrator.stateMachine;
    if (orchestrator.audioSession) {
      runtime.audioSession = orchestrator.audioSession;
    }

    const responseChars = String(committed.text ?? "").length;
    runtime.lastAssistantPlanCandidate = {
      ok: true,
      response_type: action.plan?.response_type ?? null,
      intent: action.intent ?? null,
      next_state: orchestrator.stateMachine?.state ?? null,
      response_chars: responseChars,
      turn_index: orchestrator.turnIndex,
      endpoint_index: callerCandidate.endpointIndex ?? null,
      atMs: Date.now()
    };

    callerCandidate.dialogueProcessed = true;
    runtime.dialogueCompletedCount = (runtime.dialogueCompletedCount ?? 0) + 1;
    markLiveTurnLatency(runtime, "dialogue_plan");
    if (runtime.interruptFollowupLatency) {
      markInterruptFollowupLatency(runtime, "followup_dialogue_plan", Date.now());
    }

    const interruptMetrics = finalizeInterruptFollowupLatencyMetrics(runtime);
    if (interruptMetrics) {
      bufferQualityEvent(
        runtime,
        buildInterruptFollowupLatencyMetricsEvent({
          config,
          agentConfigResult: runtime?.runtimeContext?.agentConfig ?? null,
          callSessionId: ctx?.callSessionId ?? null,
          metricValue: interruptMetrics.followup_plan_to_first_playback_ms,
          payload: interruptMetrics
        })
      );
    }

    console.log(
      `[v4-live] dialogue_plan_created state=${orchestrator.stateMachine?.state ?? "unknown"} intent=${action.intent ?? "unknown"} plan_type=${action.plan?.response_type ?? "unknown"} response_chars=${responseChars} ${liveLogIds(ctx)}`
    );

    if (interruptionRecovery) {
      clearStaleInterruptionRecovery(runtime);
    }
    runtime.activeInterruptSequenceId = null;
    runtime.parentSingleStopDetected = null;

    return {
      ok: true,
      plan: action.plan,
      intent: action.intent,
      memory: orchestrator.memory,
      stateMachine: orchestrator.stateMachine,
      candidate: runtime.lastAssistantPlanCandidate
    };
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 120);
    console.warn(
      `[v4-live] dialogue_failed state=${stateBefore} reason=${message} ${liveLogIds(ctx)}`
    );

    callerCandidate.dialogueProcessed = true;
    runtime.lastAssistantPlanCandidate = {
      ok: false,
      reason: "dialogue_failed",
      error: message,
      atMs: Date.now()
    };

    bufferQualityEvent(
      runtime,
      buildLiveDialogueQualityEvent(config, ctx, runtime, buildRuntimeErrorEvent, null, {
        error_class: "dialogue_failed",
        message,
        event_subtype: "dialogue_error"
      })
    );

    return { ok: false, reason: "dialogue_failed", error: message };
  }
}
