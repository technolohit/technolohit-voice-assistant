/**
 * Phase 10AU — Golden Conversation Contract: deterministic callback/contact
 * flow lifecycle for v4.
 *
 * Once a callback/contact flow starts it outranks product Q&A, RAG,
 * interruption recovery, and questionnaire until it is finalized, denied, or
 * the caller explicitly asks a new product question.
 */

import { normalizeText } from "./redaction.js";
import { validatePhoneForCallback } from "./lead-validator.js";

export const CALLBACK_FLOW_STATES = Object.freeze({
  NONE: "none",
  CONTACT_PREFERENCE_PENDING: "contact_preference_pending",
  PHONE_NUMBER_PENDING: "phone_number_pending",
  CALLBACK_PERMISSION_PENDING: "callback_permission_pending",
  CALLBACK_PERMISSION_GRANTED: "callback_permission_granted",
  CALLBACK_MANUAL_REVIEW: "callback_manual_review",
  CALLBACK_FINALIZED: "callback_finalized",
  CALLBACK_DENIED: "callback_denied",
  EMAIL_DIRECTED: "email_directed",
});

const KNOWN_STATES = new Set(Object.values(CALLBACK_FLOW_STATES));

/** Flow has started and not been denied — outranks product QA/RAG/questionnaire. */
const ACTIVE_STATES = new Set([
  CALLBACK_FLOW_STATES.CONTACT_PREFERENCE_PENDING,
  CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
  CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING,
  CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_GRANTED,
  CALLBACK_FLOW_STATES.CALLBACK_MANUAL_REVIEW,
  CALLBACK_FLOW_STATES.CALLBACK_FINALIZED,
  CALLBACK_FLOW_STATES.EMAIL_DIRECTED,
]);

/** Permission/contact decision already made — attention phrases get reassurance. */
const POST_DECISION_STATES = new Set([
  CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_GRANTED,
  CALLBACK_FLOW_STATES.CALLBACK_MANUAL_REVIEW,
  CALLBACK_FLOW_STATES.CALLBACK_FINALIZED,
  CALLBACK_FLOW_STATES.EMAIL_DIRECTED,
]);

/** Intents that continue the callback/contact flow inside the planner. */
export const CALLBACK_FLOW_CONTINUATION_INTENTS = new Set([
  "contact_phone",
  "contact_email",
  "phone_number_candidate",
  "phone_capture_refused",
  "phone_capture_failed",
  "callback_permission_granted",
  "callback_permission_denied",
  "callback_flow_attention",
]);

/**
 * Resolve the current callback flow stage from memory. Prefers the explicit
 * `callback_flow_state` field; falls back to legacy flags so memories written
 * by older builds still resolve deterministically.
 */
export function resolveCallbackFlowState(memory = {}) {
  const explicit = normalizeText(memory?.callback_flow_state ?? "").toLowerCase();
  if (explicit && KNOWN_STATES.has(explicit)) return explicit;

  const permission = normalizeText(memory?.callback_permission ?? "").toLowerCase();
  const preference = normalizeText(memory?.contact_preference ?? "").toLowerCase();
  if (permission === "granted") {
    return preference === "email"
      ? CALLBACK_FLOW_STATES.EMAIL_DIRECTED
      : CALLBACK_FLOW_STATES.CALLBACK_FINALIZED;
  }
  if (permission === "denied") return CALLBACK_FLOW_STATES.CALLBACK_DENIED;
  if (preference === "email") return CALLBACK_FLOW_STATES.EMAIL_DIRECTED;
  if (preference === "phone" && memory?.phone_present !== true && !hasValidCallerPhone({ memory })) {
    if (
      memory?.callback_flow_state === CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING ||
      memory?.current_state === "collecting_phone_number"
    ) {
      return CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING;
    }
  }
  if (preference === "phone") return CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING;
  if (memory?.contact_flow_pending) return CALLBACK_FLOW_STATES.CONTACT_PREFERENCE_PENDING;
  if (memory?.current_state === "collecting_phone_number") {
    return CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING;
  }
  if (memory?.current_state === "collecting_callback_permission") {
    return CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING;
  }
  if (memory?.current_state === "collecting_contact_preference") {
    return CALLBACK_FLOW_STATES.CONTACT_PREFERENCE_PENDING;
  }
  return CALLBACK_FLOW_STATES.NONE;
}

export function isCallbackFlowActive(memory = {}) {
  return ACTIVE_STATES.has(resolveCallbackFlowState(memory));
}

export function isPostDecisionCallbackStage(memory = {}) {
  return POST_DECISION_STATES.has(resolveCallbackFlowState(memory));
}

export function isCallbackPermissionPendingStage(memory = {}) {
  return (
    resolveCallbackFlowState(memory) === CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING
  );
}

export function isPhoneNumberPendingStage(memory = {}) {
  return resolveCallbackFlowState(memory) === CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING;
}

