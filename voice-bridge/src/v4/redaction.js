/**
 * Shared redaction helpers for v4 memory, quality events, and persistence.
 */

const PHONE_LIKE = /\b(\+?\d[\d\s\-()/]{5,}\d)\b/g;

export function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function redactPhoneLikeText(text) {
  const base = normalizeText(text);
  if (!base) return "";
  return base.replace(PHONE_LIKE, "[phone_redacted]");
}

export function sanitizeCustomFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    if (typeof value === "string") {
      out[key] = redactPhoneLikeText(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "object" && !Array.isArray(value)) {
      out[key] = sanitizeCustomFields(value);
    }
  }
  return out;
}
