/**
 * v4 deterministic response planner — mock/deterministic plans for canary orchestrator.
 */

import { normalizeText } from "./redaction.js";
import { matchProductAlias, getProductById } from "./agent-config.js";
import {
  detectTranscriptIntent,
  sanitizeResponseText,
  isPostContactProductQuestion
} from "./transcript-intent.js";
import {
  getClosingResponse,
  getFallbackClarificationResponse,
  getOutOfScopeRedirect,
  getTechnicalEscalationResponse,
  getCallbackLeadCaptureResponse,
} from "./behavior-policy.js";
import {
  detectShortFollowUpCategory,
  buildPlaybookShortAnswer,
  buildPlaybookCombinedProductAnswer,
  hasSubstantiveFollowUpContent
} from "./playbook-short-answer.js";
import {
  buildLowConfidenceClarificationText,
  resolveClosedDomainIntent,
} from "./closed-domain-intent.js";
import {
  isScopedProductQaTurn,
  resolveCurrentProductContext,
  shouldEnterSalesQualification,
} from "./product-context-persistence.js";
import { shouldUseRagForTurn, fallbackToPlaybook } from "./rag-orchestrator.js";
import { applyQuestionnaireRuntimeToPlan } from "./questionnaire-runtime.js";
import {
  CALLBACK_FLOW_STATES,
  CALLBACK_FLOW_CONTINUATION_INTENTS,
  CALLBACK_CONFIRMATION_TEXTS,
  buildCallbackReassuranceText,
  hasValidCallerPhone,
  isCallbackFlowActive,
  buildCallbackAbandonEvidence,
  buildClosingDuringCallbackMemoryPatch,
} from "./callback-flow-policy.js";
import { resolveCallerIdCallbackPhrases } from "./caller-id-callback-policy.js";
import { evaluateSpokenPhoneCapture } from "./spoken-phone-capture.js";
import { V4_STATES } from "./state-machine.js";
import { isContactFormHandoffIntent } from "./contact-form-handoff-intent.js";
import {
  getContactFormHandoffResponse,
  isContactFormHandoffRuntimeEnabled,
} from "./contact-form-handoff-policy.js";
import {
  filterPlaybookProductMatch,
  isPlaybookProductContentRuntimeEnabled,
  loadPlaybookForProductContent,
  resolveCombinedProductInquiryAnswer,
  resolveCompanyAnswer,
  resolveProductExplanation,
  resolveProductPricingAnswer,
} from "./playbook-product-content.js";

const NO_RUECKRUF = /\b(rückruf|rueckruf|ruckruf|zurückrufen|zurueckrufen|zuruckrufen)\b/i;

export const RESPONSE_TYPES = {
  PRODUCT_QUESTION_ANSWER: "product_question_answer",
  COLLECT_SALES_CONTEXT: "collect_sales_context",
  COLLECT_CONTACT_PREFERENCE: "collect_contact_preference",
  COLLECT_CALLBACK_PERMISSION: "collect_callback_permission",
  REQUEST_PHONE_ONCE: "request_phone_once",
  EMAIL_GUIDANCE: "email_guidance",
  LEAD_READY_ACK: "lead_ready_ack",
  INTERRUPTION_RECOVERY: "interruption_recovery",
  CALLBACK_PERMISSION_DENIED: "callback_permission_denied",
  CALLBACK_FINALIZED: "callback_finalized",
  CALLBACK_MANUAL_REVIEW: "callback_manual_review",
  CALLBACK_REASSURANCE: "callback_reassurance",
  CLOSING: "closing",
  ROLE_BOUNDARY_REDIRECT: "role_boundary_redirect",
  TECHNICAL_ESCALATION: "technical_escalation",
  FALLBACK_CLARIFICATION: "fallback_clarification",
  GREETING: "greeting",
  CONTACT_FORM_HANDOFF: "contact_form_handoff",
  COMPANY_GENERAL: "company_general",
};

export {
  detectTranscriptIntent,
  sanitizeResponseText,
  isPricingOrProductQuestion,
  isPostContactProductQuestion
} from "./transcript-intent.js";

function planBase(type, overrides = {}) {
  return {
    response_type: type,
    text: "",
    next_state: V4_STATES.LISTENING,
    memory_patch: {},
    quality_event_type: "turn_started",
    allowed_tools: [],
    rag_allowed: false,
    lead_transition_allowed: false,
    plan_reason: null,
    ...overrides,
  };
}

function productContextMemoryPatch(memory, productId, extra = {}) {
  const id = productId ?? resolveCurrentProductContext(memory);
  return {
    selected_product_id: id,
    product_interest: id,
    current_product_context: id,
    previous_product_context:
      memory?.previous_product_context ??
      memory?.interruption_context?.interrupted_product_id ??
      null,
    interruption_context: null,
    current_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
    ...extra,
  };
}

