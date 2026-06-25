/**
 * Phase 10A — Agent Behavior Decision Layer (pure skeleton).
 *
 * Deterministic priority resolution for the Agent Behavior Layer. This module
 * is NOT wired into planner/RAG/questionnaire/callback runtime in Phase 10A.
 * No side effects, no DB/quality writes, no env-dependent activation.
 */

import { isClosingIntent } from "./closing-intent.js";
import {
  CALLBACK_FLOW_STATES,
  CALLBACK_FLOW_CONTINUATION_INTENTS,
  resolveCallbackFlowState,
  isCallbackFlowActive,
  hasValidCallerPhone,
} from "./callback-flow-policy.js";
import { validatePlaybook } from "./playbook-loader.js";

/** Conversation priority contract (v3 blueprint Phase 10). */
export const BEHAVIOR_PRIORITIES = Object.freeze({
  CLOSING: "closing",
  CALLBACK_FLOW: "callback_flow",
  ROLE_BOUNDARY: "role_boundary",
  EXPLICIT_PRODUCT_QUESTION: "explicit_product_question",
  PRODUCT_CONTEXT_CONTINUATION: "product_context_continuation",
  PRODUCT_QUALIFICATION: "product_qualification",
  QUESTIONNAIRE: "questionnaire",
  CONTACT_FORM_HANDOFF: "contact_form_handoff",
  COMPANY_GENERAL: "company_general",
  FALLBACK: "fallback",
});

/** Advisory lead tiers (deterministic validators still decide writes). */
export const LEAD_TIERS = Object.freeze({
  INFORMATION_REQUEST: "information_request",
  QUALIFIED_INTEREST: "qualified_interest",
  CALLBACK_REQUESTED: "callback_requested",
  MANUAL_REVIEW: "manual_review",
  LEAD_READY: "lead_ready",
});

/** Response types aligned with response-planner RESPONSE_TYPES string values. */
export const DECISION_RESPONSE_TYPES = Object.freeze({
  CLOSING: "closing",
  ROLE_BOUNDARY_REDIRECT: "role_boundary_redirect",
  TECHNICAL_ESCALATION: "technical_escalation",
  COLLECT_CONTACT_PREFERENCE: "collect_contact_preference",
  COLLECT_CALLBACK_PERMISSION: "collect_callback_permission",
  REQUEST_PHONE_ONCE: "request_phone_once",
  CALLBACK_FINALIZED: "callback_finalized",
  CALLBACK_MANUAL_REVIEW: "callback_manual_review",
  CALLBACK_REASSURANCE: "callback_reassurance",
  CALLBACK_PERMISSION_DENIED: "callback_permission_denied",
  EMAIL_GUIDANCE: "email_guidance",
  PRODUCT_QUESTION_ANSWER: "product_question_answer",
  COLLECT_SALES_CONTEXT: "collect_sales_context",
  CONTACT_FORM_HANDOFF: "contact_form_handoff",
  COMPANY_GENERAL: "company_general",
  FALLBACK_CLARIFICATION: "fallback_clarification",
});

const EXPLICIT_PRODUCT_INTENTS = new Set(["product_question", "product_selection"]);
const ROLE_BOUNDARY_INTENTS = new Set(["out_of_scope", "technical_escalation"]);
const CALLBACK_START_INTENTS = new Set(["callback_request"]);
const CONTACT_FLOW_INTENTS = new Set(["contact_phone", "contact_email"]);
const PRODUCT_CONTINUATION_INTENTS = new Set([
  "scoped_product_qa",
  "product_context_continuation",
]);
const QUALIFICATION_INTENTS = new Set([
  "explicit_sales_qualification",
  "collect_sales_context",
]);

const CONTACT_FORM_HANDOFF_INTENTS = new Set([
  "email_offer_by_voice",
  "website_url_offer_by_voice",
  "company_name_offer_by_voice",
  "contact_form_handoff_needed",
]);

const DENIED_CALLBACK_STATES = new Set([CALLBACK_FLOW_STATES.NONE, CALLBACK_FLOW_STATES.CALLBACK_DENIED]);

const SAFE_DECISION_FIELDS = [
  "priority",
  "response_type",
  "product_id",
  "playbook_version",
  "playbook_valid",
  "rag_allowed",
  "questionnaire_allowed",
  "lead_tier",
  "next_action",
  "reason",
  "suppressed_intents",
  "source",
];

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function resolvePlaybookMeta(playbook) {
  if (!playbook || typeof playbook !== "object") {
    return { version: null, valid: false, reason: "playbook_missing" };
  }
  const validation = validatePlaybook(playbook);
  if (!validation.ok) {
    return {
      version: hasNonEmptyString(playbook.playbook_version) ? playbook.playbook_version : null,
      valid: false,
      reason: "playbook_validation_failed",
    };
  }
  return {
    version: playbook.playbook_version ?? null,
    valid: true,
    reason: null,
  };
}

