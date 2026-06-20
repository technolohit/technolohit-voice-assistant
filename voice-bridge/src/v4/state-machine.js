/**
 * v4 deterministic dialogue state machine.
 */

import { normalizeText } from "./redaction.js";

export const V4_STATES = {
  IDLE: "idle",
  GREETING: "greeting",
  LISTENING: "listening",
  TRANSCRIBING: "transcribing",
  THINKING: "thinking",
  ANSWERING_PRODUCT_QUESTION: "answering_product_question",
  COLLECTING_SALES_CONTEXT: "collecting_sales_context",
  COLLECTING_CONTACT_PREFERENCE: "collecting_contact_preference",
  COLLECTING_PHONE_NUMBER: "collecting_phone_number",
  COLLECTING_CALLBACK_PERMISSION: "collecting_callback_permission",
  VALIDATING_CONTACT: "validating_contact",
  LEAD_READY: "lead_ready",
  SPEAKING: "speaking",
  INTERRUPTED: "interrupted",
  WAITING_FOR_INTERRUPTION_FOLLOWUP: "waiting_for_interruption_followup",
  CLOSING: "closing",
  COMPLETED: "completed",
  ERROR: "error"
};

const ALLOWED = {
  [V4_STATES.IDLE]: [V4_STATES.GREETING, V4_STATES.LISTENING, V4_STATES.ERROR, V4_STATES.COMPLETED],
  [V4_STATES.GREETING]: [V4_STATES.LISTENING, V4_STATES.SPEAKING, V4_STATES.ERROR],
  [V4_STATES.LISTENING]: [
    V4_STATES.TRANSCRIBING,
    V4_STATES.THINKING,
    V4_STATES.COMPLETED,
    V4_STATES.ERROR
  ],
  [V4_STATES.TRANSCRIBING]: [V4_STATES.THINKING, V4_STATES.LISTENING, V4_STATES.ERROR],
  [V4_STATES.THINKING]: [
    V4_STATES.ANSWERING_PRODUCT_QUESTION,
    V4_STATES.COLLECTING_SALES_CONTEXT,
    V4_STATES.COLLECTING_CONTACT_PREFERENCE,
    V4_STATES.COLLECTING_PHONE_NUMBER,
    V4_STATES.COLLECTING_CALLBACK_PERMISSION,
    V4_STATES.VALIDATING_CONTACT,
    V4_STATES.SPEAKING,
    V4_STATES.LISTENING,
    // Phase 10AK: closing intent may complete the call from any turn.
    V4_STATES.COMPLETED,
    V4_STATES.ERROR
  ],
  [V4_STATES.ANSWERING_PRODUCT_QUESTION]: [
    V4_STATES.SPEAKING,
    V4_STATES.LISTENING,
    V4_STATES.COLLECTING_SALES_CONTEXT,
    // Phase 10AK: closing phrase right after a product answer completes the call.
    V4_STATES.COMPLETED,
    V4_STATES.ERROR
  ],
  [V4_STATES.COLLECTING_SALES_CONTEXT]: [
    V4_STATES.LISTENING,
    V4_STATES.COLLECTING_CONTACT_PREFERENCE,
    V4_STATES.SPEAKING,
    V4_STATES.ERROR
  ],
  [V4_STATES.COLLECTING_CONTACT_PREFERENCE]: [
    V4_STATES.LISTENING,
    V4_STATES.COLLECTING_PHONE_NUMBER,
    V4_STATES.COLLECTING_CALLBACK_PERMISSION,
    V4_STATES.VALIDATING_CONTACT,
    V4_STATES.SPEAKING,
    V4_STATES.ERROR
  ],
  [V4_STATES.COLLECTING_PHONE_NUMBER]: [
    V4_STATES.LISTENING,
    V4_STATES.COLLECTING_CALLBACK_PERMISSION,
    V4_STATES.SPEAKING,
    V4_STATES.ERROR
  ],
  [V4_STATES.COLLECTING_CALLBACK_PERMISSION]: [
    V4_STATES.LISTENING,
    V4_STATES.VALIDATING_CONTACT,
    V4_STATES.SPEAKING,
    V4_STATES.ERROR
  ],
  [V4_STATES.VALIDATING_CONTACT]: [
    V4_STATES.LEAD_READY,
    V4_STATES.LISTENING,
    V4_STATES.COLLECTING_CALLBACK_PERMISSION,
    V4_STATES.ERROR
  ],
  [V4_STATES.LEAD_READY]: [V4_STATES.CLOSING, V4_STATES.COMPLETED, V4_STATES.SPEAKING, V4_STATES.ERROR],
  [V4_STATES.SPEAKING]: [
    V4_STATES.INTERRUPTED,
    V4_STATES.LISTENING,
    V4_STATES.CLOSING,
    V4_STATES.COMPLETED,
    V4_STATES.ERROR
  ],
  [V4_STATES.INTERRUPTED]: [
    V4_STATES.LISTENING,
    V4_STATES.THINKING,
    V4_STATES.WAITING_FOR_INTERRUPTION_FOLLOWUP,
    V4_STATES.ERROR
  ],
  [V4_STATES.WAITING_FOR_INTERRUPTION_FOLLOWUP]: [
    V4_STATES.LISTENING,
    V4_STATES.THINKING,
    V4_STATES.TRANSCRIBING,
    // Phase 10AK: closing intent overrides interrupt follow-up continuation.
    V4_STATES.COMPLETED,
    V4_STATES.ERROR
  ],
  [V4_STATES.CLOSING]: [V4_STATES.COMPLETED, V4_STATES.LISTENING, V4_STATES.ERROR],
  [V4_STATES.COMPLETED]: [],
  [V4_STATES.ERROR]: [V4_STATES.LISTENING, V4_STATES.COMPLETED]
};