function planScopedProductAnswer({
  agentConfig,
  memory,
  transcript,
  ragAnswer = null,
  ragGate = null,
  ragResult = null,
  planReason = "scoped_product_qa",
  playbook = null,
  playbookContentActive = false,
}) {
  const productId = resolveCurrentProductContext(memory);
  const resolved = resolveRagAwareProductAnswer({
    agentConfig,
    productId,
    transcript,
    ragAnswer,
    ragResult,
    planReason,
    playbook,
    playbookContentActive,
  });

  return planBase(RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, {
    text: resolved.text,
    next_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
    memory_patch: productContextMemoryPatch(memory, productId),
    quality_event_type: gateUsesRag(ragGate) ? "rag_retrieval_completed" : "turn_started",
    allowed_tools: gateUsesRag(ragGate) ? ["rag"] : [],
    rag_allowed: gateUsesRag(ragGate),
    plan_reason: resolved.planReason,
    max_spoken_chars: resolved.maxSpokenChars ?? null,
    lead_transition_allowed: false,
  });
}

function productDisplayName(agentConfig, productId) {
  const product = productId ? getProductById(agentConfig, productId) : null;
  return product?.display_name ?? "Ihrem Thema";
}

function interruptionMemoryPatch(memory, productId, extra = {}) {
  return {
    selected_product_id: productId ?? memory.selected_product_id,
    product_interest: productId ?? memory.product_interest,
    interruption_context: null,
    current_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
    ...extra
  };
}

function planInterruptionFollowUp({
  agentConfig,
  memory,
  stateMachine,
  transcript,
  resolvedIntent,
  interruptionRecovery,
  ragAnswer,
  ragGate,
  ragResult = null,
  closedDomain = null,
}) {
  const interruptedId =
    interruptionRecovery?.context?.interrupted_product_id ??
    memory?.interruption_context?.interrupted_product_id ??
    null;
  const productId =
    memory.selected_product_id ??
    closedDomain?.matched_product ??
    interruptionRecovery?.context?.detected_product_id ??
    interruptedId ??
    matchProductAlias(agentConfig, transcript)?.id;
  const productName = productDisplayName(agentConfig, productId);
  const category = detectShortFollowUpCategory(transcript);
  const substantive =
    hasSubstantiveFollowUpContent(transcript) ||
    resolvedIntent === "product_question" ||
    interruptionRecovery?.recoveryAction === "product_question";

  if (category) {
    const resolved = resolveRagAwareProductAnswer({
      agentConfig,
      productId,
      transcript,
      ragAnswer,
      ragResult,
      planReason: "interrupt_scoped_product_qa",
    });
    return planBase(RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, {
      text: resolved.text,
      next_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
      memory_patch: interruptionMemoryPatch(memory, productId),
      quality_event_type: gateUsesRag(ragGate) ? "rag_retrieval_completed" : "turn_started",
      allowed_tools: gateUsesRag(ragGate) ? ["rag"] : [],
      rag_allowed: gateUsesRag(ragGate),
      plan_reason: resolved.planReason,
      max_spoken_chars: resolved.maxSpokenChars ?? null,
    });
  }

  if (substantive && productId) {
    const resolved = resolveRagAwareProductAnswer({
      agentConfig,
      productId,
      transcript,
      ragAnswer,
      ragResult,
      planReason: "interrupt_scoped_product_qa",
    });
    const playbook =
      resolved.text ??
      sanitizeResponseText(
        `${productName} unterstützt Sichtbarkeit und Anfragen. Was möchten Sie genau wissen?`
      );
    return planBase(RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, {
      text: sanitizeResponseText(playbook),
      next_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
      memory_patch: interruptionMemoryPatch(memory, productId),
      quality_event_type: gateUsesRag(ragGate) ? "rag_retrieval_completed" : "turn_started",
      allowed_tools: gateUsesRag(ragGate) ? ["rag"] : [],
      rag_allowed: gateUsesRag(ragGate),
      plan_reason: resolved.planReason,
      max_spoken_chars: resolved.maxSpokenChars ?? null,
    });
  }

  const ack = productId
    ? `Gerne. Zur ${productName}: Was möchten Sie genau wissen?`
    : "Gerne. Was möchten Sie dazu wissen?";

  return planBase(RESPONSE_TYPES.INTERRUPTION_RECOVERY, {
    text: sanitizeResponseText(ack),
    next_state: V4_STATES.LISTENING,
    memory_patch: interruptionMemoryPatch(memory, productId, {
      current_state: V4_STATES.LISTENING
    }),
    quality_event_type: "interruption_recovered",
    rag_allowed: false
  });
}

function gateUsesRag(ragGate) {
  return Boolean(ragGate?.allowed && ragGate?.used_rag);
}

function resolvePlaybookFilteredProductId(activePlaybook, productId, transcript, memory) {
  if (!productId) return null;
  if (!activePlaybook) return productId;
  if (memory?.selected_product_id) return productId;
  return filterPlaybookProductMatch(activePlaybook, productId, transcript);
}

/**
 * Prefer playbook answers over RAG fallback text when retrieval did not produce a hit.
 */