function resolveProductId(productContext = null, memory = {}) {
  if (hasNonEmptyString(productContext?.product_id)) return productContext.product_id;
  if (hasNonEmptyString(productContext?.id)) return productContext.id;
  if (hasNonEmptyString(memory?.selected_product_id)) return memory.selected_product_id;
  if (hasNonEmptyString(memory?.current_product_context)) return memory.current_product_context;
  return null;
}

function resolveClosing(closingIntent, transcript, memory, intent) {
  if (closingIntent === true || intent === "closing") return true;
  if (closingIntent === false) return false;
  if (memory?.call_closing === true) return true;
  return isClosingIntent(transcript ?? "");
}

function resolveCallbackState(callbackFlowState, memory) {
  if (hasNonEmptyString(callbackFlowState)) return callbackFlowState;
  return resolveCallbackFlowState(memory ?? {});
}

function isCallbackFlowBlocking(callbackState, memory, intent) {
  if (CALLBACK_START_INTENTS.has(intent) || CONTACT_FLOW_INTENTS.has(intent)) return true;
  if (CALLBACK_FLOW_CONTINUATION_INTENTS.has(intent)) return true;
  if (intent === "callback_flow_attention") return true;
  if (!DENIED_CALLBACK_STATES.has(callbackState)) return true;
  return isCallbackFlowActive(memory ?? {});
}

function mapCallbackResponseType(callbackState, intent, phoneContext = {}) {
  if (intent === "callback_flow_attention") return DECISION_RESPONSE_TYPES.CALLBACK_REASSURANCE;
  if (intent === "callback_permission_denied") {
    return DECISION_RESPONSE_TYPES.CALLBACK_PERMISSION_DENIED;
  }
  if (intent === "callback_permission_granted") {
    if (callbackState === CALLBACK_FLOW_STATES.CALLBACK_MANUAL_REVIEW) {
      return DECISION_RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW;
    }
    if (
      callbackState === CALLBACK_FLOW_STATES.CALLBACK_FINALIZED ||
      callbackState === CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_GRANTED
    ) {
      return DECISION_RESPONSE_TYPES.CALLBACK_FINALIZED;
    }
    return DECISION_RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION;
  }
  if (intent === "contact_phone") {
    if (!hasValidCallerPhone(phoneContext)) {
      return DECISION_RESPONSE_TYPES.REQUEST_PHONE_ONCE;
    }
    return DECISION_RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION;
  }
  if (intent === "phone_number_candidate") return DECISION_RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION;
  if (intent === "phone_capture_partial") return DECISION_RESPONSE_TYPES.REQUEST_PHONE_ONCE;
  if (intent === "phone_capture_refused" || intent === "phone_capture_failed") {
    return DECISION_RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW;
  }
  if (intent === "contact_email") return DECISION_RESPONSE_TYPES.EMAIL_GUIDANCE;
  if (intent === "callback_request") return DECISION_RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE;

  if (callbackState === CALLBACK_FLOW_STATES.CALLBACK_FINALIZED) {
    return DECISION_RESPONSE_TYPES.CALLBACK_FINALIZED;
  }
  if (callbackState === CALLBACK_FLOW_STATES.CALLBACK_MANUAL_REVIEW) {
    return DECISION_RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW;
  }
  if (callbackState === CALLBACK_FLOW_STATES.EMAIL_DIRECTED) {
    return DECISION_RESPONSE_TYPES.EMAIL_GUIDANCE;
  }
  if (callbackState === CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING) {
    return DECISION_RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION;
  }
  if (callbackState === CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING) {
    return DECISION_RESPONSE_TYPES.REQUEST_PHONE_ONCE;
  }
  return DECISION_RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE;
}

function mapCallbackLeadTier(callbackState, memory) {
  if (callbackState === CALLBACK_FLOW_STATES.CALLBACK_MANUAL_REVIEW) {
    return LEAD_TIERS.MANUAL_REVIEW;
  }
  if (
    callbackState === CALLBACK_FLOW_STATES.CALLBACK_FINALIZED ||
    callbackState === CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_GRANTED
  ) {
    return memory?.lead_ready ? LEAD_TIERS.LEAD_READY : LEAD_TIERS.CALLBACK_REQUESTED;
  }
  return LEAD_TIERS.CALLBACK_REQUESTED;
}

