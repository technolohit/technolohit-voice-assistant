/**
 * Deterministic human-contact / named-person intent (v3).
 *
 * Maps bounded German person-contact requests to existing `handoff_requested`
 * soft-intake path. Does not extract, validate, persist, or log employee names.
 * Does not claim live transfer or invent an employee directory.
 */

import { PRODUCT_INTAKE_POLICY } from "./product-intake-policy.js";

function normalizeHumanContactText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[’'`´]/g, "")
    .replace(/[!?.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Product tokens derived from authoritative PRODUCT_INTAKE_POLICY aliases /
 * display names — not a manually duplicated expanding product list.
 */
function buildProductAliasTokens() {
  const tokens = new Set();
  for (const policy of Object.values(PRODUCT_INTAKE_POLICY)) {
    const phrases = [...(policy.aliases || []), policy.displayName].filter(Boolean);
    for (const phrase of phrases) {
      const norm = normalizeHumanContactText(phrase);
      for (const part of norm.split(/\s+/)) {
        if (part.length >= 2) tokens.add(part);
      }
    }
  }
  return tokens;
}

const PRODUCT_ALIAS_TOKENS = buildProductAliasTokens();

/**
 * Small fixed set of generic non-person role / filler tokens for titleless
 * paths only. Product aliases come from PRODUCT_INTAKE_POLICY above.
 */
const GENERIC_NON_PERSON_TOKENS = new Set([
  "kunden",
  "neukunden",
  "produkt",
  "produkte",
  "preis",
  "preise",
  "angebot",
  "projekt",
  "kundenprojekt",
  "firma",
  "unternehmen",
  "team",
  "mitarbeiter",
  "mitarbeitern",
  "menschen",
  "mensch",
  "person",
  "personen",
  "jemandem",
  "jemand",
  "ihnen",
  "uns",
  "mir",
  "dir",
  "euch",
  "dem",
  "den",
  "der",
  "die",
  "das",
  "einem",
  "einen",
  "einer",
  "eine",
  "ein",
  "technolohit",
  "support",
  "service",
  "interesse",
  "ranking",
]);

const SPEAK_VERB =
  "(sprechen|reden|unterhalten|erreichen|kontaktieren|verbinden|rufen|anrufen|melden)";

const TITLE = "(herrn|herr|frau|fraeulein)";

const NAME_TOKEN = "([a-z][a-z-]{1,30})";

function isPlausibleTitlelessNameToken(token) {
  const value = String(token || "").toLowerCase();
  if (!value || value.length < 2) return false;
  if (/^(herrn|herr|frau|fraeulein)$/.test(value)) return false;
  if (PRODUCT_ALIAS_TOKENS.has(value)) return false;
  if (GENERIC_NON_PERSON_TOKENS.has(value)) return false;
  return true;
}

/**
 * Generic human / team contact phrases (existing v3 behavior).
 */
export function isGenericHumanContactRequest(text) {
  const lower = normalizeHumanContactText(text);
  if (!lower) return false;
  return /\b(mit jemandem sprechen|mit einem menschen sprechen|mit einem mensch sprechen|einen menschen sprechen|einen mitarbeiter sprechen|mitarbeiter sprechen|team sprechen|geben sie das bitte weiter|geben sie es bitte weiter|team soll sich melden|jemand soll sich melden|kann mich jemand zuruckrufen|kann mich jemand zurueckrufen)\b/i.test(
    lower
  );
}

/**
 * Bounded named-person / title+name contact requests.
 * Names are matched only to classify intent — never returned or logged.
 */
export function isNamedPersonContactRequest(text) {
  const lower = normalizeHumanContactText(text);
  if (!lower) return false;

  // 1) Herr/Frau + name + speak/connect verb
  if (
    new RegExp(
      `\\b(mit|zu)\\s+${TITLE}\\s+${NAME_TOKEN}\\b.*\\b${SPEAK_VERB}\\b`,
      "i"
    ).test(lower) ||
    new RegExp(`\\b${TITLE}\\s+${NAME_TOKEN}\\b.*\\b${SPEAK_VERB}\\b`, "i").test(lower) ||
    new RegExp(
      `\\b${SPEAK_VERB}\\b.*\\b(mit|zu)\\s+${TITLE}\\s+${NAME_TOKEN}\\b`,
      "i"
    ).test(lower)
  ) {
    return true;
  }

  // Title without surname: "mit dem Herrn sprechen"
  if (
    /\b(mit|zu)\s+(dem\s+herrn|der\s+frau)\b.*\b(sprechen|reden|unterhalten|erreichen|kontaktieren|verbinden)\b/i.test(
      lower
    ) ||
    /\b(sprechen|reden|unterhalten|erreichen|kontaktieren|verbinden)\b.*\b(mit|zu)\s+(dem\s+herrn|der\s+frau)\b/i.test(
      lower
    )
  ) {
    return true;
  }

  // 2) Titleless first + surname (two plausible name tokens)
  // Example: "Ich möchte mit Martin Neumann sprechen."
  const twoToken = lower.match(
    new RegExp(
      `\\b(?:mit|zu)\\s+${NAME_TOKEN}\\s+${NAME_TOKEN}\\b(?:\\s+\\w+){0,4}\\s+${SPEAK_VERB}\\b`,
      "i"
    )
  );
  if (twoToken) {
    const first = twoToken[1];
    const second = twoToken[2];
    if (isPlausibleTitlelessNameToken(first) && isPlausibleTitlelessNameToken(second)) {
      return true;
    }
  }

  // 3) Single name only with stronger explicit connection phrasing
  // Example: "Verbinden Sie mich bitte mit Martin."
  const strongConnect = lower.match(
    /\b(?:verbinden\s+sie\s+mich(?:\s+bitte)?\s+mit|stellen\s+sie\s+mich(?:\s+bitte)?\s+(?:zu|mit))\s+([a-z][a-z-]{1,30})\b/i
  );
  if (strongConnect && isPlausibleTitlelessNameToken(strongConnect[1])) {
    return true;
  }

  return false;
}

/**
 * @returns {"handoff_requested"|null}
 */
export function detectHumanContactIntent(text) {
  if (isGenericHumanContactRequest(text) || isNamedPersonContactRequest(text)) {
    return "handoff_requested";
  }
  return null;
}