function resolveRagAwareProductAnswer({
  agentConfig,
  productId,
  transcript,
  ragAnswer = null,
  ragResult = null,
  planReason = "scoped_product_qa",
  playbook = null,
  playbookContentActive = false,
}) {
  const combined = buildPlaybookCombinedProductAnswer(agentConfig, productId, transcript);
  const category = detectShortFollowUpCategory(transcript);

  if (ragResult?.used_rag && ragAnswer) {
    return {
      text: sanitizeResponseText(ragAnswer),
      planReason: combined ? "combined_product_inquiry" : planReason,
      maxSpokenChars: ragResult?.max_spoken_chars ?? null,
    };
  }

  if (playbookContentActive && playbook && productId) {
    const combinedPlaybook = resolveCombinedProductInquiryAnswer(playbook, productId, transcript);
    if (combinedPlaybook) {
      return { text: sanitizeResponseText(combinedPlaybook), planReason: "combined_product_inquiry", maxSpokenChars: null };
    }
    if (category === "pricing") {
      const pricing = resolveProductPricingAnswer(playbook, productId);
      if (pricing) {
        return {
          text: sanitizeResponseText(pricing),
          planReason: "product_pricing_fallback",
          maxSpokenChars: null,
        };
      }
    }
    const explanation = resolveProductExplanation(playbook, productId);
    if (explanation) {
      return {
        text: sanitizeResponseText(explanation),
        planReason: "playbook_product_explanation",
        maxSpokenChars: null,
      };
    }
  }

  if (combined) {
    return { text: combined, planReason: "combined_product_inquiry", maxSpokenChars: null };
  }

  if (category && productId) {
    return {
      text: sanitizeResponseText(buildPlaybookShortAnswer(agentConfig, productId, category)),
      planReason: category === "pricing" ? "product_pricing_fallback" : planReason,
      maxSpokenChars: null,
    };
  }

  if (ragAnswer) {
    return { text: sanitizeResponseText(ragAnswer), planReason, maxSpokenChars: ragResult?.max_spoken_chars ?? null };
  }

  const product = productId ? getProductById(agentConfig, productId) : null;
  const playbookAnswer = productId
    ? buildPlaybookShortAnswer(agentConfig, productId, "how_it_works")
    : null;
  return {
    text: sanitizeResponseText(
      playbookAnswer ||
        (product
          ? `${product.display_name} wird individuell nach Bedarf kalkuliert. Möchten Sie mehr Details?`
          : "Gerne. Was möchten Sie dazu wissen?"),
    ),
    planReason,
    maxSpokenChars: null,
  };
}

export function buildResponsePlan(options = {}) {
  const contactFormHandoffEnabled = isContactFormHandoffRuntimeEnabled(
    options.config,
    options.v4PathActive
  );
  const playbookProductContentEnabled = isPlaybookProductContentRuntimeEnabled(
    options.config,
    options.behaviorPolicy,
    options.playbook
  );
  const resolvedIntent =
    options.intent ??
    detectTranscriptIntent(
      options.transcript ?? "",
      options.memory ?? {},
      options.agentConfig,
      options.behaviorPolicy,
      contactFormHandoffEnabled,
      playbookProductContentEnabled
    );
  const plan = buildResponsePlanCore({
    ...options,
    intent: resolvedIntent,
    contactFormHandoffEnabled,
    playbookProductContentEnabled,
  });
  return applyQuestionnaireRuntimeToPlan(plan, { ...options, resolvedIntent });
}