function mapCallbackNextAction(callbackState, intent) {
  if (intent === "callback_flow_attention") return "reassure_caller";
  if (
    callbackState === CALLBACK_FLOW_STATES.CALLBACK_FINALIZED ||
    callbackState === CALLBACK_FLOW_STATES.CALLBACK_MANUAL_REVIEW
  ) {
    return "post_call_notification";
  }
  return "continue_callback_flow";
}

function mapCallbackReason(callbackState, intent) {
  if (intent === "callback_flow_attention") return "callback_flow_attention";
  if (intent === "callback_permission_granted") {
    if (callbackState === CALLBACK_FLOW_STATES.CALLBACK_MANUAL_REVIEW) {
      return "callback_permission_granted_no_valid_phone";
    }
    return "callback_permission_granted";
  }
  if (intent === "callback_request") return "callback_request_intent";
  if (intent === "contact_phone") return "contact_phone_preference";
  if (intent === "phone_number_candidate") return "phone_number_captured";
  if (intent === "phone_capture_partial") return "phone_capture_partial_or_incomplete";
  if (intent === "phone_capture_refused") return "phone_capture_refused";
  if (intent === "phone_capture_failed") return "phone_capture_failed_after_retry";
  if (intent === "contact_email") return "contact_email_preference";
  return `active_callback_flow:${callbackState}`;
}

function isExplicitProductIntent(intent) {
  return EXPLICIT_PRODUCT_INTENTS.has(intent);
}

function isRoleBoundaryIntent(roleBoundaryIntent, intent) {
  if (hasNonEmptyString(roleBoundaryIntent)) return roleBoundaryIntent;
  if (ROLE_BOUNDARY_INTENTS.has(intent)) return intent;
  return null;
}

function isQuestionnaireEligible({
  questionnaireEligible,
  productAnswered,
  pricingAnswered,
  memory = {},
}) {
  if (questionnaireEligible === true) return true;
  if (productAnswered === true || pricingAnswered === true) return true;
  if (memory?.product_answered === true || memory?.pricing_answered === true) return true;
  return false;
}

function buildDecision(overrides = {}) {
  const decision = {
    priority: BEHAVIOR_PRIORITIES.FALLBACK,
    response_type: DECISION_RESPONSE_TYPES.FALLBACK_CLARIFICATION,
    product_id: null,
    playbook_version: null,
    playbook_valid: false,
    rag_allowed: false,
    questionnaire_allowed: false,
    lead_tier: LEAD_TIERS.INFORMATION_REQUEST,
    next_action: "clarify",
    reason: "fallback_unclear",
    suppressed_intents: [],
    source: "agent_behavior_decision",
    ...overrides,
  };
  return Object.freeze(decision);
}

function appendPlaybookNote(reason, playbookMeta) {
  if (playbookMeta.valid) return reason;
  const suffix = playbookMeta.reason ?? "playbook_invalid";
  return `${reason}:${suffix}`;
}

/**
 * Invalid/missing playbook: priority classification may proceed, but behavior
 * gates must fail closed — never enable RAG or questionnaire runtime paths.
 */
function enforcePlaybookGateFailClosed(decision, playbookMeta) {
  if (playbookMeta.valid) return decision;
  const suppressed = new Set(decision.suppressed_intents ?? []);
  suppressed.add("rag");
  suppressed.add("questionnaire");
  return buildDecision({
    ...decision,
    playbook_version: playbookMeta.version,
    playbook_valid: false,
    rag_allowed: false,
    questionnaire_allowed: false,
    suppressed_intents: [...suppressed],
  });
}

/**
 * Resolve a deterministic Agent Behavior Decision for the current turn.
 * Pure function — no I/O, no env reads, no quality/DB side effects.
 */
