const ANONYMOUS_CALLER_PATTERNS = [
  /^anonymous$/i,
  /^withheld$/i,
  /^unknown$/i,
  /^private$/i,
  /^unavailable$/i,
  /^anonym$/i,
  /^anonyme$/i,
  /^unterdr[uü]ckt$/i,
  /^blocked$/i,
  /^restricted$/i
];

function normalizeToken(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCallerPhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const compact = raw.replace(/[^\d+]/g, "");
  if (!compact) return "";
  return compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
}

export function isAnonymousCallerPhone(raw, normalized) {
  const token = normalizeToken(raw || normalized);
  if (!token) return true;
  if (ANONYMOUS_CALLER_PATTERNS.some((pattern) => pattern.test(token))) return true;
  const digits = String(normalized || raw || "").replace(/\D/g, "");
  if (!digits) return true;
  if (/^0+$/.test(digits)) return true;
  return false;
}

export function hasUsableCallerId(ctx) {
  const normalized = normalizeCallerPhone(ctx?.callerPhoneNormalized || "");
  const raw = String(ctx?.callerPhoneRaw || "").trim();
  if (!normalized && !raw) return false;
  if (isAnonymousCallerPhone(raw, normalized || raw)) return false;
  const digits = (normalized || normalizeCallerPhone(raw)).replace(/\D/g, "");
  return digits.length >= 6;
}

export function callerIdForCallback(ctx) {
  const normalized = normalizeCallerPhone(ctx?.callerPhoneNormalized || "");
  if (normalized) return normalized;
  return normalizeCallerPhone(ctx?.callerPhoneRaw || "");
}