function buildResponsePlanCore({
  agentConfig,
  memory = {},
  stateMachine = {},
  transcript = "",
  intent = null,
  ragAnswer = null,
  ragGate = null,
  ragResult = null,
  interruptionRecovery = null,
  closedDomain = null,
  interruptFollowupTimeout = false,
  behaviorPolicy = null,
  callerPhoneNormalized = null,
  callerPhoneRaw = null,
  contactFormHandoffEnabled = false,
  playbookProductContentEnabled = false,
  config = null,
  playbook = null,
} = {}) {
  const resolvedIntent =
    intent ??
    detectTranscriptIntent(
      transcript,
      memory,
      agentConfig,
      behaviorPolicy,
      contactFormHandoffEnabled,
      playbookProductContentEnabled
    );
  const activePlaybook = playbookProductContentEnabled
    ? loadPlaybookForProductContent({ config, behaviorPolicy, playbook })
    : null;
  const agent = agentConfig?.config ?? agentConfig ?? {};
  const state = stateMachine?.state ?? memory?.current_state ?? V4_STATES.LISTENING;

  if (interruptFollowupTimeout) {
    const productId =
      memory.selected_product_id ??
      memory?.interruption_context?.interrupted_product_id ??
      closedDomain?.matched_product ??
      null;
    const productName = productDisplayName(agentConfig, productId);
    const ack = productId
      ? `Gerne. Zur ${productName}: Was möchten Sie genau wissen?`
      : "Gerne. Was möchten Sie dazu wissen?";
    return planBase(RESPONSE_TYPES.INTERRUPTION_RECOVERY, {
      text: sanitizeResponseText(ack),
      next_state: V4_STATES.LISTENING,
      memory_patch: interruptionMemoryPatch(memory, productId, {
        current_state: V4_STATES.LISTENING
      }),
      quality_event_type: "interruption_recovered",
      rag_allowed: false
    });
  }
  // Phase 10AK: closing / stop intent is highest priority and must be planned
  // before scoped product QA, RAG, interrupt follow-up, and lead capture.
  if (resolvedIntent === "closing") {
    const callbackAbandonEvidence = buildCallbackAbandonEvidence(memory);
    return planBase(RESPONSE_TYPES.CLOSING, {
      text: sanitizeResponseText(getClosingResponse(behaviorPolicy)),
      next_state: V4_STATES.COMPLETED,
      memory_patch: buildClosingDuringCallbackMemoryPatch(memory),
      quality_event_type: "turn_started",
      plan_reason: callbackAbandonEvidence.callback_flow_abandoned
        ? "closing_intent_callback_abandoned"
        : "closing_intent",
      rag_allowed: false,
      lead_transition_allowed: false,
      callback_abandon: callbackAbandonEvidence,
    });
  }

  // Phase 10AP: role boundary (#2) — after closing, before product/RAG/lead paths.
  if (resolvedIntent === "out_of_scope") {
    return planBase(RESPONSE_TYPES.ROLE_BOUNDARY_REDIRECT, {
      text: sanitizeResponseText(getOutOfScopeRedirect(behaviorPolicy)),
      next_state: V4_STATES.LISTENING,
      memory_patch: { current_state: V4_STATES.LISTENING },
      quality_event_type: "turn_started",
      plan_reason: "out_of_scope_redirect",
      rag_allowed: false,
      lead_transition_allowed: false,
    });
  }

  if (resolvedIntent === "technical_escalation") {
    return planBase(RESPONSE_TYPES.TECHNICAL_ESCALATION, {
      text: sanitizeResponseText(getTechnicalEscalationResponse(behaviorPolicy)),
      next_state: V4_STATES.LISTENING,
      memory_patch: { current_state: V4_STATES.LISTENING },
      quality_event_type: "turn_started",
      plan_reason: "technical_escalation",
      rag_allowed: false,
      lead_transition_allowed: false,
    });
  }

  if (contactFormHandoffEnabled && isContactFormHandoffIntent(resolvedIntent)) {
    return planBase(RESPONSE_TYPES.CONTACT_FORM_HANDOFF, {
      text: sanitizeResponseText(getContactFormHandoffResponse({ intent: resolvedIntent })),
      next_state: V4_STATES.LISTENING,
      memory_patch: { current_state: V4_STATES.LISTENING, lead_ready: false },
      quality_event_type: "turn_started",
      plan_reason: `contact_form_handoff:${resolvedIntent}`,
      rag_allowed: false,
      lead_transition_allowed: false,
    });
  }

  // Conversation Priority Contract #3: explicit callback/contact requests must
  // start soft lead capture before scoped product QA, RAG, interruption repair,
  // or questionnaire logic can continue the product explanation.
  if (resolvedIntent === "callback_request") {
    return planBase(RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE, {
      text: sanitizeResponseText(getCallbackLeadCaptureResponse(behaviorPolicy)),
      next_state: V4_STATES.COLLECTING_CONTACT_PREFERENCE,
      memory_patch: {
        current_state: V4_STATES.COLLECTING_CONTACT_PREFERENCE,
        // Phase 10AT/10AU: mark the pending callback/contact flow so the next
        // short answers stay in the contact flow across state churn.
        contact_flow_pending: true,
        callback_flow_state: CALLBACK_FLOW_STATES.CONTACT_PREFERENCE_PENDING,
        lead_ready: false,
      },
      quality_event_type: "turn_started",
      plan_reason: "callback_request_intent",
      rag_allowed: false,
      lead_transition_allowed: false,
    });
  }

  // Phase 10AU Golden Conversation Contract: attention/recovery phrases after
  // the callback decision ("Hallo?", "Sind Sie noch da?", bare "Ja.") repeat
  // the callback/manual-review confirmation. Never product QA, never RAG,
  // never questionnaire.
  if (resolvedIntent === "callback_flow_attention") {
    return planBase(RESPONSE_TYPES.CALLBACK_REASSURANCE, {
      text: sanitizeResponseText(buildCallbackReassuranceText(memory)),
      next_state: V4_STATES.LISTENING,
      memory_patch: { current_state: V4_STATES.LISTENING },
      quality_event_type: "turn_started",
      plan_reason: "callback_flow_reassurance",
      rag_allowed: false,
      lead_transition_allowed: false,
    });
  }

  // Phase 10F: company-general after callback flow; never during active callback.
  if (
    resolvedIntent === "company_general" &&
    activePlaybook &&
    !isCallbackFlowActive(memory)
  ) {
    const companyAnswer = resolveCompanyAnswer(activePlaybook);
    if (companyAnswer) {
      return planBase(RESPONSE_TYPES.COMPANY_GENERAL, {
        text: sanitizeResponseText(companyAnswer),
        next_state: V4_STATES.LISTENING,
        memory_patch: { current_state: V4_STATES.LISTENING, lead_ready: false },
        quality_event_type: "turn_started",
        plan_reason: "company_ecosystem_answer",
        rag_allowed: false,
        lead_transition_allowed: false,
      });
    }
  }

  // Phase 10AT/10AU: callback/contact continuation (#3) outranks scoped
  // product QA, RAG, interruption recovery, and questionnaire. Without this
  // guard a bare "Ja." after the permission question was hijacked by
  // scoped_product_qa.
  const contactFlowContinuation = CALLBACK_FLOW_CONTINUATION_INTENTS.has(resolvedIntent);
  // Once the callback flow is active, product QA may resume only when the
  // caller clearly asks a new product question — never via the closed-domain
  // default intent ("Hallo?" must not become scoped_product_qa).
  const explicitProductReturn =
    resolvedIntent === "product_question" || resolvedIntent === "product_selection";
  const callbackFlowBlocksProductQa =
    isCallbackFlowActive(memory) && !explicitProductReturn;

  const gate =
    ragGate ??
    shouldUseRagForTurn({ state, intent: resolvedIntent, memory, transcript });
  const effectiveRagGate = {
    ...gate,
    used_rag: Boolean(ragResult?.used_rag),
  };
  const postContactProductQa = isPostContactProductQuestion(memory, transcript, resolvedIntent);

  const closedDomainResolved =
    closedDomain ??
    resolveClosedDomainIntent({ agentConfig, transcript, memory });

  if (
    !contactFlowContinuation &&
    !callbackFlowBlocksProductQa &&
    isScopedProductQaTurn(memory, transcript, closedDomainResolved) &&
    !interruptFollowupTimeout &&
    !shouldEnterSalesQualification(transcript, resolvedIntent)
  ) {
    return planScopedProductAnswer({
      agentConfig,
      memory,
      transcript,
      ragAnswer,
      ragGate: effectiveRagGate,
      ragResult,
      planReason: interruptionRecovery ? "interrupt_scoped_product_qa" : "scoped_product_qa",
      playbook: activePlaybook,
      playbookContentActive: Boolean(activePlaybook),
    });
  }

  const interruptionFollowUp =
    Boolean(interruptionRecovery) &&
    (resolvedIntent === "interruption_followup" ||
      resolvedIntent === "topic_repair" ||
      resolvedIntent === "interruption_recovery" ||
      interruptionRecovery?.recoveryAction === "interruption_followup" ||
      interruptionRecovery?.recoveryAction === "continue_same_topic" ||
      interruptionRecovery?.recoveryAction === "product_question");

  const knownProductScopedQuestion =
    Boolean(memory?.selected_product_id) &&
    (closedDomain?.intent === "pricing" ||
      closedDomain?.intent === "capability" ||
      closedDomain?.intent === "contact" ||
      detectShortFollowUpCategory(transcript));

  if (
    Boolean(interruptionRecovery) &&
    knownProductScopedQuestion &&
    !interruptFollowupTimeout
  ) {
    const productId = memory.selected_product_id;
    const category = detectShortFollowUpCategory(transcript);
    if (category) {
      const answer = sanitizeResponseText(
        buildPlaybookShortAnswer(agentConfig, productId, category),
      );
      return planBase(RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, {
        text: answer,
        next_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
        memory_patch: interruptionMemoryPatch(memory, productId),
        quality_event_type: "turn_started",
        rag_allowed: false,
      });
    }
    if (resolvedIntent === "product_question" || closedDomain?.intent === "pricing") {
      const product = getProductById(agentConfig, productId);
      const playbookAnswer =
        category && productId
          ? buildPlaybookShortAnswer(agentConfig, productId, category)
          : null;
      const answer =
        ragAnswer ??
        (playbookAnswer
          ? sanitizeResponseText(playbookAnswer)
          : sanitizeResponseText(
              product
                ? `${product.display_name} wird individuell nach Bedarf kalkuliert. Möchten Sie mehr Details?`
                : "Gerne. Was möchten Sie dazu wissen?",
            ));
      return planBase(RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, {
        text: answer,
        next_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
        memory_patch: interruptionMemoryPatch(memory, productId),
        quality_event_type: gateUsesRag(effectiveRagGate) ? "rag_retrieval_completed" : "turn_started",
        allowed_tools: gateUsesRag(effectiveRagGate) ? ["rag"] : [],
        rag_allowed: gateUsesRag(effectiveRagGate),
      });
    }
  }

  if (interruptionRecovery?.recoveryAction === "product_switch") {
    const product = getProductById(agentConfig, memory.selected_product_id);
    const productId = memory.selected_product_id;
    return planBase(RESPONSE_TYPES.INTERRUPTION_RECOVERY, {
      text: sanitizeResponseText(
        `Alles klar, wir wechseln zu ${product?.display_name ?? "Ihrem Thema"}. Wie kann ich Ihnen helfen?`,
      ),
      next_state: V4_STATES.LISTENING,
      memory_patch: productContextMemoryPatch(memory, productId, {
        current_state: V4_STATES.LISTENING,
      }),
      quality_event_type: "interruption_recovered",
      rag_allowed: false,
      plan_reason: "product_switch_ack",
    });
  }

  if (
    interruptionFollowUp &&
    interruptionRecovery?.recoveryAction !== "product_switch" &&
    interruptionRecovery?.recoveryAction !== "topic_reset"
  ) {
    return planInterruptionFollowUp({
      agentConfig,
      memory,
      stateMachine,
      transcript,
      resolvedIntent,
      interruptionRecovery,
      ragAnswer,
      ragGate: effectiveRagGate,
      ragResult,
      closedDomain,
    });
  }

  if (
    resolvedIntent === "unclear" &&
    closedDomainResolved?.is_low_confidence &&
    closedDomainResolved?.clarification_type &&
    !isScopedProductQaTurn(memory, transcript, closedDomainResolved)
  ) {
    return planBase(RESPONSE_TYPES.FALLBACK_CLARIFICATION, {
      text: sanitizeResponseText(buildLowConfidenceClarificationText(closedDomainResolved, agentConfig)),
      next_state: V4_STATES.LISTENING,
      memory_patch: {
        current_state: V4_STATES.LISTENING,
        selected_product_id:
          closedDomainResolved.matched_product && closedDomainResolved.product_confidence >= 0.7
            ? closedDomainResolved.matched_product
            : memory.selected_product_id,
        current_product_context:
          resolveCurrentProductContext(memory) ??
          closedDomainResolved.matched_product ??
          null,
      },
      quality_event_type: "turn_started",
      rag_allowed: false,
      plan_reason: "low_confidence_clarification",
    });
  }

  if (
    closedDomainResolved?.matched_product &&
    closedDomainResolved.product_confidence >= 0.75 &&
    !memory.selected_product_id
  ) {
    memory = { ...memory, selected_product_id: closedDomainResolved.matched_product };
  }

  if (resolvedIntent === "greeting" || state === V4_STATES.GREETING) {
    return planBase(RESPONSE_TYPES.GREETING, {
      text: sanitizeResponseText("Willkommen bei TechnoloHit. Wobei kann ich Ihnen helfen?"),
      next_state: V4_STATES.LISTENING,
      memory_patch: { current_state: V4_STATES.LISTENING },
      quality_event_type: "call_started"
    });
  }

  if (postContactProductQa && gate.allowed) {
    const productId = memory.selected_product_id ?? matchProductAlias(agentConfig, transcript)?.id;
    const product = productId ? getProductById(agentConfig, productId) : null;
    const answer =
      ragAnswer ??
      sanitizeResponseText(
        product
          ? `${product.display_name} wird individuell nach Bedarf kalkuliert. Möchten Sie mehr Details?`
          : "Gerne erkläre ich Ihnen unsere Lösungen. Welches Produkt interessiert Sie?"
      );
    return planBase(RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, {
      text: answer,
      next_state: state === V4_STATES.VALIDATING_CONTACT ? V4_STATES.VALIDATING_CONTACT : V4_STATES.ANSWERING_PRODUCT_QUESTION,
      memory_patch: {
        selected_product_id: productId ?? memory.selected_product_id,
        product_interest: productId ?? memory.product_interest,
        contact_preference: memory.contact_preference,
        email_present: memory.email_present,
        callback_permission: memory.callback_permission,
        lead_ready: memory.lead_ready ?? false,
        current_state:
          state === V4_STATES.VALIDATING_CONTACT
            ? V4_STATES.VALIDATING_CONTACT
            : V4_STATES.ANSWERING_PRODUCT_QUESTION
      },
      quality_event_type: gateUsesRag(effectiveRagGate) ? "rag_retrieval_completed" : "turn_started",
      allowed_tools: gateUsesRag(effectiveRagGate) ? ["rag"] : [],
      rag_allowed: gateUsesRag(effectiveRagGate),
      max_spoken_chars: ragResult?.max_spoken_chars ?? null,
      lead_transition_allowed: false
    });
  }

  if (resolvedIntent === "product_question") {
    const aliasMatch = matchProductAlias(agentConfig, transcript)?.id;
    let productId = memory.selected_product_id ?? aliasMatch;
    if (activePlaybook && productId && !memory.selected_product_id) {
      productId = resolvePlaybookFilteredProductId(activePlaybook, productId, transcript, memory);
    }
    const resolved = resolveRagAwareProductAnswer({
      agentConfig,
      productId,
      transcript,
      ragAnswer,
      ragResult,
      planReason: "scoped_product_qa",
      playbook: activePlaybook,
      playbookContentActive: Boolean(activePlaybook),
    });
    return planBase(RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, {
      text: resolved.text,
      next_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
      memory_patch: productContextMemoryPatch(memory, productId, {
        current_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
      }),
      quality_event_type: gateUsesRag(effectiveRagGate) ? "rag_retrieval_completed" : "turn_started",
      allowed_tools: gateUsesRag(effectiveRagGate) ? ["rag"] : [],
      rag_allowed: gateUsesRag(effectiveRagGate),
      plan_reason: resolved.planReason,
      max_spoken_chars: resolved.maxSpokenChars ?? null,
      lead_transition_allowed: false,
    });
  }

  if (resolvedIntent === "product_selection") {
    const product = matchProductAlias(agentConfig, transcript);
    let productId = product?.id ?? closedDomainResolved?.matched_product ?? memory.selected_product_id;
    if (activePlaybook && productId && !memory.selected_product_id) {
      productId = resolvePlaybookFilteredProductId(activePlaybook, productId, transcript, memory);
    }
    const combinedAnswer =
      (activePlaybook &&
        resolveCombinedProductInquiryAnswer(activePlaybook, productId, transcript)) ||
      buildPlaybookCombinedProductAnswer(agentConfig, productId, transcript);
    if (combinedAnswer) {
      return planBase(RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, {
        text: combinedAnswer,
        next_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
        memory_patch: productContextMemoryPatch(memory, productId, {
          current_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
        }),
        quality_event_type: "turn_started",
        rag_allowed: false,
        plan_reason: "combined_product_inquiry",
        lead_transition_allowed: false,
      });
    }
    if (!shouldEnterSalesQualification(transcript, resolvedIntent)) {
      const intro =
        (activePlaybook && resolveProductExplanation(activePlaybook, productId)) ||
        buildPlaybookShortAnswer(agentConfig, productId, "how_it_works");
      return planBase(RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, {
        text: sanitizeResponseText(
          intro || `Gerne zu ${product?.display_name ?? "diesem Produkt"}. Was möchten Sie dazu wissen?`
        ),
        next_state: V4_STATES.LISTENING,
        memory_patch: productContextMemoryPatch(memory, productId, {
          current_state: V4_STATES.LISTENING
        }),
        quality_event_type: "turn_started",
        rag_allowed: false,
        plan_reason: "product_selection_intro"
      });
    }
    return planBase(RESPONSE_TYPES.COLLECT_SALES_CONTEXT, {
      text: sanitizeResponseText(
        product
          ? `Gern zu ${product.display_name}. Sind Sie Neukunde oder bestehender Kunde?`
          : "Welches Produkt interessiert Sie?"
      ),
      next_state: V4_STATES.COLLECTING_SALES_CONTEXT,
      memory_patch: {
        selected_product_id: productId,
        product_interest: productId,
        current_product_context: productId,
        current_state: V4_STATES.COLLECTING_SALES_CONTEXT
      },
      quality_event_type: "turn_started",
      plan_reason: "explicit_sales_qualification"
    });
  }

  if (resolvedIntent === "sales_customer_type") {
    const customerType = /\b(bestands|bestehend)\b/i.test(transcript)
      ? "existing_customer"
      : "new_prospect";
    return planBase(RESPONSE_TYPES.COLLECT_SALES_CONTEXT, {
      text: sanitizeResponseText("Danke. Wie möchten Sie am liebsten kontaktiert werden: telefonisch oder per E-Mail?"),
      next_state: V4_STATES.COLLECTING_CONTACT_PREFERENCE,
      memory_patch: {
        customer_type: customerType,
        current_state: V4_STATES.COLLECTING_CONTACT_PREFERENCE
      },
      quality_event_type: "turn_started"
    });
  }

  if (resolvedIntent === "contact_email") {
    return planBase(RESPONSE_TYPES.EMAIL_GUIDANCE, {
      text: sanitizeResponseText(
        "Gerne. Bitte senden Sie uns Ihre Anfrage per E-Mail. Gibt es sonst noch etwas?"
      ),
      next_state: V4_STATES.VALIDATING_CONTACT,
      memory_patch: {
        contact_preference: "email",
        email_present: true,
        lead_ready: false,
        contact_flow_pending: false,
        callback_flow_state: CALLBACK_FLOW_STATES.EMAIL_DIRECTED,
        current_state: V4_STATES.VALIDATING_CONTACT
      },
      quality_event_type: "lead_skipped",
      lead_transition_allowed: false
    });
  }

  if (resolvedIntent === "contact_phone") {
    const callerIdPhrases = resolveCallerIdCallbackPhrases({
      config,
      behaviorPolicy,
      playbook: activePlaybook,
    });
    const phoneAvailable = hasValidCallerPhone({
      callerPhoneNormalized,
      callerPhoneRaw,
      memory,
    });
    if (phoneAvailable) {
      return planBase(RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION, {
        text: sanitizeResponseText(callerIdPhrases.availablePhrase),
        next_state: V4_STATES.COLLECTING_CALLBACK_PERMISSION,
        memory_patch: {
          contact_preference: "phone",
          contact_flow_pending: true,
          callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING,
          current_state: V4_STATES.COLLECTING_CALLBACK_PERMISSION,
        },
        quality_event_type: "turn_started",
        plan_reason: "contact_phone_preference",
        rag_allowed: false,
        lead_transition_allowed: false,
      });
    }
    return planBase(RESPONSE_TYPES.REQUEST_PHONE_ONCE, {
      text: sanitizeResponseText(callerIdPhrases.missingPhrase),
      next_state: V4_STATES.COLLECTING_PHONE_NUMBER,
      memory_patch: {
        contact_preference: "phone",
        contact_flow_pending: true,
        phone_capture_attempted: true,
        phone_present: false,
        callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
        current_state: V4_STATES.COLLECTING_PHONE_NUMBER,
      },
      quality_event_type: "turn_started",
      plan_reason: "caller_id_missing_request_phone_once",
      rag_allowed: false,
      lead_transition_allowed: false,
    });
  }

  if (resolvedIntent === "phone_number_candidate") {
    const callerIdPhrases = resolveCallerIdCallbackPhrases({
      config,
      behaviorPolicy,
      playbook: activePlaybook,
    });
    const capture = evaluateSpokenPhoneCapture(transcript);
    if (capture.ok) {
      return planBase(RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION, {
        text: sanitizeResponseText(callerIdPhrases.availablePhrase),
        next_state: V4_STATES.COLLECTING_CALLBACK_PERMISSION,
        captured_phone_normalized: capture.normalized_phone,
        memory_patch: {
          contact_preference: "phone",
          contact_flow_pending: true,
          phone_capture_attempted: true,
          phone_present: true,
          callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING,
          current_state: V4_STATES.COLLECTING_CALLBACK_PERMISSION,
        },
        quality_event_type: "turn_started",
        plan_reason: "phone_number_captured",
        rag_allowed: false,
        lead_transition_allowed: false,
      });
    }
    return planBase(RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW, {
      text: sanitizeResponseText(callerIdPhrases.failurePhrase),
      next_state: V4_STATES.LISTENING,
      memory_patch: {
        contact_preference: memory?.contact_preference ?? "phone",
        lead_ready: false,
        phone_present: false,
        contact_flow_pending: false,
        phone_capture_attempted: true,
        callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_MANUAL_REVIEW,
        current_state: V4_STATES.LISTENING,
      },
      quality_event_type: "lead_skipped",
      plan_reason: "phone_capture_failed",
      rag_allowed: false,
      lead_transition_allowed: false,
    });
  }

  if (resolvedIntent === "phone_capture_refused" || resolvedIntent === "phone_capture_failed") {
    const callerIdPhrases = resolveCallerIdCallbackPhrases({
      config,
      behaviorPolicy,
      playbook: activePlaybook,
    });
    return planBase(RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW, {
      text: sanitizeResponseText(callerIdPhrases.failurePhrase),
      next_state: V4_STATES.LISTENING,
      memory_patch: {
        contact_preference: memory?.contact_preference ?? "phone",
        lead_ready: false,
        phone_present: false,
        contact_flow_pending: false,
        phone_capture_attempted: true,
        callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_MANUAL_REVIEW,
        current_state: V4_STATES.LISTENING,
      },
      quality_event_type: "lead_skipped",
      plan_reason:
        resolvedIntent === "phone_capture_refused"
          ? "phone_capture_refused"
          : "phone_capture_failed",
      rag_allowed: false,
      lead_transition_allowed: false,
    });
  }

  // Phase 10AU: permission grant is a protected finalization step. With a
  // valid caller phone the request is recorded as a callback (validator still
  // gates callback-ready). Without one, the assistant confirms manual review
  // instead of pretending callback-ready or drifting back to product QA.
  if (
    resolvedIntent === "callback_permission_granted" &&
    (memory?.contact_preference === "phone" ||
      memory?.current_state === V4_STATES.COLLECTING_CALLBACK_PERMISSION ||
      state === V4_STATES.COLLECTING_CALLBACK_PERMISSION)
  ) {
    const phoneAvailable = hasValidCallerPhone({
      callerPhoneNormalized,
      callerPhoneRaw,
      memory,
    });
    if (phoneAvailable) {
      return planBase(RESPONSE_TYPES.CALLBACK_FINALIZED, {
        text: sanitizeResponseText(CALLBACK_CONFIRMATION_TEXTS.finalized),
        next_state: V4_STATES.VALIDATING_CONTACT,
        memory_patch: {
          contact_preference: memory?.contact_preference ?? "phone",
          callback_permission: "granted",
          contact_flow_pending: false,
          callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_FINALIZED,
          current_state: V4_STATES.VALIDATING_CONTACT
        },
        quality_event_type: "turn_started",
        plan_reason: "callback_permission_granted",
        rag_allowed: false,
        lead_transition_allowed: true
      });
    }
    return planBase(RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW, {
      text: sanitizeResponseText(CALLBACK_CONFIRMATION_TEXTS.manual_review),
      next_state: V4_STATES.LISTENING,
      memory_patch: {
        contact_preference: memory?.contact_preference ?? "phone",
        callback_permission: "granted",
        lead_ready: false,
        contact_flow_pending: false,
        callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_MANUAL_REVIEW,
        current_state: V4_STATES.LISTENING
      },
      quality_event_type: "lead_skipped",
      plan_reason: "callback_manual_review_no_phone",
      rag_allowed: false,
      lead_transition_allowed: false
    });
  }

  // Phase 10AT: refusal after the permission question must not create a
  // callback-ready lead and must not bounce back into product Q&A.
  if (resolvedIntent === "callback_permission_denied") {
    return planBase(RESPONSE_TYPES.CALLBACK_PERMISSION_DENIED, {
      text: sanitizeResponseText(
        "Alles klar, dann melden wir uns nicht telefonisch. Sie erreichen unser Team jederzeit per E-Mail über www.technolohit.com. Kann ich Ihnen sonst noch weiterhelfen?"
      ),
      next_state: V4_STATES.LISTENING,
      memory_patch: {
        callback_permission: "denied",
        lead_ready: false,
        contact_flow_pending: false,
        callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_DENIED,
        current_state: V4_STATES.LISTENING
      },
      quality_event_type: "lead_skipped",
      plan_reason: "callback_permission_denied",
      rag_allowed: false,
      lead_transition_allowed: false
    });
  }

  if (state === V4_STATES.LEAD_READY || memory?.lead_ready) {
    return planBase(RESPONSE_TYPES.LEAD_READY_ACK, {
      text: sanitizeResponseText("Vielen Dank. Unser Team meldet sich bei Ihnen."),
      next_state: V4_STATES.CLOSING,
      memory_patch: { current_state: V4_STATES.CLOSING },
      quality_event_type: "lead_created",
      lead_transition_allowed: false
    });
  }

  if (memory?.interruption_context && !normalizeText(transcript)) {
    return planBase(RESPONSE_TYPES.FALLBACK_CLARIFICATION, {
      text: sanitizeResponseText("Gerne. Was möchten Sie dazu wissen?"),
      next_state: V4_STATES.LISTENING,
      memory_patch: { current_state: V4_STATES.LISTENING },
      quality_event_type: "turn_started"
    });
  }

  return planBase(RESPONSE_TYPES.FALLBACK_CLARIFICATION, {
    text: sanitizeResponseText(getFallbackClarificationResponse(behaviorPolicy)),
    next_state: V4_STATES.LISTENING,
    memory_patch: { current_state: V4_STATES.LISTENING },
    quality_event_type: "turn_started"
  });
}

export function applyMemoryPatch(memory, patch = {}) {
  if (!patch || typeof patch !== "object") return memory;
  return { ...memory, ...patch, updated_at: Date.now() };
}
