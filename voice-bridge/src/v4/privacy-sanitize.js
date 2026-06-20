/**
 * v4 outbound privacy — mask/redact before quality events, RAG, notifications.
 */

import { redactPhoneLikeText, normalizeText } from "./redaction.js";

const PHONE_LIKE = /\b(\+?\d[\d\s\-()/]{5,}\d)\b/;
const SKIP_PHONE_SCAN_KEYS = new Set([
  "created_at",
  "updated_at",
  "turn_count",
  "knowledge_version",
  "agent_config_version",
  "prompt_playbook_version",
  "runtime_version",
  "idempotency_key"
]);

export function maskPhoneForExternal(phone = "") {
  const text = normalizeText(phone);
  if (!text) return "";
  const prefix = text.startsWith("+") ? "+" : "";
  const digits = text.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length <= 7) {
    return digits.length >= 2 ? `${prefix}${digits.slice(0, 2)} ****` : "";
  }
  const firstLen = prefix ? 3 : 4;
  return `${prefix}${digits.slice(0, firstLen)} **** ${digits.slice(-3)}`;
}

export function sanitizeOutboundString(value) {
  return redactPhoneLikeText(normalizeText(value));
}

export function sanitizeOutboundObject(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeOutboundString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeOutboundObject(item, depth + 1));
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SKIP_PHONE_SCAN_KEYS.has(key)) {
      out[key] = child;
      continue;
    }
    if (/^(caller_phone|phone_number|caller_phone_raw|caller_phone_normalized)$/i.test(key)) {
      out[key] =
        typeof child === "string" ? maskPhoneForExternal(child) || "[phone_redacted]" : "[phone_redacted]";
      continue;
    }
    if (/email|transcript|utterance/i.test(key) && typeof child === "string") {
      out[key] = sanitizeOutboundString(child);
      continue;
    }
    out[key] = sanitizeOutboundObject(child, depth + 1);
  }
  return out;
}

function containsRawPhone(value, key = "") {
  if (SKIP_PHONE_SCAN_KEYS.has(key)) return false;
  if (typeof value === "boolean" || typeof value === "number") return false;
  if (typeof value === "string") {
    if (value.includes("[phone_redacted]") || value.includes("****")) return false;
    return PHONE_LIKE.test(value);
  }
  if (Array.isArray(value)) return value.some((item) => containsRawPhone(item, key));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([childKey, childValue]) => containsRawPhone(childValue, childKey));
  }
  return false;
}

export function assertNoRawPhoneInPayload(payload = {}) {
  return !containsRawPhone(payload);
}

function containsKnownSpokenPhoneSequence(value, sequences = [], key = "") {
  if (SKIP_PHONE_SCAN_KEYS.has(key)) return false;
  const normalizedSequences = sequences
    .map((sequence) => normalizeText(sequence).toLowerCase())
    .filter(Boolean);
  if (normalizedSequences.length === 0) return false;
  if (typeof value === "string") {
    const text = normalizeText(value).toLowerCase();
    return normalizedSequences.some((sequence) => text.includes(sequence));
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsKnownSpokenPhoneSequence(item, normalizedSequences, key));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).some(([childKey, childValue]) =>
      containsKnownSpokenPhoneSequence(childValue, normalizedSequences, childKey)
    );
  }
  return false;
}

export function assertNoKnownSpokenPhoneInPayload(payload = {}, sequences = []) {
  return !containsKnownSpokenPhoneSequence(payload, sequences);
}

export function buildPostCallIdempotencyKey(ctx, summary, leadResult) {
  const callSessionId = normalizeText(ctx?.callSessionId);
  const summaryId = normalizeText(summary?.summaryId);
  const leadAction = normalizeText(leadResult?.action) || "skipped";
  const leadId = normalizeText(leadResult?.leadId);
  return [callSessionId, summaryId, leadAction, leadId].filter(Boolean).join(":");
}
