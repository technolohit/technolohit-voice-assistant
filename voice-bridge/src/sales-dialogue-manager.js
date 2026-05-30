/**
 * Sales dialogue stage transitions (one useful question per response).
 */

import {
  buildCustomerTypeResponse,
  buildHandoffOffer,
  buildNeedDiscoveryResponse,
  buildSalesProductExplanation,
  buildSalesProductPitch
} from "./sales-policy.js";
import {
  customerTypeMenuContext,
  interpretSemanticIntent,
  shouldAcceptSemanticIntent,
  shouldSoftConfirmSemanticIntent
} from "./semantic-intent.js";
import {
  applyRepairToResponse,
  ensureRepairState,
  isCustomerTypeMenuPrompt,
  PROMPT_KEYS,
  resolveCustomerTypeResponse
} from "./conversation-repair.js";
import { answerProductQuestionWithRag } from "./rag-sales-answerer.js";

export const SALES_STAGES = {
  INTEREST_DETECTED: "interest_detected",
  CONTEXT_IDENTIFICATION: "context_identification",
  VALUE_ANSWER: "value_answer",
  NEED_DISCOVERY: "need_discovery",
  HANDOFF_OFFER: "handoff_offer",
  CONTACT_CAPTURE: "contact_capture",
  MANUAL_REVIEW: "manual_review"
};

/** Maps legacy productDialogueState values to v3 sales stages. */
export function mapLegacyStage(productDialogueState) {
  switch (productDialogueState) {
    case "sales_customer_type":
      return SALES_STAGES.CONTEXT_IDENTIFICATION;
    case "sales_need_discovery":
      return SALES_STAGES.NEED_DISCOVERY;
    case "sales_handoff_offer":
      return SALES_STAGES.HANDOFF_OFFER;
    default:
      return SALES_STAGES.INTEREST_DETECTED;
  }
}

export function isV3SalesFlowEnabled(config) {
  return Boolean(config?.semanticIntent?.enabled || config?.conversationRepair?.enabled);
}

function normalizeHandoffText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Caller explicitly chooses phone callback (not customer-type wording). */
export function isExplicitPhoneHandoffRequest(callerText, intent) {
  if (intent === "contact_preference_phone" || intent === "callback_request") return true;
  const lower = normalizeHandoffText(callerText);
  return /\b(telefonisch|telefon|per telefon|am telefon|anrufen|ruckruf|rueckruf|zuruckrufen|zurueckrufen)\b/i.test(
    lower
  );
}

export function shouldDeferToPhoneIntake(productState, callerText, intent) {
  if (!isExplicitPhoneHandoffRequest(callerText, intent)) return false;
  const stage = productState?.salesContext?.sales_stage;
  return (
    productState?.productDialogueState === "sales_customer_type" ||
    stage === SALES_STAGES.VALUE_ANSWER ||
    stage === SALES_STAGES.CONTEXT_IDENTIFICATION
  );
}

function mergeSalesContext(productState, patch) {
  productState.salesContext = {
    ...(productState.salesContext || {}),
    ...patch
  };
}

export function buildInterestDetectedResponse(config, productId) {
  const pitch = buildSalesProductPitch(config, productId);
  return pitch || buildSalesProductExplanation(productId);
}

