/**
 * Phase 10R — reset / finalize interrupt-followup cycles for repeated nested barge-ins.
 */

import { clearInterruptionAfterRecovery } from "./interruption-context.js";
import { V4_STATES } from "./state-machine.js";
import { resolveInterruptSequenceId } from "./product-context-persistence.js";

/**
 * Clear pending follow-up wait state before starting a new barge-in cycle.
 */
export function resetInterruptFollowupForNewBargeIn(runtime) {
  if (!runtime) return;
  runtime.waitingForInterruptionFollowup = false;
  runtime.interruptFollowup = null;
}

/**
 * After continuation STT is consumed — drop wait flags; keep recovery until dialogue runs.
 */
export function finalizeInterruptFollowupAfterContinuation(runtime) {
  if (!runtime) return;
  const seqId = resolveInterruptSequenceId(runtime);
  if (seqId) runtime.activeInterruptSequenceId = seqId;
  if (runtime.interruptFollowup?.singleStopDetected) {
    runtime.parentSingleStopDetected = true;
  }
  runtime.waitingForInterruptionFollowup = false;
  runtime.interruptFollowup = null;
  runtime.interruptFollowupLatency = null;
}

/**
 * After dialogue/TTS on an interrupt turn — clear stale recovery context.
 */
export function clearStaleInterruptionRecovery(runtime) {
  if (!runtime) return;
  runtime.pendingInterruptionRecovery = false;
  runtime.highPriorityInterruptionTurn = false;
  runtime.interruptionContext = null;

  const ctx = runtime.runtimeContext;
  if (!ctx?.memory) return;

  const cleared = clearInterruptionAfterRecovery(
    ctx.memory,
    ctx.stateMachine,
    V4_STATES.LISTENING,
  );
  ctx.memory = cleared.memory;
  ctx.stateMachine = cleared.stateMachine;
  if (runtime.orchestrator) {
    runtime.orchestrator.memory = ctx.memory;
    runtime.orchestrator.stateMachine = ctx.stateMachine;
  }
}