export function createStateMachine(initialState = V4_STATES.IDLE) {
  return {
    state: initialState,
    history: []
  };
}

/** @deprecated */
export function createStateMachineStub(initialState = V4_STATES.IDLE) {
  return createStateMachine(initialState);
}

export function canTransition(fromState, toState) {
  if (fromState === toState) return true;
  return (ALLOWED[fromState] ?? []).includes(toState);
}

export function validateStateTransition(fromState, toState, context = {}) {
  if (!canTransition(fromState, toState)) {
    return { ok: false, reason: "transition_not_allowed", from: fromState, to: toState };
  }
  if (toState === V4_STATES.LEAD_READY) {
    const policy = context.leadPolicy ?? {};
    if (!policy.allowed) {
      return { ok: false, reason: policy.reason ?? "lead_ready_not_allowed", from: fromState, to: toState };
    }
  }
  if (toState === V4_STATES.ANSWERING_PRODUCT_QUESTION && context.createsLead === true) {
    return { ok: false, reason: "rag_product_qa_cannot_create_lead", from: fromState, to: toState };
  }
  return { ok: true, from: fromState, to: toState };
}

export function transitionState(machine, nextState, reason = "", context = {}) {
  const from = machine?.state ?? V4_STATES.IDLE;
  const validation = validateStateTransition(from, nextState, context);
  if (!validation.ok) {
    return {
      ...machine,
      state: V4_STATES.ERROR,
      lastError: validation.reason,
      history: [
        ...(machine?.history ?? []),
        { from, to: V4_STATES.ERROR, reason: validation.reason, requested: nextState, at: Date.now() }
      ]
    };
  }
  return {
    ...machine,
    state: nextState,
    lastError: null,
    history: [...(machine?.history ?? []), { from, to: nextState, reason, at: Date.now() }]
  };
}

export function nextStateForIntent(currentState, intentName = "") {
  const intent = normalizeText(intentName);
  if (intent.includes("product_question") || intent.includes("sales_product_explanation")) {
    return V4_STATES.ANSWERING_PRODUCT_QUESTION;
  }
  if (intent.includes("product_selection_")) return V4_STATES.COLLECTING_SALES_CONTEXT;
  if (intent.includes("sales_customer_type")) return V4_STATES.COLLECTING_SALES_CONTEXT;
  if (intent.includes("sales_handoff") || intent.includes("contact_preference")) {
    return V4_STATES.COLLECTING_CONTACT_PREFERENCE;
  }
  if (intent.includes("callback_permission") || intent.includes("phone")) {
    return V4_STATES.COLLECTING_CALLBACK_PERMISSION;
  }
  if (currentState === V4_STATES.INTERRUPTED) return V4_STATES.LISTENING;
  if (currentState === V4_STATES.GREETING) return V4_STATES.LISTENING;
  return V4_STATES.THINKING;
}

export function nextStateForMemory(memory = {}) {
  if (memory?.interruption_context) return V4_STATES.INTERRUPTED;
  if (memory?.lead_ready) return V4_STATES.LEAD_READY;
  if (memory?.contact_preference === "phone" && !memory?.callback_permission) {
    if (
      memory?.callback_flow_state === "phone_number_pending" ||
      memory?.current_state === V4_STATES.COLLECTING_PHONE_NUMBER
    ) {
      return V4_STATES.COLLECTING_PHONE_NUMBER;
    }
    return V4_STATES.COLLECTING_CALLBACK_PERMISSION;
  }
  if (memory?.selected_product_id && !memory?.customer_type) {
    return V4_STATES.COLLECTING_SALES_CONTEXT;
  }
  if (memory?.selected_product_id) return V4_STATES.COLLECTING_CONTACT_PREFERENCE;
  return V4_STATES.LISTENING;
}

export function stateToQualityEvent(state) {
  const map = {
    [V4_STATES.IDLE]: "call_started",
    [V4_STATES.GREETING]: "call_started",
    [V4_STATES.LISTENING]: "turn_started",
    [V4_STATES.TRANSCRIBING]: "stt_started",
    [V4_STATES.THINKING]: "turn_started",
    [V4_STATES.ANSWERING_PRODUCT_QUESTION]: "rag_retrieval_started",
    [V4_STATES.SPEAKING]: "tts_started",
    [V4_STATES.INTERRUPTED]: "barge_in_detected",
    [V4_STATES.LEAD_READY]: "lead_created",
    [V4_STATES.ERROR]: "runtime_error",
    [V4_STATES.COMPLETED]: "call_started"
  };
  return map[state] ?? "turn_started";
}
