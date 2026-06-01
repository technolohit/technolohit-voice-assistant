/**
 * v4 interruption context — memory/state updates after barge-in (Phase 4 foundation).
 * Converts Phase 0C concepts into proper v4 modules; no spike flags required.
 */

import { normalizeText, redactPhoneLikeText } from "./redaction.js";
import { matchProductAlias } from "./agent-config.js";
import {
  attachInterruptionContext,
  clearInterruptionContext,
  setSelectedProduct,
  updateMemoryFromUserTurn
} from "./call-session-memory.js";
import { V4_STATES, transitionState } from "./state-machine.js";
import { getPlaybackMetrics } from "./playback-controller.js";

const STOP_SIGNAL =
  /\b(stopp|stop|abbrechen|neues thema|anderes produkt|falsch|nicht das|ich meine|ich meinte|ich wollte|meinte ich)\b/i;

export function createInterruptionContext(input = {}) {
  return {
    recorded_at: Date.now(),
    turn_index: input.turn_index ?? input.turnIndex ?? null,
    interrupted_product_id: input.interrupted_product_id ?? input.interruptedProductId ?? null,
    interrupted_state: input.interrupted_state ?? input.interruptedState ?? null,
    playback_id: input.playback_id ?? input.playbackId ?? null,
    playback_frames_sent: Number(input.playback_frames_sent ?? input.framesSent ?? 0),
    playback_bytes_sent: Number(input.playback_bytes_sent ?? input.bytesSent ?? 0),
    cancel_reason: normalizeText(input.cancel_reason ?? input.cancelReason ?? ""),
    cancel_latency_ms:
      input.cancel_latency_ms ?? input.cancelLatencyMs ?? null,
    assistant_text_preview: redactPhoneLikeText(
      normalizeText(input.assistant_text ?? input.assistantText ?? "")
    ).slice(0, 200),
    caller_utterance_after: null,
    detected_product_id: null,
    topic_switch_detected: false,
    recovery_action: null,
    pending_caller_turn: true
  };
}

export function captureInterruptedAssistantState({
  memory,
  stateMachine,
  playback,
  assistantText = "",
  turnIndex = null
} = {}) {
  const playbackMetrics = getPlaybackMetrics(playback);
  return createInterruptionContext({
    turnIndex: turnIndex ?? playbackMetrics.turn_index,
    interruptedProductId: memory?.selected_product_id ?? memory?.product_interest ?? null,
    interruptedState: stateMachine?.state ?? memory?.current_state ?? null,
    playbackId: playbackMetrics.playback_id,
    framesSent: playbackMetrics.frames_sent,
    bytesSent: playbackMetrics.bytes_sent,
    cancelReason: playbackMetrics.cancel_reason,
    cancelLatencyMs: playbackMetrics.cancel_latency_ms,
    assistantText
  });
}

export function captureCallerInterruptionTurn(context, callerText = "") {
  const sanitized = redactPhoneLikeText(normalizeText(callerText));
  return {
    ...context,
    caller_utterance_after: sanitized || null,
    pending_caller_turn: true
  };
}

export function detectInterruptionSignals(callerText = "") {
  const lower = normalizeText(callerText).toLowerCase();
  return {
    stopSignal: STOP_SIGNAL.test(lower),
    productQuestion:
      /\b(was ist|was sind|erklar|erklaer|erklaren|erzaehl|erzahlen|kurz erkl|mehr uber|mehr ueber|details zu|wie funktioniert)\b/i.test(
        lower
      )
  };
}

export function detectProductIdFromUtterance(agentConfig, callerText = "") {
  const product = matchProductAlias(agentConfig?.config ?? agentConfig, callerText);
  return product?.id ?? null;
}

export function detectTopicOrProductSwitch(agentConfig, callerText = "", interruptedProductId = null) {
  const signals = detectInterruptionSignals(callerText);
  const detectedProductId = detectProductIdFromUtterance(agentConfig, callerText);
  const topicSwitch =
    Boolean(detectedProductId) &&
    Boolean(interruptedProductId) &&
    detectedProductId !== interruptedProductId;

  let recoveryAction = "continue_same_topic";
  if (topicSwitch || (signals.stopSignal && detectedProductId)) {
    recoveryAction = "product_switch";
  } else if (signals.stopSignal) {
    recoveryAction = "topic_reset";
  } else if (signals.productQuestion) {
    recoveryAction = "product_question";
  }

  return {
    detectedProductId,
    topicSwitchDetected: topicSwitch,
    signals,
    recoveryAction
  };
}

