/**
 * Shared v4 transcript intent + response sanitization (no planner/RAG coupling).
 */

import { normalizeText } from "./redaction.js";

const NO_RUECKRUF = /\b(rückruf|rueckruf|ruckruf|zurückrufen|zurueckrufen|zuruckrufen)\b/i;

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
  if (/\b(preis|kosten|was kostet|pricing|tarif|gebühr|gebuehr)\b/i.test(lower)) {
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