export async function handleSalesCustomerTypeTurn({
  config,
  productState,
  callerText,
  intent,
  turnIndex,
  normalizeResponse
}) {
  if (shouldDeferToPhoneIntake(productState, callerText, intent)) {
    return {
      deferToIntake: true,
      handoffChoice: "phone",
      detectedIntent: "contact_preference_phone",
      product: productState
    };
  }

  const productId = productState.selectedProduct;
  const repair = ensureRepairState(productState);
  const menuContext = {
    ...customerTypeMenuContext(),
    stage: SALES_STAGES.CONTEXT_IDENTIFICATION,
    productId,
    priorCustomerType: productState.customerType || productState.salesContext?.customer_type || null
  };

  const semantic = interpretSemanticIntent(callerText, menuContext, {
    minAccept: config?.semanticIntent?.minAccept,
    minSoft: config?.semanticIntent?.minSoft,
    mode: config?.semanticIntent?.mode
  });

  if (semantic.intent === "product_question" || intent === "product_more_detail_request") {
    const ragAnswer = await answerProductQuestionWithRag({
      config,
      callerText,
      productId,
      dialogueSummary: productState.salesContext?.current_problem || ""
    });
    const explanation = ragAnswer.answer || buildSalesProductExplanation(productId);
    const nextQ =
      ragAnswer.next_question || buildNeedDiscoveryPrompt(productId, productState.customerType || "new_prospect");
    const text = normalizeResponse(`${explanation} ${nextQ}`);
    productState.productDialogueState = "sales_customer_type";
    mergeSalesContext(productState, {
      sales_stage: SALES_STAGES.VALUE_ANSWER,
      last_semantic_intent: semantic.intent,
      rag_used: Boolean(ragAnswer.used_rag)
    });
    return {
      text,
      detectedIntent: "sales_product_explanation",
      finalResponseTemplate: ragAnswer.used_rag ? "rag_sales_answerer" : "sales_policy",
      product: productState,
      semantic
    };
  }

  const accept = shouldAcceptSemanticIntent(semantic, config);
  const softConfirm = shouldSoftConfirmSemanticIntent(semantic, config);
  const resolved = resolveCustomerTypeResponse({
    productState,
    productId,
    semanticResult: semantic,
    accept: accept && semantic.value !== "unknown",
    softConfirm,
    forceRepair: repair.customerTypeClarifications >= 1 && !accept
  });

  let customerType = resolved.inferredCustomerType;
  if (!customerType && accept) customerType = semantic.value;
  if (!customerType && resolved.usedFallback && semantic.value !== "unknown" && semantic.confidence >= 0.45) {
    customerType = semantic.value;
  }

  if (customerType && customerType !== "unknown") {
    productState.customerType = customerType;
    productState.productDialogueState = "sales_need_discovery";
    mergeSalesContext(productState, {
      customer_type: customerType,
      customer_type_confidence: semantic.confidence,
      customer_type_evidence: semantic.evidence,
      sales_stage: SALES_STAGES.NEED_DISCOVERY
    });
    const responseText = applyRepairToResponse(
      repair,
      resolved.promptKey,
      normalizeResponse(resolved.text)
    );
    return {
      text: responseText,
      detectedIntent: `sales_customer_type_${customerType}`,
      finalResponseTemplate: resolved.usedFallback ? "conversation_repair" : "sales_policy",
      product: productState,
      semantic
    };
  }

  const menuText = buildCustomerTypeResponse("unknown", productId);
  if (isCustomerTypeMenuPrompt(menuText) && repair.customerTypeClarifications >= 1) {
    const fallback = resolveCustomerTypeResponse({
      productState,
      productId,
      semanticResult: semantic,
      accept: false,
      softConfirm: false,
      forceRepair: true
    });
    const text = applyRepairToResponse(
      repair,
      fallback.promptKey,
      normalizeResponse(fallback.text)
    );
    mergeSalesContext(productState, { sales_stage: SALES_STAGES.CONTEXT_IDENTIFICATION });
    return {
      text,
      detectedIntent: "sales_customer_type_repair",
      finalResponseTemplate: "conversation_repair",
      product: productState,
      semantic
    };
  }

  const text = applyRepairToResponse(
    repair,
    PROMPT_KEYS.CUSTOMER_TYPE_MENU,
    normalizeResponse(menuText)
  );
  mergeSalesContext(productState, { sales_stage: SALES_STAGES.CONTEXT_IDENTIFICATION });
  return {
    text,
    detectedIntent: "sales_customer_type_reask",
    finalResponseTemplate: "sales_policy",
    product: productState,
    semantic
  };
}