export function resolveAgentBehaviorDecision({
  transcript = "",
  memory = {},
  state = null,
  playbook = null,
  config = null,
  intent = "unclear",
  productContext = null,
  callbackFlowState = null,
  roleBoundaryIntent = null,
  closingIntent = null,
  productAnswered = false,
  pricingAnswered = false,
  questionnaireEligible = false,
  callerPhoneNormalized = null,
  callerPhoneRaw = null,
} = {}) {
  void state;
  void config;
  void transcript;

  const playbookMeta = resolvePlaybookMeta(playbook);
  const productId = resolveProductId(productContext, memory);
  const resolvedIntent = hasNonEmptyString(intent) ? intent : "unclear";
  const callbackState = resolveCallbackState(callbackFlowState, memory);
  const phoneContext = { callerPhoneNormalized, callerPhoneRaw, memory };
  const closing = resolveClosing(closingIntent, transcript, memory, resolvedIntent);
  const boundary = isRoleBoundaryIntent(roleBoundaryIntent, resolvedIntent);

  const withPlaybook = (decision) =>
    enforcePlaybookGateFailClosed(
      buildDecision({
        product_id: productId,
        playbook_version: playbookMeta.version,
        playbook_valid: playbookMeta.valid,
        ...decision,
      }),
      playbookMeta
    );

  // 1. Closing — always wins; RAG and questionnaire suppressed.
  if (closing) {
    return withPlaybook({
      priority: BEHAVIOR_PRIORITIES.CLOSING,
      response_type: DECISION_RESPONSE_TYPES.CLOSING,
      rag_allowed: false,
      questionnaire_allowed: false,
      lead_tier: LEAD_TIERS.INFORMATION_REQUEST,
      next_action: "close_call",
      reason: appendPlaybookNote("closing_intent", playbookMeta),
      suppressed_intents: [
        "rag",
        "questionnaire",
        "product_context_continuation",
        "callback_flow",
        "role_boundary",
      ],
    });
  }

  const callbackBlocking = isCallbackFlowBlocking(callbackState, memory, resolvedIntent);
  const explicitProduct = isExplicitProductIntent(resolvedIntent);

  // 4 (exception). Explicit new product question may resume product Q&A during callback flow.
  if (callbackBlocking && explicitProduct) {
    return withPlaybook({
      priority: BEHAVIOR_PRIORITIES.EXPLICIT_PRODUCT_QUESTION,
      response_type: DECISION_RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
      rag_allowed: true,
      questionnaire_allowed: false,
      lead_tier: LEAD_TIERS.QUALIFIED_INTEREST,
      next_action: "answer_product",
      reason: appendPlaybookNote("explicit_product_question_overrides_callback", playbookMeta),
      suppressed_intents: ["callback_flow", "product_context_continuation", "questionnaire"],
    });
  }

  // 2. Active callback/contact flow — outranks product continuation; RAG/questionnaire off.
  if (callbackBlocking) {
    return withPlaybook({
      priority: BEHAVIOR_PRIORITIES.CALLBACK_FLOW,
      response_type: mapCallbackResponseType(callbackState, resolvedIntent, phoneContext),
      rag_allowed: false,
      questionnaire_allowed: false,
      lead_tier: mapCallbackLeadTier(callbackState, memory),
      next_action: mapCallbackNextAction(callbackState, resolvedIntent),
      reason: appendPlaybookNote(mapCallbackReason(callbackState, resolvedIntent), playbookMeta),
      suppressed_intents: ["rag", "questionnaire", "product_context_continuation"],
    });
  }

  // 3. Safety / role boundary — before product Q&A.
  if (boundary === "out_of_scope") {
    return withPlaybook({
      priority: BEHAVIOR_PRIORITIES.ROLE_BOUNDARY,
      response_type: DECISION_RESPONSE_TYPES.ROLE_BOUNDARY_REDIRECT,
      rag_allowed: false,
      questionnaire_allowed: false,
      lead_tier: LEAD_TIERS.INFORMATION_REQUEST,
      next_action: "redirect",
      reason: appendPlaybookNote("out_of_scope_redirect", playbookMeta),
      suppressed_intents: ["rag", "questionnaire", "product_qa", "callback_flow"],
    });
  }
  if (boundary === "technical_escalation") {
    return withPlaybook({
      priority: BEHAVIOR_PRIORITIES.ROLE_BOUNDARY,
      response_type: DECISION_RESPONSE_TYPES.TECHNICAL_ESCALATION,
      rag_allowed: false,
      questionnaire_allowed: false,
      lead_tier: LEAD_TIERS.MANUAL_REVIEW,
      next_action: "escalate_to_team",
      reason: appendPlaybookNote("technical_escalation", playbookMeta),
      suppressed_intents: ["rag", "questionnaire", "product_qa"],
    });
  }

  // 3b. Voice-capture restrictions / contact-form handoff — before product Q&A.
  if (CONTACT_FORM_HANDOFF_INTENTS.has(resolvedIntent)) {
    return withPlaybook({
      priority: BEHAVIOR_PRIORITIES.CONTACT_FORM_HANDOFF,
      response_type: DECISION_RESPONSE_TYPES.CONTACT_FORM_HANDOFF,
      rag_allowed: false,
      questionnaire_allowed: false,
      lead_tier: LEAD_TIERS.INFORMATION_REQUEST,
      next_action: "redirect_to_contact_form",
      reason: appendPlaybookNote("voice_capture_restriction", playbookMeta),
      suppressed_intents: ["rag", "questionnaire", "callback_flow", "product_qa"],
    });
  }

  // 3c. Company-general positioning — before product Q&A.
  if (resolvedIntent === "company_general") {
    return withPlaybook({
      priority: BEHAVIOR_PRIORITIES.COMPANY_GENERAL,
      response_type: DECISION_RESPONSE_TYPES.COMPANY_GENERAL,
      rag_allowed: false,
      questionnaire_allowed: false,
      lead_tier: LEAD_TIERS.INFORMATION_REQUEST,
      next_action: "answer_company",
      reason: appendPlaybookNote("company_general", playbookMeta),
      suppressed_intents: ["rag", "questionnaire", "callback_flow", "product_qa"],
    });
  }

  // 4. Explicit new product question (no active callback).
  if (explicitProduct) {
    return withPlaybook({
      priority: BEHAVIOR_PRIORITIES.EXPLICIT_PRODUCT_QUESTION,
      response_type: DECISION_RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
      rag_allowed: true,
      questionnaire_allowed: false,
      lead_tier: LEAD_TIERS.QUALIFIED_INTEREST,
      next_action: "answer_product",
      reason: appendPlaybookNote("explicit_product_question", playbookMeta),
      suppressed_intents: ["questionnaire", "fallback"],
    });
  }

  // 5. Product context continuation — may use RAG for content.
  if (PRODUCT_CONTINUATION_INTENTS.has(resolvedIntent)) {
    return withPlaybook({
      priority: BEHAVIOR_PRIORITIES.PRODUCT_CONTEXT_CONTINUATION,
      response_type: DECISION_RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
      rag_allowed: true,
      questionnaire_allowed: false,
      lead_tier: LEAD_TIERS.QUALIFIED_INTEREST,
      next_action: "answer_product",
      reason: appendPlaybookNote("product_context_continuation", playbookMeta),
      suppressed_intents: ["questionnaire", "fallback"],
    });
  }

  // 6. Product-specific qualification question.
  if (QUALIFICATION_INTENTS.has(resolvedIntent)) {
    return withPlaybook({
      priority: BEHAVIOR_PRIORITIES.PRODUCT_QUALIFICATION,
      response_type: DECISION_RESPONSE_TYPES.COLLECT_SALES_CONTEXT,
      rag_allowed: false,
      questionnaire_allowed: false,
      lead_tier: LEAD_TIERS.QUALIFIED_INTEREST,
      next_action: "ask_qualification",
      reason: appendPlaybookNote("product_qualification", playbookMeta),
      suppressed_intents: ["rag", "questionnaire", "fallback"],
    });
  }

  // 7. Questionnaire — only after eligible product/pricing answer path.
  if (
    isQuestionnaireEligible({
      questionnaireEligible,
      productAnswered,
      pricingAnswered,
      memory,
    })
  ) {
    return withPlaybook({
      priority: BEHAVIOR_PRIORITIES.QUESTIONNAIRE,
      response_type: DECISION_RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
      rag_allowed: false,
      questionnaire_allowed: true,
      lead_tier: LEAD_TIERS.QUALIFIED_INTEREST,
      next_action: "attach_questionnaire",
      reason: appendPlaybookNote("post_product_answer_questionnaire", playbookMeta),
      suppressed_intents: ["rag", "callback_flow", "role_boundary"],
    });
  }

  // 8. Generic fallback — lowest priority.
  return withPlaybook({
    priority: BEHAVIOR_PRIORITIES.FALLBACK,
    response_type: DECISION_RESPONSE_TYPES.FALLBACK_CLARIFICATION,
    rag_allowed: false,
    questionnaire_allowed: false,
    lead_tier: LEAD_TIERS.INFORMATION_REQUEST,
    next_action: "clarify",
    reason: appendPlaybookNote("unclear_intent", playbookMeta),
    suppressed_intents: ["rag", "questionnaire"],
  });
}

/** Privacy-safe JSON snapshot (no transcript, phone, email, or raw query). */
export function formatAgentBehaviorDecisionSnapshot(decision = {}) {
  const payload = {};
  for (const field of SAFE_DECISION_FIELDS) {
    if (field in decision) payload[field] = decision[field];
  }
  return JSON.stringify(payload);
}

/** Phase 10B: opt-in metadata plumbing only (default false). Does not control planner/RAG. */
export function isAgentBehaviorDecisionRuntimeEnabled(config = null) {
  return Boolean(config?.v4?.agentBehaviorDecisionEnabled);
}
