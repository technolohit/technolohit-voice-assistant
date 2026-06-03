/**
 * Bounded playbook answers for v4 live canary when RAG is disabled (metrics-safe, no hallucination).
 */

import { normalizeText } from "./redaction.js";
import { getProductById } from "./agent-config.js";
import { buildSalesProductExplanation } from "../sales-policy.js";
import { isInterruptionFollowUpPhrase, sanitizeResponseText } from "./transcript-intent.js";

const PRICING = /\b(preis|kosten|was kostet|pricing|tarif|geb[uü]hr)\b/i;
const APPOINTMENT = /\b(termin|termine|buchung|buchen|appointment|kalender)\b/i;
const HANDOFF = /\b(mensch|mitarbeiter|team|berater|jemanden sprechen|mit jemand)\b/i;
const EMAIL = /\b(e-?mail|mail schicken|per mail|kontakt per mail)\b/i;
const HOW_IT_WORKS = /\b(wie funktioniert|wie geht das|was kann|was macht|erkl[aä]r)\b/i;
const CAPABILITY = /\b(kann das auch|unterst[uü]tzt|geht das|m[oö]glich)\b/i;
const WHAT_IS = /\b(was ist|was sind|was bedeutet)\b/i;
const WHAT_DOES = /\b(was macht|was kann|wof[uü]r|nutzen|vorteil)\b/i;

const FOLLOW_UP_BOILERPLATE =
  /\b(kurze frage|noch eine frage|darf ich kurz fragen|ich habe eine frage|stopp|stop)\b/gi;

export function detectShortFollowUpCategory(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return null;
  if (PRICING.test(lower)) return "pricing";
  if (APPOINTMENT.test(lower)) return "appointment";
  if (HANDOFF.test(lower)) return "handoff";
  if (EMAIL.test(lower)) return "email";
  if (HOW_IT_WORKS.test(lower)) return "how_it_works";
  if (CAPABILITY.test(lower)) return "capability";
  return null;
}

export function detectCombinedProductInquiry(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) {
    return {
      whatIs: false,
      howItWorks: false,
      pricing: false,
      isCombined: false
    };
  }

  const whatIs = WHAT_IS.test(lower);
  const howItWorks = WHAT_DOES.test(lower) || HOW_IT_WORKS.test(lower) || CAPABILITY.test(lower);
  const pricing = PRICING.test(lower);
  const facetCount = [whatIs, howItWorks, pricing].filter(Boolean).length;

  return {
    whatIs,
    howItWorks,
    pricing,
    isCombined: facetCount >= 2
  };
}

function smartWebsiteCombinedAnswer(facets) {
  const parts = [];

  if (facets.whatIs || facets.isCombined) {
    parts.push(
      "Smart Website ist eine moderne Firmenwebsite mit klaren Leistungsseiten, lokaler Sichtbarkeit, Vertrauenssignalen und einfachem Anfrage-Flow."
    );
  }
  if (facets.howItWorks || (facets.isCombined && facets.whatIs)) {
    parts.push(
      "Sie hilft Besuchern, Ihr Angebot zu verstehen, bessere Fragen zu stellen und qualifizierte Anfragen vorzubereiten."
    );
  }
  if (facets.pricing) {
    parts.push(
      "Der Preis hängt vom Umfang ab; für eine realistische Einschätzung klären wir kurz Ihr Ziel."
    );
  }
  if (facets.isCombined) {
    parts.push("Möchten Sie dazu einen Rückruf oder eine kurze Beratung?");
  }

  return parts.join(" ");
}

export function hasSubstantiveFollowUpContent(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  if (isInterruptionFollowUpPhrase(transcript) && !detectShortFollowUpCategory(transcript)) {
    if (!/\b(was kostet|wie funktioniert|kann das auch|was ist|wie geht)\b/i.test(lower)) {
      return false;
    }
  }
  if (detectShortFollowUpCategory(transcript)) return true;
  if (/\b(was kostet|wie funktioniert|kann das|was ist|smart website|digitale rezeption|voice)\b/i.test(lower)) {
    return true;
  }
  const stripped = lower.replaceAll(FOLLOW_UP_BOILERPLATE, "").trim();
  return stripped.length >= 12;
}

export function buildPlaybookShortAnswer(agentConfig, productId, category) {
  const product = productId ? getProductById(agentConfig, productId) : null;
  const name = product?.display_name ?? "die Lösung";
  const baseExplanation = productId ? buildSalesProductExplanation(productId) : "";

  switch (category) {
    case "pricing":
      if (productId === "smart_website") {
        return `${name} wird individuell nach Umfang kalkuliert. Für eine realistische Einschätzung klären wir kurz Seitenumfang und Ziele.`;
      }
      return `${name} wird individuell nach Bedarf kalkuliert. Für ein passendes Angebot brauchen wir kurz Ihr Ziel und den Umfang.`;
    case "appointment":
      return `${name} kann Anfragen strukturieren und erste Fragen beantworten. Ob Terminbuchung direkt möglich ist, hängt von Ihrem Setup ab — was möchten Sie konkret abbilden?`;
    case "handoff":
      return `Gerne. Unser Team kann ${name} mit Ihnen besprechen. Möchten Sie telefonisch oder per E-Mail starten?`;
    case "email":
      return `Sie erreichen uns per E-Mail über die Kontaktadresse auf www.technolohit.com. Soll unser Team Sie zusätzlich telefonisch unterstützen?`;
    case "how_it_works":
      if (productId === "smart_website") {
        return "Smart Website hilft Besuchern, Ihr Angebot zu verstehen, bessere Fragen zu stellen und qualifizierte Anfragen vorzubereiten.";
      }
      return (
        baseExplanation ||
        `${name} unterstützt Sie bei Sichtbarkeit, Anfragen und der ersten Orientierung für Interessenten.`
      );
    case "capability":
      return (
        baseExplanation ||
        `${name} hilft bei wiederkehrenden Fragen und der Vorbereitung von Anfragen. Was möchten Sie konkret automatisieren?`
      );
    default:
      return baseExplanation || `Gerne zu ${name}. Was möchten Sie genau wissen?`;
  }
}

export function buildPlaybookCombinedProductAnswer(agentConfig, productId, transcript = "") {
  const id = productId ? normalizeText(productId) : "";
  if (!id) return null;

  const facets = detectCombinedProductInquiry(transcript);
  if (!facets.isCombined) return null;

  if (id === "smart_website") {
    return sanitizeResponseText(smartWebsiteCombinedAnswer(facets));
  }

  const name = getProductById(agentConfig, id)?.display_name ?? "die Lösung";
  const parts = [];
  if (facets.whatIs) {
    parts.push(buildSalesProductExplanation(id) || `${name} ist eine unserer TechnoloHit-Lösungen.`);
  }
  if (facets.howItWorks) {
    parts.push(buildPlaybookShortAnswer(agentConfig, id, "how_it_works"));
  }
  if (facets.pricing) {
    parts.push(buildPlaybookShortAnswer(agentConfig, id, "pricing"));
  }
  parts.push("Möchten Sie dazu einen Rückruf oder eine kurze Beratung?");
  return sanitizeResponseText(parts.filter(Boolean).join(" "));
}