function normalizeNeedText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isConcreteSalesUseCase(text) {
  const lower = normalizeNeedText(text);
  if (lower.length < 20) return false;
  return /\b(kunden|leads|anruf|assistent|sammeln|gesprach|gespraeche|website|telefon|erste fragen)\b/i.test(
    lower
  );
}

export function buildUseCaseReflection(callerText, productId) {
  const lower = normalizeNeedText(callerText);
  if (/\b(kunden|leads)\b/i.test(lower) && /\b(assistent|reden|anruf|sammeln)\b/i.test(lower)) {
    return "Verstanden, also soll der Assistent erste Gespräche führen und Leads vorbereiten.";
  }
  if (/\b(anruf|telefon|verpasst)\b/i.test(lower)) {
    return "Verstanden, es geht um bessere Erreichbarkeit und strukturierte Anrufannahme.";
  }
  return "Verstanden, das klingt nach einem klaren Einsatzziel für Ihr Unternehmen.";
}

export function buildChannelFollowUpQuestion(productId) {
  if (productId === "voice_agent") {
    return "Soll er eher auf Ihrer Website starten oder auch Telefonanfragen übernehmen?";
  }
  return "Was soll die Lösung bei Ihnen zuerst verbessern?";
}

export function wantsExplicitContactHandoff(callerText, intent) {
  if (intent === "contact_preference_phone" || intent === "contact_preference_email" || intent === "callback_request") {
    return true;
  }
  const lower = normalizeNeedText(callerText);
  if (/\b(website und telefon|webseite und telefon|sowohl website|beides|auf der website|auch telefon)\b/i.test(lower)) {
    return false;
  }
  return /\b(telefonisch bitte|telefonisch\.|per telefon|nur telefon|lieber telefon|per e-mail|e-mail bitte|kontaktieren lassen|ruckruf|rueckruf)\b/i.test(
    lower
  );
}

export function handleSalesNeedDiscoveryTurn({
  config,
  productState,
  callerText,
  intent,
  turnIndex,
  normalizeResponse
}) {
  const productId = productState.selectedProduct;
  const useCaseText = String(callerText || "").replace(/\s+/g, " ").trim().slice(0, 180);
  mergeSalesContext(productState, {
    current_problem: useCaseText,
    sales_stage: SALES_STAGES.NEED_DISCOVERY
  });

  if (wantsExplicitContactHandoff(callerText, intent)) {
    productState.salesNeedCaptured = true;
    productState.productDialogueState = "sales_handoff_offer";
    mergeSalesContext(productState, { sales_stage: SALES_STAGES.HANDOFF_OFFER });
    return {
      text: normalizeResponse(buildHandoffOffer(productId)),
      detectedIntent: "sales_handoff_offer",
      finalResponseTemplate: "sales_policy",
      product: productState
    };
  }

  const followUps = Number(productState.salesContext?.need_discovery_followups || 0);
  if (followUps < 1 && isConcreteSalesUseCase(callerText)) {
    productState.salesContext.need_discovery_followups = followUps + 1;
    productState.productDialogueState = "sales_need_discovery";
    const reflection = buildUseCaseReflection(callerText, productId);
    const followUp = buildChannelFollowUpQuestion(productId);
    return {
      text: normalizeResponse(`${reflection} ${followUp}`),
      detectedIntent: "sales_need_discovery_followup",
      finalResponseTemplate: "sales_policy",
      product: productState
    };
  }

  productState.salesNeedCaptured = true;
  productState.productDialogueState = "sales_handoff_offer";
  mergeSalesContext(productState, { sales_stage: SALES_STAGES.HANDOFF_OFFER });
  return {
    text: normalizeResponse(buildHandoffOffer(productId)),
    detectedIntent: "sales_handoff_offer",
    finalResponseTemplate: "sales_policy",
    product: productState
  };
}

export function buildNeedDiscoveryPrompt(productId, customerType) {
  return buildNeedDiscoveryResponse(productId, customerType || "new_prospect", "");
}
