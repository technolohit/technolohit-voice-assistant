/**
 * Conversation repair: prevent clarification loops and recover gracefully.
 */

import {
  buildCustomerTypeResponse,
  buildNeedDiscoveryResponse,
  buildSalesProductExplanation
} from "./sales-policy.js";

export const PROMPT_KEYS = {
  CUSTOMER_TYPE_MENU: "customer_type_menu",
  CUSTOMER_TYPE_REPAIR: "customer_type_repair",
  GENERAL_SALES_FALLBACK: "general_sales_fallback"
};

const CUSTOMER_TYPE_MENU_SNIPPET =
  "eigenes unternehmen, kundenprojekt oder bereits kunde";

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function promptFingerprint(text) {
  return normalize(text).replace(/[^a-z0-9]/g, "").slice(0, 120);
}

export function isCustomerTypeMenuPrompt(text) {
  return normalize(text).includes(CUSTOMER_TYPE_MENU_SNIPPET);
}

export function createRepairState() {
  return {
    lastPromptKey: null,
    lastPromptFingerprint: "",
    customerTypeClarifications: 0,
    lastCustomerTypeAttempt: null
  };
}

export function ensureRepairState(productState) {
  if (!productState.repair) productState.repair = createRepairState();
  return productState.repair;
}

export function wouldRepeatPrompt(repairState, promptKey, responseText) {
  if (!repairState) return false;
  const fingerprint = promptFingerprint(responseText);
  return (
    repairState.lastPromptKey === promptKey &&
    repairState.lastPromptFingerprint === fingerprint &&
    fingerprint.length > 0
  );
}

export function recordPrompt(repairState, promptKey, responseText) {
  if (!repairState) return;
  repairState.lastPromptKey = promptKey;
  repairState.lastPromptFingerprint = promptFingerprint(responseText);
  if (promptKey === PROMPT_KEYS.CUSTOMER_TYPE_MENU || promptKey === PROMPT_KEYS.CUSTOMER_TYPE_REPAIR) {
    repairState.customerTypeClarifications += 1;
  }
}

export function buildCustomerTypeRepairResponse({ customerType, productId, softConfirm = false }) {
  const productName =
    productId === "voice_agent" ? "dem AI Assistant" : "der Lösung";
  if (customerType === "new_prospect") {
    if (softConfirm) {
      return `Ich nehme an, es geht um Ihr eigenes Unternehmen. Was möchten Sie mit ${productName} verbessern: weniger verpasste Anrufe, bessere Lead-Erfassung oder schnellere Antworten?`;
    }
    return `Alles klar, ich ordne das als eigenes Unternehmen ein. Was möchten Sie mit ${productName} verbessern?`;
  }
  if (customerType === "agency_partner") {
    if (softConfirm) {
      return "Ich nehme an, es geht um ein Kundenprojekt. Was soll die Lösung für Ihre Kunden konkret verbessern?";
    }
    return "Verstanden, ein Kundenprojekt. Was soll die Lösung für Ihre Kunden konkret verbessern?";
  }
  if (customerType === "existing_customer") {
    return "Alles klar. Können Sie mir kurz den Firmennamen oder Ihre Kundennummer nennen, damit unser Team die Anfrage zuordnen kann?";
  }
  return buildCustomerTypeResponse("unknown", productId);
}

export function buildGeneralSalesFallback(productId) {
  const explanation = buildSalesProductExplanation(productId);
  const prefix = explanation ? `${explanation} ` : "";
  return `${prefix}Kein Problem. Geht es bei Ihnen eher um Website, Telefonassistent oder Automatisierung?`;
}

/**
 * Pick assistant text for customer-type stage with loop prevention.
 */
export function resolveCustomerTypeResponse({
  productState,
  productId,
  semanticResult,
  accept,
  softConfirm,
  forceRepair = false
}) {
  const repair = ensureRepairState(productState);
  const customerType = semanticResult?.value || "unknown";
  const clarifications = repair.customerTypeClarifications;

  let promptKey = PROMPT_KEYS.CUSTOMER_TYPE_MENU;
  let text = "";

  if (accept && customerType !== "unknown") {
    text = buildCustomerTypeRepairResponse({ customerType, productId, softConfirm });
    promptKey = softConfirm ? PROMPT_KEYS.CUSTOMER_TYPE_REPAIR : PROMPT_KEYS.CUSTOMER_TYPE_REPAIR;
  } else if (clarifications >= 1 || forceRepair) {
    if (productState?.selectedProduct && semanticResult?.intent !== "unclear") {
      text = buildNeedDiscoveryResponse(productId, "new_prospect", "");
      promptKey = PROMPT_KEYS.GENERAL_SALES_FALLBACK;
      return { text, promptKey, inferredCustomerType: "new_prospect", usedFallback: true };
    }
    text = buildGeneralSalesFallback(productId);
    promptKey = PROMPT_KEYS.GENERAL_SALES_FALLBACK;
    return { text, promptKey, inferredCustomerType: null, usedFallback: true };
  } else {
    text = buildCustomerTypeResponse("unknown", productId);
    promptKey = PROMPT_KEYS.CUSTOMER_TYPE_MENU;
  }

  if (wouldRepeatPrompt(repair, promptKey, text)) {
    const fallback = buildGeneralSalesFallback(productId);
    return {
      text: fallback,
      promptKey: PROMPT_KEYS.GENERAL_SALES_FALLBACK,
      inferredCustomerType: accept ? customerType : null,
      usedFallback: true,
      avoidedRepeat: true
    };
  }

  return {
    text,
    promptKey,
    inferredCustomerType: accept ? customerType : null,
    usedFallback: false,
    avoidedRepeat: false
  };
}

export function applyRepairToResponse(repairState, promptKey, responseText) {
  recordPrompt(repairState, promptKey, responseText);
  return responseText;
}