// Attention/recovery phrases inside the callback flow ("Hallo?", "Sind Sie
// noch da?", bare "Ja."/"Okay." after the decision). Anchored and short so a
// real question can never match.
const ATTENTION_RECOVERY_PHRASE =
  /^(hallo( hallo)?|huhu|sind sie noch da|noch da|h[oö]ren sie mich( noch)?|k[oö]nnen sie mich h[oö]ren|ja( bitte| gerne)?|okay|ok|gut|alles klar|in ordnung|passt|super|danke ?sch[oö]n|dankesch[oö]n|vielen dank|danke)[\s.,!?]*$/i;

export function isCallbackFlowAttentionPhrase(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase().trim();
  if (!lower) return false;
  if (lower.length > 40) return false;
  return ATTENTION_RECOVERY_PHRASE.test(lower);
}

/**
 * Valid phone source for a callback confirmation — same validator the lead
 * pipeline uses (`validatePhoneForCallback`), never a separate rule.
 */
export function hasValidCallerPhone({
  callerPhoneNormalized = "",
  callerPhoneRaw = "",
  memory = {},
} = {}) {
  if (memory?.phone_present === true) return true;
  return validatePhoneForCallback({ callerPhoneNormalized, callerPhoneRaw }).ok;
}

/** Spoken confirmations per stage (reused by finalization and reassurance plans). */
export const CALLBACK_CONFIRMATION_TEXTS = Object.freeze({
  finalized:
    "Vielen Dank. Ich habe die Anfrage aufgenommen. Unser Team meldet sich telefonisch bei Ihnen.",
  manual_review:
    "Vielen Dank. Ich nehme die Anfrage zur manuellen Prüfung auf, damit unser Team sich darum kümmern kann.",
});

export function buildCallbackReassuranceText(memory = {}) {
  const stage = resolveCallbackFlowState(memory);
  if (stage === CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING) {
    return "Ja, ich bin noch da. Unter welcher Telefonnummer kann unser Team Sie am besten erreichen?";
  }
  if (stage === CALLBACK_FLOW_STATES.CALLBACK_MANUAL_REVIEW) {
    return "Ja, ich bin noch da. Ihre Anfrage ist zur manuellen Prüfung aufgenommen, unser Team kümmert sich darum.";
  }
  if (stage === CALLBACK_FLOW_STATES.EMAIL_DIRECTED) {
    return "Ja, ich bin noch da. Sie erreichen unser Team per E-Mail über www.technolohit.com.";
  }
  return "Ja, ich bin noch da. Ihre Anfrage ist aufgenommen, unser Team meldet sich telefonisch bei Ihnen.";
}

const CALLBACK_ABANDON_STAGE_BY_FLOW_STATE = Object.freeze({
  [CALLBACK_FLOW_STATES.CONTACT_PREFERENCE_PENDING]: "collecting_contact_preference",
  [CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING]: "callback_permission_pending",
  [CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING]: "phone_number_pending",
});

/**
 * Post-call skip reason must reflect callback-flow outcome, not generic
 * permission checks when phone capture already failed or manual review was chosen.
 */
export function resolvePostCallLeadSkipReason(memory = {}, callbackValidation = {}, phoneCheck = {}) {
  const flowState = resolveCallbackFlowState(memory);
  if (flowState === CALLBACK_FLOW_STATES.CALLBACK_MANUAL_REVIEW) {
    const explicit = normalizeText(memory?.lead_skipped_reason ?? "").toLowerCase();
    if (explicit) return explicit;
    if (!phoneCheck?.ok && memory?.phone_capture_attempted === true) {
      return "phone_capture_failed";
    }
    if (callbackValidation?.reason === "callback_permission_missing" && !phoneCheck?.ok) {
      return "callback_manual_review_no_phone";
    }
    return "callback_manual_review";
  }
  if (flowState === CALLBACK_FLOW_STATES.CALLBACK_DENIED) {
    return "callback_permission_denied";
  }
  return callbackValidation?.reason ?? "not_callback_ready";
}

/** Evidence when closing wins during an incomplete callback/contact flow. */
export function buildCallbackAbandonEvidence(memory = {}) {
  if (!isCallbackFlowActive(memory) || isPostDecisionCallbackStage(memory)) {
    return {};
  }
  const stage = resolveCallbackFlowState(memory);
  const abandonStage = CALLBACK_ABANDON_STAGE_BY_FLOW_STATE[stage];
  if (!abandonStage) return {};
  return {
    callback_flow_abandoned: true,
    callback_abandon_stage: abandonStage,
    lead_skipped_reason: "caller_closed_before_callback_completion",
  };
}

export function buildClosingDuringCallbackMemoryPatch(memory = {}) {
  const patch = {
    current_state: "completed",
    call_closing: true,
    interruption_context: null,
    lead_ready: false,
  };
  if (!isCallbackFlowActive(memory) || isPostDecisionCallbackStage(memory)) {
    return patch;
  }
  return {
    ...patch,
    contact_flow_pending: false,
    callback_flow_state: CALLBACK_FLOW_STATES.NONE,
  };
}
