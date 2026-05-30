/**
 * Structured semantic intent interpretation (deterministic by default; LLM optional behind flags).
 */

const CUSTOMER_TYPE_VALUES = new Set(["new_prospect", "existing_customer", "agency_partner", "unknown"]);

const INTENT_FAMILIES = new Set([
  "product_interest",
  "product_question",
  "customer_type",
  "need_or_pain",
  "existing_customer_identifier",
  "contact_preference",
  "phone_number_candidate",
  "email_candidate",
  "permission",
  "unclear",
  "off_topic",
  "goodbye"
]);

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(text) {
  return normalize(text).replace(/[^a-z0-9]/g, "");
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function buildResult({
  intent,
  value = null,
  confidence,
  evidence,
  repair_needed = false,
  raw_text = ""
}) {
  const safeIntent = INTENT_FAMILIES.has(intent) ? intent : "unclear";
  const safeValue =
    intent === "customer_type" && CUSTOMER_TYPE_VALUES.has(value) ? value : value ?? null;
  return {
    intent: safeIntent,
    value: safeValue,
    confidence: clampConfidence(confidence),
    evidence: String(evidence || "").slice(0, 280),
    repair_needed: Boolean(repair_needed),
    raw_text: String(raw_text || "").slice(0, 220)
  };
}

function hasCustomerTypeMenuContext(context) {
  const offered = context?.previousOptionsOffered;
  return (
    Array.isArray(offered) &&
    offered.includes("new_prospect") &&
    offered.includes("agency_partner") &&
    offered.includes("existing_customer")
  );
}

function scoreNewProspect(normalized, compactText) {
  if (
    /\b(eigenes unternehmen|eigenes business|eigene firma|meine firma|mein unternehmen|meine eigenen? unternehmen|mein eigenes unternehmen|unser unternehmen|fur mein unternehmen|fuer mein unternehmen|fur meine firma|fuer meine firma|neues projekt|startup|selbst)\b/i.test(
      normalized
    )
  ) {
    return { value: "new_prospect", confidence: 0.88, evidence: "Explicit own-company wording." };
  }
  if (
    compactText.includes("eigenunternehmen") ||
    /^eigene?\s*unternehmen?$/i.test(normalized) ||
    compactText === "eigenunternehmen" ||
    compactText.includes("eigeneunternehmen")
  ) {
    return {
      value: "new_prospect",
      confidence: 0.82,
      evidence: "ASR variant likely means own company (e.g. Eigenunternehmen / Eigene Unternehmen)."
    };
  }
  if (compactText.includes("meinefirma") || compactText.includes("furmeinefirma") || compactText.includes("fuermein")) {
    return { value: "new_prospect", confidence: 0.78, evidence: "Caller refers to their own business." };
  }
  return null;
}

function scoreAgencyPartner(normalized, compactText) {
  if (
    /\b(kundenprojekt|kunden projekt|fur kunden|fuer kunden|agentur|agency|it dienstleister|webagentur|kunde von mir)\b/i.test(
      normalized
    ) ||
    compactText.includes("kundenprojekt") ||
    compactText.includes("kundenpro") ||
    compactText.includes("kundprojekt") ||
    compactText.includes("konnendannprojekt")
  ) {
    return { value: "agency_partner", confidence: 0.86, evidence: "Customer-project or agency wording." };
  }
  if (compactText.includes("kundenproj") || compactText.includes("agentur")) {
    return {
      value: "agency_partner",
      confidence: 0.68,
      evidence: "Rough STT fragment likely means customer project."
    };
  }
  return null;
}

function scoreExistingCustomer(normalized) {
  if (
    /\b(schon kunde|bereits kunde|bestandskunde|kunde bei ihnen|kundennummer|kunden nummer)\b/i.test(normalized)
  ) {
    return { value: "existing_customer", confidence: 0.9, evidence: "Existing-customer signal." };
  }
  return null;
}

function scoreOrdinalChoice(normalized, context) {
  if (!hasCustomerTypeMenuContext(context)) return null;
  if (/^(die\s*)?(erste|erster|eins|1)\b/i.test(normalized)) {
    return { value: "new_prospect", confidence: 0.84, evidence: "Ordinal first option after customer-type menu." };
  }
  if (/^(die\s*)?(zweite|zweiter|zwei|2)\b/i.test(normalized)) {
    return { value: "agency_partner", confidence: 0.84, evidence: "Ordinal second option after customer-type menu." };
  }
  if (/^(die\s*)?(dritte|dritter|drei|3)\b/i.test(normalized)) {
    return {
      value: "existing_customer",
      confidence: 0.84,
      evidence: "Ordinal third option after customer-type menu."
    };
  }
  return null;
}

function isProductExplanationRequest(normalized, compactText) {
  return (
    /\b(erklar|erklaer|erklarung|erklaerung|kurze erklarung|kurze erklaerung|mehr dazu|was bringt|was ist das|wie funktioniert)\b/i.test(
      normalized
    ) ||
    compactText.includes("kurzeerklaerung") ||
    compactText.includes("kurzerklaerung")
  );
}

export function validateSemanticIntentResult(result) {
  if (!result || typeof result !== "object") throw new Error("semantic intent: result must be an object");
  if (!INTENT_FAMILIES.has(result.intent)) throw new Error(`semantic intent: invalid intent ${result.intent}`);
  if (result.intent === "customer_type" && !CUSTOMER_TYPE_VALUES.has(result.value)) {
    throw new Error(`semantic intent: invalid customer_type value ${result.value}`);
  }
  const confidence = Number(result.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("semantic intent: confidence must be between 0 and 1");
  }
}

/**
 * @param {string} callerText
 * @param {{ stage?: string, productId?: string, previousOptionsOffered?: string[], priorCustomerType?: string|null }} context
 * @param {{ minAccept?: number, minSoft?: number, mode?: string }} options
 */
export function interpretSemanticIntent(callerText, context = {}, options = {}) {
  const normalized = normalize(callerText);
  const compactText = compact(callerText);
  const minAccept = Number.isFinite(options.minAccept) ? options.minAccept : 0.75;
  const minSoft = Number.isFinite(options.minSoft) ? options.minSoft : 0.45;

  if (!normalized) {
    return buildResult({
      intent: "unclear",
      confidence: 0,
      evidence: "Empty transcript.",
      repair_needed: true,
      raw_text: callerText
    });
  }

  if (isProductExplanationRequest(normalized, compactText)) {
    return buildResult({
      intent: "product_question",
      value: "explanation",
      confidence: 0.8,
      evidence: "Caller asked for a short product explanation.",
      raw_text: callerText
    });
  }

  const ordinal = scoreOrdinalChoice(normalized, context);
  const existing = scoreExistingCustomer(normalized);
  const agency = scoreAgencyPartner(normalized, compactText);
  const ownCompany = scoreNewProspect(normalized, compactText);

  const ranked = [ordinal, existing, agency, ownCompany].filter(Boolean).sort((a, b) => b.confidence - a.confidence);
  const best = ranked[0];

  if (best) {
    const repair_needed = best.confidence < minSoft;
    return buildResult({
      intent: "customer_type",
      value: best.value,
      confidence: best.confidence,
      evidence: best.evidence,
      repair_needed: repair_needed || (best.confidence >= minSoft && best.confidence < minAccept),
      raw_text: callerText
    });
  }

  return buildResult({
    intent: "unclear",
    value: "unknown",
    confidence: 0.35,
    evidence: "No reliable customer-type signal in transcript.",
    repair_needed: true,
    raw_text: callerText
  });
}

export function shouldAcceptSemanticIntent(result, config) {
  const minAccept = Number(config?.semanticIntent?.minAccept ?? 0.75);
  return Number(result?.confidence) >= minAccept;
}

export function shouldSoftConfirmSemanticIntent(result, config) {
  const minAccept = Number(config?.semanticIntent?.minAccept ?? 0.75);
  const minSoft = Number(config?.semanticIntent?.minSoft ?? 0.45);
  const confidence = Number(result?.confidence ?? 0);
  return confidence >= minSoft && confidence < minAccept;
}

export function customerTypeMenuContext() {
  return {
    previousOptionsOffered: ["new_prospect", "agency_partner", "existing_customer"]
  };
}
