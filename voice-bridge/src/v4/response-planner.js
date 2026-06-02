/**
 * v4 deterministic response planner — mock/deterministic plans for canary orchestrator.
 */

import { normalizeText } from "./redaction.js";
import { matchProductAlias, getProductById } from "./agent-config.js";
import {
  detectTranscriptIntent,
  sanitizeResponseText,
  isPostContactProductQuestion,
  getWarmGoodbyeResponseText
} from "./transcript-intent.js";
import {
  detectShortFollowUpCategory,
  buildPlaybookShortAnswer,
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
import { V4_STATES } from "./state-machine.js";

const NO_RUECKRUF = /\b(rückruf|rueckruf|ruckruf|zurückrufen|zurueckrufen|zuruckrufen)\b/i;

export const RESPONSE_TYPES = {
  PRODUCT_QUESTION_ANSWER: "product_question_answer",
  COLLECT_SALES_CONTEXT: "collect_sales_context",
  COLLECT_CONTACT_PREFERENCE: "collect_contact_preference",
  COLLECT_CALLBACK_PERMISSION: "collect_callback_permission",
  EMAIL_GUIDANCE: "email_guidance",
  LEAD_READY_ACK: "lead_ready_ack",
  INTERRUPTION_RECOVERY: "interruption_recovery",
  CLOSING: "closing",
  FALLBACK_CLARIFICATION: "fallback_clarification",
  GREETING: "greeting"
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
  planReason = "scoped_product_qa",
}) {
  const productId = resolveCurrentProductContext(memory);
  const category = detectShortFollowUpCategory(transcript);
  const product = productId ? getProductById(agentConfig, productId) : null;

  if (category) {
    const answer = sanitizeResponseText(
      buildPlaybookShortAnswer(agentConfig, productId, category),
    );
    return planBase(RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, {
      text: answer,
      next_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
      memory_patch: productContextMemoryPatch(memory, productId),
      quality_event_type: "turn_started",
      rag_allowed: false,
      plan_reason: planReason,
    });
  }

  const playbookAnswer = productId
    ? buildPlaybookShortAnswer(agentConfig, productId, "how_it_works")
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
    memory_patch: productContextMemoryPatch(memory, productId),
    quality_event_type: gateUsesRag(ragGate) ? "rag_retrieval_completed" : "turn_started",
    allowed_tools: gateUsesRag(ragGate) ? ["rag"] : [],
    rag_allowed: gateUsesRag(ragGate),
    plan_reason: planReason,
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
    const answer = sanitizeResponseText(
      buildPlaybookShortAnswer(agentConfig, productId, category)
    );
    return planBase(RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, {
      text: answer,
      next_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
      memory_patch: interruptionMemoryPatch(memory, productId),
      quality_event_type: "turn_started",
      rag_allowed: false
    });
  }

  if (substantive && productId) {
    const playbook =
      ragAnswer ??
      fallbackToPlaybook({ productId, transcript, agentConfig }).answer ??
      sanitizeResponseText(
        `${productName} unterstützt Sichtbarkeit und Anfragen. Was möchten Sie genau wissen?`
      );
    return planBase(RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, {
      text: sanitizeResponseText(playbook),
      next_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
      memory_patch: interruptionMemoryPatch(memory, productId),
      quality_event_type: gateUsesRag(ragGate) ? "rag_retrieval_completed" : "turn_started",
      allowed_tools: gateUsesRag(ragGate) ? ["rag"] : [],
      rag_allowed: gateUsesRag(ragGate)
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
  return Boolean(ragGate?.allowed);
}

export function buildResponsePlan({
  agentConfig,
  memory = {},
  stateMachine = {},
  transcript = "",
  intent = null,
  ragAnswer = null,
  ragGate = null,
  interruptionRecovery = null,
  closedDomain = null,
  interruptFollowupTimeout = false
} = {}) {
  const resolvedIntent = intent ?? detectTranscriptIntent(transcript, memory, agentConfig);
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
  const gate =
    ragGate ??
    shouldUseRagForTurn({ state, intent: resolvedIntent, memory, transcript });
  const postContactProductQa = isPostContactProductQuestion(memory, transcript, resolvedIntent);

  const closedDomainResolved =
    closedDomain ??
    resolveClosedDomainIntent({ agentConfig, transcript, memory });

  if (
    isScopedProductQaTurn(memory, transcript, closedDomainResolved) &&
    !interruptFollowupTimeout &&
    !shouldEnterSalesQualification(transcript, resolvedIntent)
  ) {
    return planScopedProductAnswer({
      agentConfig,
      memory,
      transcript,
      ragAnswer,
      ragGate: gate,
      planReason: interruptionRecovery ? "interrupt_scoped_product_qa" : "scoped_product_qa",
    });
  }

  if (resolvedIntent === "closing") {
    return planBase(RESPONSE_TYPES.CLOSING, {
      text: sanitizeResponseText(getWarmGoodbyeResponseText()),
      next_state: V4_STATES.COMPLETED,
      memory_patch: {
        current_state: V4_STATES.COMPLETED,
        call_closing: true,
        interruption_context: null
      },
      quality_event_type: "turn_started"
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
        quality_event_type: gateUsesRag(ragGate) ? "rag_retrieval_completed" : "turn_started",
        allowed_tools: gateUsesRag(ragGate) ? ["rag"] : [],
        rag_allowed: gateUsesRag(ragGate),
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
      ragGate: gate,
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
      quality_event_type: "rag_retrieval_completed",
      allowed_tools: ["rag"],
      rag_allowed: true,
      lead_transition_allowed: false
    });
  }

  if (resolvedIntent === "product_question") {
    const productId = memory.selected_product_id ?? matchProductAlias(agentConfig, transcript)?.id;
    const product = productId ? getProductById(agentConfig, productId) : null;
    const category = detectShortFollowUpCategory(transcript);
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
              ? `${product.display_name} unterstützt Sichtbarkeit und Anfragen. Möchten Sie mehr Details?`
              : "Gerne erkläre ich Ihnen unsere Lösungen. Welches Produkt interessiert Sie?"
          ));
    return planBase(RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, {
      text: answer,
      next_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
      memory_patch: {
        selected_product_id: productId ?? memory.selected_product_id,
        product_interest: productId ?? memory.product_interest,
        current_state: V4_STATES.ANSWERING_PRODUCT_QUESTION
      },
      quality_event_type: gate.allowed ? "rag_retrieval_completed" : "turn_started",
      allowed_tools: gate.allowed ? ["rag"] : [],
      rag_allowed: gate.allowed,
      lead_transition_allowed: false
    });
  }

  if (resolvedIntent === "product_selection") {
    const product = matchProductAlias(agentConfig, transcript);
    return planBase(RESPONSE_TYPES.COLLECT_SALES_CONTEXT, {
      text: sanitizeResponseText(
        product
          ? `Gern zu ${product.display_name}. Sind Sie Neukunde oder bestehender Kunde?`
          : "Welches Produkt interessiert Sie?"
      ),
      next_state: V4_STATES.COLLECTING_SALES_CONTEXT,
      memory_patch: {
        selected_product_id: product?.id ?? memory.selected_product_id,
        product_interest: product?.id ?? memory.product_interest,
        current_state: V4_STATES.COLLECTING_SALES_CONTEXT
      },
      quality_event_type: "turn_started"
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
        current_state: V4_STATES.VALIDATING_CONTACT
      },
      quality_event_type: "lead_skipped",
      lead_transition_allowed: false
    });
  }

  if (resolvedIntent === "contact_phone") {
    return planBase(RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION, {
      text: sanitizeResponseText("Darf unser Team Sie unter Ihrer Nummer zurückmelden?"),
      next_state: V4_STATES.COLLECTING_CALLBACK_PERMISSION,
      memory_patch: {
        contact_preference: "phone",
        current_state: V4_STATES.COLLECTING_CALLBACK_PERMISSION
      },
      quality_event_type: "turn_started"
    });
  }

  if (resolvedIntent === "callback_permission_granted" && memory?.contact_preference === "phone") {
    return planBase(RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION, {
      text: sanitizeResponseText("Vielen Dank. Ich prüfe kurz Ihre Kontaktdaten."),
      next_state: V4_STATES.VALIDATING_CONTACT,
      memory_patch: {
        callback_permission: "granted",
        current_state: V4_STATES.VALIDATING_CONTACT
      },
      quality_event_type: "turn_started",
      lead_transition_allowed: true
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
    text: sanitizeResponseText("Entschuldigung, das habe ich nicht ganz verstanden. Können Sie das bitte kurz wiederholen?"),
    next_state: V4_STATES.LISTENING,
    memory_patch: { current_state: V4_STATES.LISTENING },
    quality_event_type: "turn_started"
  });
}

export function applyMemoryPatch(memory, patch = {}) {
  if (!patch || typeof patch !== "object") return memory;
  return { ...memory, ...patch, updated_at: Date.now() };
}
