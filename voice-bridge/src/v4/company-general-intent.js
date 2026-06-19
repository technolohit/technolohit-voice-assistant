/**
 * Phase 10F — deterministic company-general intent detection.
 */

import { normalizeText } from "./redaction.js";

const COMPANY_GENERAL_PATTERNS = [
  /\bwas\s+macht\s+technolohit\b/i,
  /\bwas\s+bietet\s+technolohit\b/i,
  /\bwas\s+machen\s+sie\s+genau\b/i,
  /\bwelche\s+l[oö]sungen\s+bieten\s+sie\b/i,
  /\bwas\s+ist\s+technolohit\b/i,
  /\bwer\s+ist\s+technolohit\b/i,
  /\bwas\s+macht\s+ihr\s+unternehmen\b/i,
  /\bwas\s+bieten\s+sie\s+an\b/i,
];

const PRODUCT_NAME_HINT =
  /\b(smart\s*website|smart\s*webseite|digitale\s+rezeption|voice\s+agent|aiseoq|lokalki|botinteg)\b/i;

export function isCompanyGeneralQuestion(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  if (PRODUCT_NAME_HINT.test(lower)) return false;
  return COMPANY_GENERAL_PATTERNS.some((pattern) => pattern.test(lower));
}
