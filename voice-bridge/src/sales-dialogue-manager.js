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

export function handleSalesNeedDiscoveryTurn({ config, productState, callerText, turnIndex, normalizeResponse }) {
  productState.salesNeedCaptured = true;
  mergeSalesContext(productState, {
    current_problem: String(callerText || "").replace(/\s+/g, " ").trim().slice(0, 180),
    sales_stage: SALES_STAGES.HANDOFF_OFFER
  });
  productState.productDialogueState = "sales_handoff_offer";
  return {
    text: normalizeResponse(buildHandoffOffer(productState.selectedProduct)),
    detectedIntent: "sales_handoff_offer",
    finalResponseTemplate: "sales_policy",
    product: productState
  };
}

export function buildNeedDiscoveryPrompt(productId, customerType) {
  return buildNeedDiscoveryResponse(productId, customerType || "new_prospect", "");
}
