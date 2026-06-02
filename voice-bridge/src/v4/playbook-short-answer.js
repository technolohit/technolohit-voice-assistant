/**
 * Bounded playbook answers for v4 live canary when RAG is disabled (metrics-safe, no hallucination).
 */

import { normalizeText } from "./redaction.js";
import { getProductById } from "./agent-config.js";
import { buildSalesProductExplanation } from "../sales-policy.js";
import { isInterruptionFollowUpPhrase } from "./transcript-intent.js";

const PRICING = /\b(preis|kosten|was kostet|pricing|tarif|geb[uü]hr)\b/i;
const APPOINTMENT = /\b(termin|termine|buchung|buchen|appointment|kalender)\b/i;
const HANDOFF = /\b(mensch|mitarbeiter|team|berater|jemanden sprechen|mit jemand)\b/i;
const EMAIL = /\b(e-?mail|mail schicken|per mail|kontakt per mail)\b/i;
const HOW_IT_WORKS = /\b(wie funktioniert|wie geht das|was kann|was macht|erkl[aä]r)\b/i;
const CAPABILITY = /\b(kann das auch|unterst[uü]tzt|geht das|m[oö]glich)\b/i;

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
      return `${name} wird individuell nach Bedarf kalkuliert. Für ein passendes Angebot brauchen wir kurz Ihr Ziel und den Umfang.`;
    case "appointment":
      return `${name} kann Anfragen strukturieren und erste Fragen beantworten. Ob Terminbuchung direkt möglich ist, hängt von Ihrem Setup ab — was möchten Sie konkret abbilden?`;
    case "handoff":
      return `Gerne. Unser Team kann ${name} mit Ihnen besprechen. Möchten Sie telefonisch oder per E-Mail starten?`;
    case "email":
      return `Sie erreichen uns per E-Mail über die Kontaktadresse auf www.technolohit.com. Soll unser Team Sie zusätzlich telefonisch unterstützen?`;
    case "how_it_works":
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
