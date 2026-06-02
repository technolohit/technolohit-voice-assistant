/**
 * Phase 10P — closed-domain fuzzy intent for TechnoloHit v4 canary (no hallucination).
 */

import { normalizeText } from "./redaction.js";
import { matchProductAlias, getProductById } from "./agent-config.js";
import { detectShortFollowUpCategory } from "./playbook-short-answer.js";
import { isDefiniteCallerGoodbye, isInterruptionFollowUpPhrase } from "./transcript-intent.js";

const PRODUCT_SYNONYMS = [
  {
    id: "voice_agent",
    patterns: [
      /\b(digitale rezeption|digital reception|digitaler telefonassistent|telefonassistent|voice agent|voice assistant|ki rezeption|ki telefonassistent|ai voice)\b/i
    ]
  },
  {
    id: "smart_website",
    patterns: [
      /\b(smart website|smart webseite|intelligente website|intelligente webseite|webseite|website|homepage)\b/i
    ]
  },
  {
    id: "lokalki",
    patterns: [/\b(lokalki|lokal ki|private ki|interne dokumente)\b/i]
  },
  {
    id: "botinteg",
    patterns: [/\b(botinteg|bot integ|chatbot|ki chatbot)\b/i]
  },
  {
    id: "aiseoq",
    patterns: [/\b(aiseoq|seo tool|suchmaschinenoptimierung)\b/i]
  }
];

const INTENT_PATTERNS = [
  { intent: "pricing", weight: 0.9, patterns: [/\b(preis|kosten|was kostet|tarif|geb[uü]hr)\b/i] },
  {
    intent: "capability",
    weight: 0.85,
    patterns: [/\b(wie funktioniert|was kann|kann das|termin|termine|buchung)\b/i]
  },
  { intent: "contact", weight: 0.8, patterns: [/\b(e-?mail|telefon|ansprechpartner|kontakt)\b/i] },
  {
    intent: "goodbye",
    weight: 0.95,
    patterns: [/\b(auf wiederh[oö]ren|danke|das war|keine frage mehr|tsch[uü]ss)\b/i]
  },
  {
    intent: "interruption_followup",
    weight: 0.7,
    patterns: [/\b(stopp|stop|moment|warte|kurze frage)\b/i]
  }
];

function scorePatterns(text, patterns, weight) {
  let score = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) score = Math.max(score, weight);
  }
  return score;
}

function scoreProductFromSynonyms(lower) {
  let best = { id: null, confidence: 0 };
  for (const entry of PRODUCT_SYNONYMS) {
    const score = scorePatterns(lower, entry.patterns, 0.88);
    if (score > best.confidence) {
      best = { id: entry.id, confidence: score };
    }
  }
  return best;
}

export function resolveClosedDomainIntent({
  agentConfig = null,
  transcript = "",
  memory = {}
} = {}) {
  const lower = normalizeText(transcript).toLowerCase();
  const empty = {
    intent: "empty",
    intent_confidence: 0,
    matched_product: memory?.selected_product_id ?? null,
    product_confidence: memory?.selected_product_id ? 0.6 : 0,
    is_low_confidence: true,
    clarification_type: "empty_transcript"
  };

  if (!lower) return empty;

  if (isDefiniteCallerGoodbye(transcript)) {
    return {
      intent: "goodbye",
      intent_confidence: 0.95,
      matched_product: memory?.selected_product_id ?? null,
      product_confidence: memory?.selected_product_id ? 0.6 : 0,
      is_low_confidence: false,
      clarification_type: null
    };
  }

  const aliasProduct = agentConfig ? matchProductAlias(agentConfig, transcript) : null;
  const synonymProduct = scoreProductFromSynonyms(lower);
  let matched_product = aliasProduct?.id ?? synonymProduct.id ?? memory?.selected_product_id ?? null;
  let product_confidence = aliasProduct ? 0.92 : synonymProduct.confidence;
  if (!matched_product && memory?.selected_product_id) {
    matched_product = memory.selected_product_id;
    product_confidence = Math.max(product_confidence, 0.55);
  }

  let intent = "product_question";
  let intent_confidence = 0.5;

  const category = detectShortFollowUpCategory(transcript);
  if (category === "pricing") {
    intent = "pricing";
    intent_confidence = 0.9;
  } else if (category === "appointment" || category === "capability") {
    intent = "capability";
    intent_confidence = 0.85;
  } else if (category === "email" || category === "handoff") {
    intent = "contact";
    intent_confidence = 0.8;
  } else {
    for (const entry of INTENT_PATTERNS) {
      const score = scorePatterns(lower, entry.patterns, entry.weight);
      if (score > intent_confidence) {
        intent = entry.intent;
        intent_confidence = score;
      }
    }
  }

  if (isInterruptionFollowUpPhrase(transcript) && intent_confidence < 0.75) {
    intent = "interruption_followup";
    intent_confidence = 0.72;
  }

  const is_low_confidence = intent_confidence < 0.55 && !matched_product;
  let clarification_type = null;
  if (is_low_confidence) {
    clarification_type = "domain_clarification";
  } else if (intent_confidence < 0.65 && matched_product && !aliasProduct && synonymProduct.confidence < 0.7) {
    clarification_type = "product_confirm";
  } else if (intent === "pricing" && intent_confidence >= 0.7) {
    clarification_type = null;
  }

  return {
    intent,
    intent_confidence: Number(intent_confidence.toFixed(2)),
    matched_product,
    product_confidence: Number(product_confidence.toFixed(2)),
    is_low_confidence,
    clarification_type
  };
}

export function buildLowConfidenceClarificationText(domain, agentConfig) {
  const productId = domain?.matched_product;
  const product = productId ? getProductById(agentConfig, productId) : null;
  const name = product?.display_name ?? null;

  if (domain?.clarification_type === "product_confirm" && name) {
    return `Meinen Sie ${name}?`;
  }
  if (domain?.intent === "pricing" && domain.intent_confidence >= 0.55) {
    return "Habe ich richtig verstanden, dass Sie nach den Kosten fragen?";
  }
  if (name) {
    return `Geht es um ${name} oder ein anderes TechnoloHit-Produkt?`;
  }
  return "Geht es um die Digitale Rezeption, die Smart Website oder ein anderes Produkt?";
}

export function closedDomainQualityPayload(domain, memory = {}) {
  if (!domain) return {};
  return {
    intent_confidence: domain.intent_confidence ?? null,
    product_confidence: domain.product_confidence ?? null,
    matched_product: domain.matched_product ?? null,
    previous_product_context: memory?.interruption_context?.interrupted_product_id ?? memory?.product_interest ?? null,
    current_product_context: memory?.selected_product_id ?? domain.matched_product ?? null,
    low_confidence_clarification: domain.is_low_confidence ? domain.clarification_type ?? true : null,
    closed_domain_intent: domain.intent ?? null
  };
}
