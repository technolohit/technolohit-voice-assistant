function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const PRODUCT_INTAKE_POLICY = {
  smart_website: {
    displayName: "Smart Website",
    aliases: ["smart website", "intelligente website", "intelligente webseite", "website", "webseite", "homepage"],
    pitchShort:
      "Eine Smart Website verbindet moderne Website, KI-Chat und Anfrage-Erfassung.",
    mandatoryInterestQuestion:
      "Möchten Sie so etwas für Ihr Unternehmen prüfen lassen?",
    emailInstruction:
      "Schreiben Sie uns bitte kurz Ihre Website, Ihr Ziel und die wichtigsten Fragen.",
    interestConfirmedAcknowledgement:
      "Sehr gerne. Wir freuen uns, wenn wir Ihrem Unternehmen dabei helfen können.",
    handoffChoiceQuestion:
      "Möchten Sie lieber per E-Mail starten oder soll unser Team Sie telefonisch kontaktieren?"
  },
  aiseoq: {
    displayName: "AISeoQ",
    aliases: ["aiseoq", "seo", "suchmaschinenoptimierung", "google", "wettbewerberanalyse"],
    pitchShort:
      "AISeoQ hilft dabei, Websites mit Wettbewerbern zu vergleichen und konkrete SEO-Ansätze zu finden.",
    mandatoryInterestQuestion:
      "Möchten Sie prüfen lassen, ob das für Ihre Website sinnvoll ist?",
    emailInstruction:
      "Schreiben Sie uns bitte kurz Ihre Website, Ihr Ziel und die wichtigsten SEO-Fragen.",
    interestConfirmedAcknowledgement:
      "Sehr gerne. Wir freuen uns, wenn wir Ihrem Unternehmen dabei helfen können.",
    handoffChoiceQuestion:
      "Möchten Sie lieber per E-Mail starten oder soll unser Team Sie telefonisch kontaktieren?"
  },
  botinteg: {
    displayName: "Botinteg",
    aliases: ["botinteg", "bot integ", "chatbot", "ki chatbot", "automatisierung", "lead-erfassung"],
    pitchShort:
      "Botinteg ist für KI-Chatbots und einfache Automatisierungen gedacht. Es kann häufige Fragen beantworten, Leads erfassen und Website-Anfragen strukturierter aufnehmen.",
    mandatoryInterestQuestion:
      "Möchten Sie so etwas für Ihr Unternehmen prüfen lassen?",
    emailInstruction:
      "Schreiben Sie uns bitte kurz Ihr Ziel, Ihre Website falls vorhanden und welche Abläufe Sie automatisieren möchten.",
    interestConfirmedAcknowledgement:
      "Sehr gerne. Wir freuen uns, wenn wir Ihrem Unternehmen dabei helfen können.",
    handoffChoiceQuestion:
      "Möchten Sie lieber per E-Mail starten oder soll unser Team Sie telefonisch kontaktieren?"
  },
  lokalki: {
    displayName: "LokalKI",
    aliases: ["lokalki", "lokale ki", "private ki", "interne dokumente", "sensible daten", "datenschutz"],
    pitchShort:
      "LokalKI ist für Unternehmen gedacht, die mit sensiblen internen Dokumenten arbeiten und KI kontrollierter nutzen möchten.",
    mandatoryInterestQuestion:
      "Möchten Sie das mit unserem Team prüfen lassen?",
    emailInstruction:
      "Schreiben Sie uns bitte kurz, welche internen Dokumente oder Datenprozesse Sie prüfen möchten.",
    interestConfirmedAcknowledgement:
      "Sehr gerne. Wir freuen uns, wenn wir Ihrem Unternehmen dabei helfen können.",
    handoffChoiceQuestion:
      "Möchten Sie lieber per E-Mail starten oder soll unser Team Sie telefonisch kontaktieren?"
  },
  digital_assistant: {
    displayName: "Digitaler Assistent",
    aliases: ["digitaler assistent", "voice assistant", "telefonassistent", "digitale rezeption", "anrufannahme", "telefon ki"],
    pitchShort:
      "Unser digitaler Assistent kann Anrufe entgegennehmen, erste Fragen beantworten und Kontaktwünsche vorbereiten.",
    mandatoryInterestQuestion:
      "Möchten Sie prüfen lassen, ob das zu Ihrem Unternehmen passt?",
    emailInstruction:
      "Schreiben Sie uns bitte kurz, wie Ihre aktuelle Telefon-Situation aussieht und was der Assistent übernehmen soll.",
    interestConfirmedAcknowledgement:
      "Sehr gerne. Wir freuen uns, wenn wir Ihrem Unternehmen dabei helfen können.",
    handoffChoiceQuestion:
      "Möchten Sie lieber per E-Mail starten oder soll unser Team Sie telefonisch kontaktieren?"
  }
};

const PRODUCT_ID_TO_POLICY_KEY = {
  smart_website: "smart_website",
  aiseoq: "aiseoq",
  botinteg: "botinteg",
  lokalki: "lokalki",
  voice_agent: "digital_assistant",
  digital_assistant: "digital_assistant"
};

export function productPolicyById(productId) {
  const key = PRODUCT_ID_TO_POLICY_KEY[String(productId ?? "").trim()] || "";
  return key ? PRODUCT_INTAKE_POLICY[key] || null : null;
}

export function matchProductPolicyFromText(text) {
  const normalized = normalize(text);
  if (!normalized) return null;
  const compact = normalized.replace(/[^a-z0-9]/g, "");

  for (const [key, policy] of Object.entries(PRODUCT_INTAKE_POLICY)) {
    for (const alias of policy.aliases || []) {
      const aliasNorm = normalize(alias);
      if (!aliasNorm) continue;
      const aliasCompact = aliasNorm.replace(/[^a-z0-9]/g, "");
      if (normalized.includes(aliasNorm) || (aliasCompact && compact.includes(aliasCompact))) {
        return { key, policy };
      }
    }
  }
  return null;
}

export function validateProductIntakePolicy() {
  for (const [key, policy] of Object.entries(PRODUCT_INTAKE_POLICY)) {
    const required = [
      "displayName",
      "aliases",
      "pitchShort",
      "mandatoryInterestQuestion",
      "emailInstruction",
      "interestConfirmedAcknowledgement",
      "handoffChoiceQuestion"
    ];
    for (const field of required) {
      if (policy[field] == null || policy[field] === "") {
        throw new Error(`product-intake-policy invalid: ${key}.${field} is missing`);
      }
    }
    if (!Array.isArray(policy.aliases) || policy.aliases.length === 0) {
      throw new Error(`product-intake-policy invalid: ${key}.aliases must be a non-empty array`);
    }
  }
}
