/**
 * v4 deterministic response planner — mock/deterministic plans for canary orchestrator.
 */

import { normalizeText } from "./redaction.js";
import { matchProductAlias, getProductById, getClosingQuestion } from "./agent-config.js";
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
    ...overrides
  };
}

export function sanitizeResponseText(text) {
  const base = normalizeText(text);
  if (!base) return "";
  if (NO_RUECKRUF.test(base)) {
    return base.replace(NO_RUECKRUF, "Kontaktaufnahme");
  }
  return base;
}

export function detectTranscriptIntent(transcript = "", memory = {}) {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return "empty";
  if (/\b(stopp|stop|ich meine|ich meinte)\b/i.test(lower)) return "interruption_recovery";
  if (/\b(was ist|was sind|erklar|erklaer|wie funktioniert|mehr uber|mehr ueber)\b/i.test(lower)) {
    return "product_question";
  }
  if (/\b(smart website|digitale rezeption|voice agent|lokalki|botinteg|aiseoq)\b/i.test(lower)) {
    return "product_selection";
  }
  if (/\b(neukunde|neu kunde|bestandskunde|eigene firma|unternehmen)\b/i.test(lower)) {
    return "sales_customer_type";
  }
  if (/\b(e-?mail|email|per mail)\b/i.test(lower)) return "contact_email";
  if (/\b(telefon|telefonisch|anruf|anrufen)\b/i.test(lower)) return "contact_phone";
  if (/\b(ja|einverstanden|gerne|ok)\b/i.test(lower) && memory?.contact_preference) {
    return "callback_permission_granted";
  }
  if (/\b(danke|auf wiedersehen|tschüss|tschuess|das war alles)\b/i.test(lower)) return "closing";
  return "unclear";
}

export function buildResponsePlan({
  agentConfig,
  memory = {},
  stateMachine = {},
  transcript = "",
  intent = null,
  ragAnswer = null,
  interruptionRecovery = null
} = {}) {
  const resolvedIntent = intent ?? detectTranscriptIntent(transcript, memory);
  const agent = agentConfig?.config ?? agentConfig ?? {};
  const state = stateMachine?.state ?? memory?.current_state ?? V4_STATES.LISTENING;

  if (interruptionRecovery?.recoveryAction === "product_switch") {
    const product = getProductById(agentConfig, memory.selected_product_id);
    return planBase(RESPONSE_TYPES.INTERRUPTION_RECOVERY, {
      text: sanitizeResponseText(
        `Alles klar, wir wechseln zu ${product?.display_name ?? "Ihrem Thema"}. Wie kann ich Ihnen helfen?`
      ),
      next_state: V4_STATES.COLLECTING_SALES_CONTEXT,
      memory_patch: { current_state: V4_STATES.COLLECTING_SALES_CONTEXT },
      quality_event_type: "interruption_recovered",
      rag_allowed: false
    });
  }

  if (resolvedIntent === "greeting" || state === V4_STATES.GREETING) {
    return planBase(RESPONSE_TYPES.GREETING, {
      text: sanitizeResponseText("Willkommen bei TechnoloHit. Wobei kann ich Ihnen helfen?"),
      next_state: V4_STATES.LISTENING,
      memory_patch: { current_state: V4_STATES.LISTENING },
      quality_event_type: "call_started"
    });
  }

  if (resolvedIntent === "product_question") {
    const productId = memory.selected_product_id ?? matchProductAlias(agentConfig, transcript)?.id;
    const product = productId ? getProductById(agentConfig, productId) : null;
    const answer =
      ragAnswer ??
      sanitizeResponseText(
        product
          ? `${product.display_name} unterstützt Sichtbarkeit und Anfragen. Möchten Sie mehr Details?`
          : "Gerne erkläre ich Ihnen unsere Lösungen. Welches Produkt interessiert Sie?"
      );
    return planBase(RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, {
      text: answer,
      next_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
      memory_patch: {
        selected_product_id: productId ?? memory.selected_product_id,
        product_interest: productId ?? memory.product_interest,
        current_state: V4_STATES.ANSWERING_PRODUCT_QUESTION
      },
      quality_event_type: "rag_retrieval_completed",
      allowed_tools: ["rag"],
      rag_allowed: true,
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

  if (resolvedIntent === "closing") {
    return planBase(RESPONSE_TYPES.CLOSING, {
      text: sanitizeResponseText(getClosingQuestion(agentConfig)),
      next_state: V4_STATES.COMPLETED,
      memory_patch: { current_state: V4_STATES.COMPLETED },
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
