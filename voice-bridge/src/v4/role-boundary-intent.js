/**
 * Phase 10AP — role boundary / safety intent detection (Conversation Priority Contract #2).
 *
 * Detects out-of-scope general questions, uncertain technical feasibility questions,
 * and explicit callback/lead-capture requests. Closing (contract #1) is resolved
 * earlier in transcript-intent.js and always wins.
 */

import { normalizeText } from "./redaction.js";
import { matchProductAlias } from "./agent-config.js";

const OUT_OF_SCOPE_PATTERNS = [
  /\bwer hat (die|das|den|der)\b/i,
  /\brelativit[aä]tstheorie\b/i,
  /\b(wer war|wann war|wann lebte|wann hat|geschichte von|hauptstadt von)\b/i,
  /\b(rechtsberatung|anwalt|medizinische beratung|medizinisch|diagnose|finanzberatung|steuerberater)\b/i,
  /\b(python tutorial|javascript lernen|programmieren lernen|code schreiben)\b/i,
  /\b(allgemeinwissen|wikipedia)\b/i,
];

const TECHNICAL_UNCERTAINTY_PATTERNS = [
  /\b(middleware|schnittstelle|sap|erp|crm|anbinden|verbinden|integrieren)\b/i,
  /\b(api|schnittstellen|technisch machbar|funktioniert das mit)\b/i,
  /\b(eigene middleware|custom integration|individuelle entwicklung)\b/i,
];

const TECHNOLOHIT_DOMAIN =
  /\b(smart website|digitale rezeption|voice agent|lokalki|botinteg|aiseoq|technolohit|ki lösung|ki loesung|firmenwebsite|telefonassistent)\b/i;

const NORMAL_PRODUCT_OR_PRICING =
  /\b(was ist|was sind|was macht|was kostet|preis|kosten|wie funktioniert|was kann|wie viel)\b/i;

const CALLBACK_REQUEST_PATTERNS = [
  /\b(zurückrufen|zurueckrufen|zuruckrufen|rückruf|rueckruf|ruckruf)\b/i,
  /\b(rückruf erhalten|zurückgerufen|mich zurückrufen|zurück melden lassen)\b/i,
  /\b(können sie mich|könnten sie mich|kann mich jemand)\b.*\b(zurück|rufen|melden)\b/i,
];

export function mentionsTechnoloHitProduct(transcript = "", agentConfig = null) {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  if (TECHNOLOHIT_DOMAIN.test(lower)) return true;
  if (agentConfig && matchProductAlias(agentConfig, transcript)?.id) return true;
  return false;
}

export function isNormalProductOrPricingQuestion(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  return NORMAL_PRODUCT_OR_PRICING.test(lower);
}

export function isOutOfScopeGeneralQuestion(transcript = "", agentConfig = null) {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  if (mentionsTechnoloHitProduct(transcript, agentConfig) && isNormalProductOrPricingQuestion(transcript)) {
    return false;
  }
  if (mentionsTechnoloHitProduct(transcript, agentConfig) && !OUT_OF_SCOPE_PATTERNS.some((p) => p.test(lower))) {
    return false;
  }
  return OUT_OF_SCOPE_PATTERNS.some((pattern) => pattern.test(lower));
}

export function isTechnicalEscalationQuestion(transcript = "", agentConfig = null) {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  const hasTechnicalUncertainty = TECHNICAL_UNCERTAINTY_PATTERNS.some((pattern) => pattern.test(lower));
  if (!hasTechnicalUncertainty) return false;
  if (isNormalProductOrPricingQuestion(transcript) && !/\b(middleware|sap|erp|schnittstelle|anbinden|verbinden|integrieren)\b/i.test(lower)) {
    return false;
  }
  return mentionsTechnoloHitProduct(transcript, agentConfig) || /\b(system|plattform|software)\b/i.test(lower);
}

export function isCallbackLeadCaptureRequest(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  return CALLBACK_REQUEST_PATTERNS.some((pattern) => pattern.test(lower));
}
