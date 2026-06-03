/**
 * Shared v4 transcript intent + response sanitization (no planner/RAG coupling).
 */

import { normalizeText } from "./redaction.js";
import { matchProductAlias } from "./agent-config.js";
import { isGenericScopedProductQuestion } from "./product-context-persistence.js";

const NO_RUECKRUF = /\b(rückruf|rueckruf|ruckruf|zurückrufen|zurueckrufen|zuruckrufen)\b/i;

export function sanitizeResponseText(text) {
  const base = normalizeText(text);
  if (!base) return "";
  if (NO_RUECKRUF.test(base)) {
    return base.replace(NO_RUECKRUF, "Kontaktaufnahme");
  }
  return base;
}

const INTERRUPTION_FOLLOW_UP_PATTERNS = [
  /\b(stopp|stop)\b.*\b(kurze frage|noch eine frage)\b/i,
  /\b(kurze frage|noch eine frage|darf ich kurz fragen)\b/i,
  /\bich habe noch eine frage\b/i,
  /\bich habe eine frage\b/i
];

const TOPIC_REPAIR =
  /\b(warte|moment|nein)[,.]?\s*(ich )?(meine|meinte)|\b(stopp|stop)[,.]?\s*(ich )?(meine|meinte)\b/i;

const TOPIC_RESET_EXPLICIT =
  /\b(neues thema|anderes produkt|falsch|nicht das|vergiss das)\b/i;

const DEFINITE_GOODBYE =
  /\b(auf wiederh[oö]ren|auf wiedersehen|wiederh[oö]ren|wiedersehen|bis dann|nein danke|danke[, ]+das war alles|das war alles|das war'?s|das wars|keine frage mehr|tsch[uü]ss|tschuess|sch[oö]nen tag)\b/i;

export function isInterruptionFollowUpPhrase(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  return INTERRUPTION_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(lower));
}

export function isTopicRepairPhrase(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  return TOPIC_REPAIR.test(lower);
}

export function isExplicitTopicResetPhrase(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  return TOPIC_RESET_EXPLICIT.test(lower);
}

export function isDefiniteCallerGoodbye(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  if (DEFINITE_GOODBYE.test(lower)) return true;
  if (/^danke[.!]?$/.test(lower.trim())) return true;
  return false;
}

export function getWarmGoodbyeResponseText() {
  return "Vielen Dank für Ihren Anruf. Auf Wiederhören.";
}

export function detectTranscriptIntent(transcript = "", memory = {}, agentConfig = null) {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return "empty";

  if (isDefiniteCallerGoodbye(transcript) || memory?.call_closing) {
    return "closing";
  }

  const inInterruption = Boolean(memory?.interruption_context);

  if (agentConfig && isTopicRepairPhrase(transcript)) {
    const product = matchProductAlias(agentConfig, transcript);
    if (product?.id) return "product_selection";
    return "topic_repair";
  }

  if (inInterruption || isInterruptionFollowUpPhrase(transcript)) {
    if (isInterruptionFollowUpPhrase(transcript)) return "interruption_followup";
    if (isTopicRepairPhrase(transcript)) return "topic_repair";
  }

  if (/\b(stopp|stop)\b/i.test(lower) && !isInterruptionFollowUpPhrase(transcript)) {
    return "interruption_recovery";
  }

  if (/\b(was ist|was sind|erklar|erklaer|wie funktioniert|mehr uber|mehr ueber)\b/i.test(lower)) {
    return "product_question";
  }
  if (/\b(preis|kosten|was kostet|pricing|tarif|gebühr|gebuehr)\b/i.test(lower)) {
    return "product_question";
  }
  if (/\b(termin|termine|buchung|kann das auch)\b/i.test(lower)) {
    return "product_question";
  }
  if (/\b(smart website|digitale rezeption|voice agent|lokalki|botinteg|aiseoq)\b/i.test(lower)) {
    return "product_selection";
  }
  // Closed-domain product aliases are authoritative even when STT inserts
  // punctuation or inflects the product phrase (for example Smart-Webseite).
  if (agentConfig && matchProductAlias(agentConfig, transcript)?.id) {
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
  if (memory?.selected_product_id && isGenericScopedProductQuestion(transcript)) {
    return "product_question";
  }
  return "unclear";
}

export function isPricingOrProductQuestion(transcript = "", intent = null) {
  const resolved = intent ?? detectTranscriptIntent(transcript);
  if (resolved === "product_question") return true;
  const lower = normalizeText(transcript).toLowerCase();
  return /\b(preis|kosten|was kostet|pricing|tarif|gebühr|gebuehr)\b/i.test(lower);
}

export function isPostContactProductQuestion(memory = {}, transcript = "", intent = null) {
  if (!memory?.contact_preference) return false;
  return isPricingOrProductQuestion(transcript, intent);
}
