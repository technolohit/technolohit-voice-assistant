/**
 * Bounded v3 routing for direct questions when a product is already known.
 */

import { productPolicyById } from "../product-intake-policy.js";
import { buildSalesProductExplanation } from "../sales-policy.js";

const PRICING = /\b(preis|preise|kostet|kosten|teuer|budget|angebot)\b/i;
const EXPLANATION = /\b(wie funktioniert|wie geht das|was kann das|was macht das|erkl[aä]r|erklaer|details)\b/i;
const EXPLICIT_SALES_DISCUSSION =
  /\b(r[uü]ckruf|rueckruf|kontakt|anrufen|telefonisch|e-?mail|beratung|berater|projekt|umsetzung|implementierung|angebot erstellen|team sprechen)\b/i;

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function productName(productId) {
  return productPolicyById(productId)?.displayName || "die Lösung";
}

export function detectKnownProductQuestion(callerText, intent = "") {
  const text = normalize(callerText);
  if (!text) return null;
  if (intent === "pricing_question" || PRICING.test(text)) return "pricing";
  if (intent === "product_more_detail_request" || EXPLANATION.test(text)) return "explanation";
  return null;
}

export function callerExplicitlyRequestsSalesDiscussion(callerText, intent = "") {
  if (
    [
      "callback_request",
      "handoff_requested",
      "contact_preference_email",
      "contact_preference_phone"
    ].includes(intent)
  ) {
    return true;
  }
  return EXPLICIT_SALES_DISCUSSION.test(normalize(callerText));
}

export function buildKnownProductQuestionResponse({ productId, category } = {}) {
  if (!productId || !category) return null;
  const name = productName(productId);

  if (category === "pricing") {
    return {
      text: `${name} wird individuell nach Ziel und Umfang kalkuliert. Einen festen Preis kann ich ohne die Anforderungen nicht seriös nennen.`,
      detectedIntent: "pricing_question",
      finalResponseTemplate: "product_question_direct"
    };
  }

  const explanation = buildSalesProductExplanation(productId);
  return {
    text: explanation || `${name} unterstützt bei wiederkehrenden Fragen und der Vorbereitung von Anfragen.`,
    detectedIntent: "product_more_detail_request",
    finalResponseTemplate: "product_question_direct"
  };
}

export function routeKnownProductQuestion({
  callerText,
  intent,
  productId,
  normalizeResponse = (text) => text
} = {}) {
  if (!productId) return null;
  if (callerExplicitlyRequestsSalesDiscussion(callerText, intent)) return null;
  const category = detectKnownProductQuestion(callerText, intent);
  const response = buildKnownProductQuestionResponse({ productId, category });
  if (!response) return null;
  return {
    ...response,
    text: normalizeResponse(response.text),
    category
  };
}

function comparable(text) {
  return normalize(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordSet(text) {
  return new Set(comparable(text).split(" ").filter((word) => word.length > 2));
}

export function responsesAreNearDuplicate(a, b) {
  const left = comparable(a);
  const right = comparable(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const leftWords = wordSet(left);
  const rightWords = wordSet(right);
  if (!leftWords.size || !rightWords.size) return false;
  let overlap = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) overlap += 1;
  }
  return overlap / Math.min(leftWords.size, rightWords.size) >= 0.82;
}

export function preventRepeatedV3Response({
  responseText,
  previousAssistantText,
  productId,
  category,
  normalizeResponse = (text) => text
} = {}) {
  if (!responsesAreNearDuplicate(responseText, previousAssistantText)) {
    return { text: responseText, repeated: false };
  }
  const name = productName(productId);
  const replacement =
    category === "pricing"
      ? `Kurz gesagt: Der Preis für ${name} hängt vom gewünschten Umfang ab.`
      : `Gerne konkreter zu ${name}: Welche Funktion möchten Sie genau verstehen?`;
  return { text: normalizeResponse(replacement), repeated: true };
}
