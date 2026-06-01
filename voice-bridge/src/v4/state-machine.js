/**
 * v4 explicit state machine — Phase 1 placeholder only.
 * Full transitions belong to Phase 4.
 */

export const V4_STATES = {
  IDLE: "idle",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking",
  INTERRUPTED: "interrupted",
  COMPLETED: "completed"
};

export function createStateMachineStub(initialState = V4_STATES.IDLE) {
  return {
    state: initialState,
    phase: "phase1_stub",
    history: []
  };
}

export function transitionState(machine, nextState, reason = "") {
  const from = machine?.state ?? V4_STATES.IDLE;
  const next = {
    ...machine,
    state: nextState,
    history: [...(machine?.history ?? []), { from, to: nextState, reason, at: Date.now() }]
  };
  return next;
}

export function canTransition(fromState, toState) {
  if (fromState === toState) return true;
  const allowed = {
    [V4_STATES.IDLE]: [V4_STATES.LISTENING, V4_STATES.COMPLETED],
    [V4_STATES.LISTENING]: [V4_STATES.THINKING, V4_STATES.COMPLETED],
    [V4_STATES.THINKING]: [V4_STATES.SPEAKING, V4_STATES.LISTENING],
    [V4_STATES.SPEAKING]: [V4_STATES.INTERRUPTED, V4_STATES.LISTENING, V4_STATES.COMPLETED],
    [V4_STATES.INTERRUPTED]: [V4_STATES.LISTENING, V4_STATES.COMPLETED],
    [V4_STATES.COMPLETED]: []
  };
  return (allowed[fromState] ?? []).includes(toState);
}