export function applyInterruptionToMemory(memory, context) {
  return attachInterruptionContext(memory, {
    turn_index: context.turn_index,
    interrupted_product_id: context.interrupted_product_id,
    cancellation_reason: context.cancel_reason,
    assistant_text: context.assistant_text_preview
  });
}

export function applyInterruptionToStateMachine(stateMachine, reason = "barge_in") {
  if (!stateMachine) return stateMachine;
  if (stateMachine.state === V4_STATES.SPEAKING) {
    return transitionState(stateMachine, V4_STATES.INTERRUPTED, reason);
  }
  if (stateMachine.state !== V4_STATES.INTERRUPTED) {
    return transitionState(stateMachine, V4_STATES.INTERRUPTED, reason);
  }
  return stateMachine;
}

export function applyProductSwitchToMemory(memory, productId) {
  if (!productId) return memory;
  let next = setSelectedProduct(memory, productId);
  next = {
    ...next,
    customer_type: null,
    lead_ready: false,
    handoff_choice: null
  };
  return next;
}

export function resolveInterruptionRecovery({
  agentConfig,
  memory,
  stateMachine,
  context,
  callerText = ""
} = {}) {
  const withUtterance = captureCallerInterruptionTurn(context, callerText);
  const switchInfo = detectTopicOrProductSwitch(
    agentConfig,
    callerText,
    withUtterance.interrupted_product_id
  );

  let nextMemory = applyInterruptionToMemory(memory, withUtterance);
  let nextStateMachine = applyInterruptionToStateMachine(stateMachine, "barge_in");
  let recoveryAction = switchInfo.recoveryAction;

  if (switchInfo.recoveryAction === "product_switch" && switchInfo.detectedProductId) {
    nextMemory = applyProductSwitchToMemory(nextMemory, switchInfo.detectedProductId);
    nextMemory = updateMemoryFromUserTurn(nextMemory, callerText);
    nextStateMachine = transitionState(nextStateMachine, V4_STATES.THINKING, "interruption_product_switch");
    recoveryAction = "product_switch";
  } else if (switchInfo.recoveryAction === "topic_reset") {
    nextMemory = updateMemoryFromUserTurn(nextMemory, callerText);
    nextStateMachine = transitionState(nextStateMachine, V4_STATES.LISTENING, "interruption_topic_reset");
  } else {
    nextMemory = updateMemoryFromUserTurn(nextMemory, callerText);
    nextStateMachine = transitionState(nextStateMachine, V4_STATES.LISTENING, "interruption_continue");
    recoveryAction = "continue_same_topic";
  }

  const resolvedContext = {
    ...withUtterance,
    detected_product_id: switchInfo.detectedProductId,
    topic_switch_detected: switchInfo.topicSwitchDetected,
    recovery_action: recoveryAction,
    pending_caller_turn: false
  };

  return {
    memory: nextMemory,
    stateMachine: nextStateMachine,
    context: resolvedContext,
    switchInfo,
    recoveryAction
  };
}

export function clearInterruptionAfterRecovery(memory, stateMachine, targetState = V4_STATES.LISTENING) {
  const clearedMemory = clearInterruptionContext(memory);
  let nextMachine = stateMachine;
  if (stateMachine?.state === V4_STATES.INTERRUPTED && canRecoverTo(stateMachine, targetState)) {
    nextMachine = transitionState(stateMachine, targetState, "interruption_recovered");
  }
  return { memory: clearedMemory, stateMachine: nextMachine };
}

function canRecoverTo(stateMachine, targetState) {
  return stateMachine?.state === V4_STATES.INTERRUPTED || stateMachine?.state === targetState;
}

export function hasStaleProductAfterSwitch(memory, expectedProductId) {
  if (!expectedProductId) return false;
  return memory?.selected_product_id !== expectedProductId;
}
