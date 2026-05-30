import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import * as persist from "./persist.js";
import { retrieveRagContext } from "./rag-client.js";
import {
  productPolicyById,
  matchProductPolicyFromText,
  validateProductIntakePolicy
} from "./product-intake-policy.js";
import {
  matchBusinessFallbackFromText,
  buildBusinessFallbackResponse,
  BUSINESS_FALLBACK_CLOSE_QUESTION,
  validateBusinessFallbackPolicy
} from "./business-fallback-policy.js";
import { hasUsableCallerId, callerIdForCallback } from "./caller-id.js";
import {
  buildCustomerTypeResponse,
  buildHandoffOffer,
  buildSalesProductExplanation,
  buildSalesProductPitch,
  classifyCustomerType,
  validateSalesPlaybooks
} from "./sales-policy.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const knowledgePath = path.join(packageRoot, "knowledge", "technolohit.md");
const productCatalogPath = path.join(packageRoot, "knowledge", "products.technolohit.json");
const faqCatalogPath = path.join(packageRoot, "knowledge", "faqs.technolohit.json");
const CLARIFICATION_TEXT =
  "Entschuldigung, ich habe Sie akustisch nicht gut verstanden. Können Sie Ihr Anliegen bitte kurz wiederholen?";
const PARTIAL_TRANSCRIPT_TEXT =
  "Ich glaube, ich habe nur einen Teil verstanden. Können Sie das bitte kurz wiederholen?";
const UNKNOWN_INTENT_TEXT =
  "Ich bin nicht ganz sicher, ob es um Website, KI-Assistent, SEO oder Automatisierung geht. Worum geht es bei Ihnen?";
const VOICE_AGENT_SYNONYM_CLARIFICATION_TEXT =
  "Meinen Sie unseren KI-Telefonassistenten beziehungsweise die digitale Rezeption?";
const UNKNOWN_LOOP_HANDOFF_TEXT =
  "Damit unser Team Ihnen gezielt helfen kann: Möchten Sie lieber per E-Mail schreiben oder telefonisch kontaktiert werden?";
const MAX_TURNS_CALLBACK_TEXT =
  "Ich gebe Ihre Anfrage gerne an unser Team weiter. Danke für Ihren Anruf. Auf Wiederhören.";
const MAX_TURNS_WRAPUP_TEXT =
  "Danke, das reicht für eine erste Einordnung. Unser Team kann die Details persönlich klären. Danke für Ihren Anruf. Auf Wiederhören.";
const UNKNOWN_FALLBACK_TEXT =
  "Das kann ich nicht sicher beantworten. Am besten klärt unser Team die Details persönlich.";
const CONTACT_PREFERENCE_PROMPT =
  "Möchten Sie lieber per E-Mail schreiben oder telefonisch kontaktiert werden?";
const HANDOFF_CONTACT_PREFERENCE_TEXT =
  "Natürlich. Möchten Sie lieber per E-Mail schreiben oder telefonisch kontaktiert werden?";
const INTEREST_CONTACT_PREFERENCE_TEXT =
  "Wenn Sie möchten, kann unser Team sich persönlich bei Ihnen melden. Möchten Sie lieber per E-Mail schreiben oder telefonisch kontaktiert werden?";
const DEFAULT_INTEREST_CONFIRMED_ACK =
  "Sehr gerne. Wir freuen uns, wenn wir Ihrem Unternehmen dabei helfen können.";
const COMPRESSED_INTEREST_CONFIRMED_ACK = "Sehr gerne.";
const COMPRESSED_HANDOFF_FALLBACK_TEXT =
  "Sehr gerne. Möchten Sie per E-Mail starten oder soll unser Team Sie telefonisch kontaktieren?";
const CONSULTATION_CONFIRMED_ACK = "Gerne. Dann kann unser Team kurz mit Ihnen sprechen.";
const DEFAULT_HANDOFF_CHOICE_QUESTION =
  "Möchten Sie lieber per E-Mail starten oder soll unser Team Sie telefonisch kontaktieren?";
const EMAIL_DETAIL_REQUEST_TEXT =
  "Welche E-Mail-Adresse dürfen wir für die Rückmeldung verwenden?";
const PHONE_DETAIL_REQUEST_TEXT =
  "Gerne. Unter welcher Telefonnummer darf unser Team Sie telefonisch kontaktieren?";
const CALLER_ID_CALLBACK_PERMISSION_TEXT =
  "Gerne. Darf unser Team Sie unter der Nummer telefonisch kontaktieren, von der Sie gerade anrufen?";
const CALLBACK_NUMBER_CONFIRM_PERMISSION_TEXT = CALLER_ID_CALLBACK_PERMISSION_TEXT;
const CONTACT_PERMISSION_TEXT = "Danke. Darf unser Team Sie dazu kontaktieren?";
const CONTACT_PERMISSION_REASK_TEXT = "Darf unser Team Sie dazu kontaktieren?";
const CONTACT_PERMISSION_GRANTED_TEXT =
  "Danke. Ich gebe Ihre Anfrage an unser Team weiter. Unser Team meldet sich bei Ihnen.";
const PERMISSION_GRANTED_CONFIRMATION_BODY =
  "Danke, ich habe es notiert. Unser Team meldet sich so bald wie möglich telefonisch bei Ihnen.";
const PERMISSION_GRANTED_FINAL_QUESTION =
  "Haben Sie noch eine kurze Frage, oder darf ich mich verabschieden?";
const CONTACT_PERMISSION_GRANTED_CONFIRMATION_TEXT =
  `${PERMISSION_GRANTED_CONFIRMATION_BODY} ${PERMISSION_GRANTED_FINAL_QUESTION}`;
const COMPRESSED_PERMISSION_GRANTED_CONFIRMATION = "Danke, ich habe es notiert.";
const COMPRESSED_PERMISSION_GRANTED_FALLBACK =
  "Danke, ich habe es notiert. Haben Sie noch eine kurze Frage, oder darf ich mich verabschieden?";
const POST_CAPTURE_INCOMPLETE_QUESTION_TEXT =
  "Ich habe die Frage nicht ganz vollständig verstanden. Bitte stellen Sie sie noch einmal kurz.";
const POST_CAPTURE_WARM_GOODBYE_TEXT = "Vielen Dank für Ihren Anruf. Auf Wiederhören.";
const POST_CAPTURE_FOLLOWUP_RETRY_TEXT =
  "Wenn Sie keine weitere Frage haben, verabschiede ich mich gerne. Haben Sie noch eine kurze Frage?";
const POST_CAPTURE_QUESTION_PROMPT_TEXT = "Gerne. Welche Frage haben Sie?";
const POST_CAPTURE_FINAL_CLOSE_QUESTION_TEXT = "Haben Sie noch eine weitere Frage, oder darf ich mich verabschieden?";
const STT_PROMPT_LEAK_PATTERN =
  /deutsch,\s*telefonat mit technolohit.*mogliche begriffe:.*smart website.*aiseoq.*botinteg.*lokalki.*digitale rezeption.*ruckruf.*e-?mail.*telefonnummer/i;
const HUMAN_CLOSING_QUESTION_TEXT = "Haben Sie noch eine weitere Frage?";
const HUMAN_WARM_GOODBYE_TEXT =
  "Alles klar, vielen Dank für Ihren Anruf. Ich wünsche Ihnen einen schönen Tag und auf Wiederhören.";
const CONTACT_PREFERENCE_REASK_TEXT =
  "Ich habe Sie akustisch nicht sicher verstanden. Geht es bei Ihnen eher um E-Mail oder Telefon?";
const CONTACT_PREFERENCE_REASK_SECOND_TEXT =
  "Entschuldigung, ich habe es nicht sicher verstanden. Möchten Sie lieber E-Mail oder Telefon? Sagen Sie bitte nur: E-Mail oder Telefon.";
const CONTACT_PREFERENCE_REASK_LAST_TEXT =
  "Sie können auch einfach Telefon sagen, dann notiere ich Ihren Kontaktwunsch. Oder E-Mail, dann nenne ich Ihnen den nächsten Schritt.";
const CONTACT_PREFERENCE_FAILED_TEXT =
  "Ich konnte den Kontaktweg leider nicht sicher erkennen. Die E-Mail-Adresse finden Sie in unserer Nachricht oder auf unserer Website. Danke für Ihren Anruf. Auf Wiederhören.";
const EMAIL_DETAIL_REASK_TEXT =
  "Entschuldigung, ich habe die E-Mail-Adresse nicht sicher verstanden. Die passende E-Mail-Adresse finden Sie in unserer Nachricht oder auf unserer Website.";
const PHONE_DETAIL_REASK_TEXT =
  "Entschuldigung, ich habe die Telefonnummer nicht sicher verstanden. Die E-Mail-Adresse finden Sie in unserer Nachricht oder auf unserer Website.";
const PHONE_DETAIL_INCOMPLETE_REASK_TEXT =
  "Ich habe die Telefonnummer noch nicht vollständig verstanden. Können Sie sie bitte noch einmal vollständig nennen?";
const MAX_TURNS_INTAKE_EMAIL_MISSING_TEXT =
  "Sie können uns Ihre Kontaktdaten auch direkt per E-Mail senden. Die E-Mail-Adresse finden Sie in unserer Nachricht oder auf unserer Website. Danke für Ihren Anruf. Auf Wiederhören.";
const MAX_TURNS_INTAKE_PHONE_MISSING_TEXT =
  "Sie können uns auch direkt per E-Mail erreichen. Die E-Mail-Adresse finden Sie in unserer Nachricht oder auf unserer Website. Danke für Ihren Anruf. Auf Wiederhören.";
const MAX_TURNS_INTAKE_PERMISSION_MISSING_TEXT =
  "Ohne klare Bestätigung gebe ich keine Kontaktdaten weiter. Die E-Mail-Adresse finden Sie in unserer Nachricht oder auf unserer Website. Danke für Ihren Anruf. Auf Wiederhören.";
const DETAIL_RETRY_LIMIT = 1;
const CONTACT_PREFERENCE_RETRY_LIMIT = 3;
const PERMISSION_RETRY_LIMIT = 1;
const UNKNOWN_INTENT_LOOP_LIMIT = 2;
const BANNED_OUTBOUND_CALLBACK_PATTERN =
  /\b(?:rückruf(?:nummer|wunsch|wünsche|wuensche)?|rueckruf(?:nummer|wunsch|wuensche)?|ruckruf(?:nummer|wunsch|wunsche)?|zurückrufen|zurueckrufen|zuruckrufen|zurückruft|zurueckruft|zuruckruft)\b/i;
const KNOWLEDGE_SOURCE = "voice-bridge/knowledge/technolohit.md";
const PRODUCT_CATALOG_SOURCE = "voice-bridge/knowledge/products.technolohit.json";
const FAQ_CATALOG_SOURCE = "voice-bridge/knowledge/faqs.technolohit.json";
const HISTORY_TURNS = 3;
const KNOWN_INTENTS = new Set([
  "handoff_requested",
  "human_or_ai_question",
  "what",
  "website",
  "smart_website_interest",
  "product_overview_request",
  "product_selection_smart_website",
  "product_selection_aiseoq",
  "product_selection_botinteg",
  "product_selection_lokalki",
  "product_selection_voice_agent",
  "product_more_detail_request",
  "compare_products_request",
  "product_interest_confirmed",
  "product_interest_declined",
  "pricing_question",
  "voice_assistant_question",
  "technology_question",
  "free_analysis_request",
  "callback_request",
  "email_campaign_caller",
  "contact_preference_email",
  "contact_preference_phone",
  "email_provided",
  "phone_provided",
  "refuses_contact_details",
  "english_language",
  "seo_guarantee_question",
  "inquiries",
  "visibility"
]);
const PRODUCT_INTENT_TO_ID = {
  product_selection_smart_website: "smart_website",
  product_selection_aiseoq: "aiseoq",
  product_selection_botinteg: "botinteg",
  product_selection_lokalki: "lokalki",
  product_selection_voice_agent: "voice_agent"
};
const PRODUCT_NUMBER_TO_ID = {
  "1": "smart_website",
  "2": "aiseoq",
  "3": "botinteg",
  "4": "lokalki",
  "5": "voice_agent"
};
const PRODUCT_ID_TO_INTENT = Object.fromEntries(
  Object.entries(PRODUCT_INTENT_TO_ID).map(([intent, productId]) => [productId, intent])
);
const DEFAULT_PRODUCT_CATALOG = {
  version: "products-2026-05-21-v1",
  products: [
    {
      id: "smart_website",
      number: 1,
      name: "Smart Website",
      short_name: "Smart Websites",
      phone_short_de:
        "Eine intelligente Website ist mehr als eine normale Homepage. Sie verbindet klare Seitenstruktur, KI-Chat und Anfrage-Erfassung - soll Ihre Website verbessert werden oder neu entstehen?",
      phone_detail_de:
        "Eine intelligente Website verbindet klare Seitenstruktur, KI-Chat und saubere Anfrage-Erfassung, damit qualifizierte Anfragen einfacher entstehen. Wenn Sie möchten, kann unser Team kurz prüfen, ob Ihre bestehende Website verbessert werden sollte oder ob ein neuer KI-gestützter Aufbau sinnvoller ist."
    },
    {
      id: "aiseoq",
      number: 2,
      name: "AISeoQ",
      short_name: "AISeoQ",
      phone_short_de:
        "AISeoQ hilft Agenturen und IT-Teams, Websites mit Wettbewerbern zu vergleichen und SEO-Maßnahmen abzuleiten. Prüfen Sie eigene oder Kundenprojekte?",
      phone_detail_de:
        "AISeoQ ist für Analyse, Wettbewerbsvergleich und Kundenreports gedacht. Möchten Sie prüfen, ob es zu Ihren Projekten passt?"
    },
    {
      id: "botinteg",
      number: 3,
      name: "Botinteg",
      short_name: "Botinteg",
      phone_short_de:
        "Botinteg ist für KI-Chatbots und einfache Automatisierung, etwa FAQ, Lead-Erfassung und Website-Abläufe. Geht es bei Ihnen eher um Chatbot, Lead-Erfassung oder Automatisierung?",
      phone_detail_de:
        "Botinteg verbindet wiederkehrende Fragen, Leads und einfache Abläufe mit Website oder Social Media. Möchten Sie dafür eine erste Einschätzung?"
    },
    {
      id: "lokalki",
      number: 4,
      name: "LokalKI",
      short_name: "LokalKI",
      phone_short_de:
        "LokalKI ist eine private KI-Lösung für sensible Daten in kontrollierten oder lokalen Umgebungen. Geht es um interne Dokumente oder Datenschutz?",
      phone_detail_de:
        "LokalKI ist für interne Dokumente und sensible Daten in kontrollierten Umgebungen gedacht. Möchten Sie das mit dem Team prüfen?"
    },
    {
      id: "voice_agent",
      number: 5,
      name: "Digitale Rezeption",
      short_name: "digitale Rezeption",
      phone_short_de:
        "Die digitale Rezeption nimmt Anrufe an, beantwortet erste Fragen und bereitet Rückrufwünsche oder Leads vor. Möchten Sie das für Ihr Unternehmen prüfen?",
      phone_detail_de:
        "Sie unterstützt das Team am Telefon und bereitet wichtige Gesprächspunkte oder Rückrufwünsche vor. Möchten Sie das für Ihr Unternehmen prüfen?"
    }
  ]
};
const DEFAULT_FAQ_CATALOG = {
  version: "faqs-default-v1",
  faqs: []
};
const FILLER_WORDS = new Set([
  "äh",
  "ähm",
  "aeh",
  "aehm",
  "ah",
  "hm",
  "hmm",
  "ja",
  "nein",
  "okay",
  "ok",
  "hallo",
  "hello",
  "test",
  "bitte",
  "danke"
]);
const STOP_WORDS = new Set([
  "aber",
  "also",
  "bitte",
  "danke",
  "dann",
  "dass",
  "denn",
  "eine",
  "einen",
  "einer",
  "eines",
  "für",
  "fur",
  "genau",
  "haben",
  "habe",
  "hallo",
  "ihnen",
  "ihr",
  "ihre",
  "ist",
  "kann",
  "können",
  "koennen",
  "machen",
  "mal",
  "mit",
  "oder",
  "sie",
  "sind",
  "und",
  "was",
  "wie",
  "wir"
]);

let client = null;
let cachedKnowledge = null;
let cachedProductCatalog = null;
let cachedFaqCatalog = null;

validateProductIntakePolicy();
validateBusinessFallbackPolicy();
validateSalesPlaybooks();

function nowMs() {
  return Date.now();
}

function elapsedSince(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

function safeBaseName(ctx, suffix) {
  const base = String(ctx.bridgeCallId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${base}-${suffix}`;
}

async function readKnowledge() {
  if (cachedKnowledge !== null) return cachedKnowledge;
  cachedKnowledge = await fsp.readFile(knowledgePath, "utf8");
  return cachedKnowledge;
}

async function readProductCatalog() {
  if (cachedProductCatalog !== null) return cachedProductCatalog;
  try {
    const raw = await fsp.readFile(productCatalogPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.products) && parsed.products.length) {
      cachedProductCatalog = parsed;
      return cachedProductCatalog;
    }
  } catch (err) {
    console.warn(`[voice-assistant] product catalog unavailable source=${PRODUCT_CATALOG_SOURCE} reason=${makeSafeError(err)}`);
  }
  cachedProductCatalog = DEFAULT_PRODUCT_CATALOG;
  return cachedProductCatalog;
}

async function readFaqCatalog() {
  if (cachedFaqCatalog !== null) return cachedFaqCatalog;
  try {
    const raw = await fsp.readFile(faqCatalogPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.faqs) && parsed.faqs.length) {
      cachedFaqCatalog = parsed;
      return cachedFaqCatalog;
    }
  } catch (err) {
    console.warn(`[voice-assistant] faq catalog unavailable source=${FAQ_CATALOG_SOURCE} reason=${makeSafeError(err)}`);
  }
  cachedFaqCatalog = DEFAULT_FAQ_CATALOG;
  return cachedFaqCatalog;
}

async function fileSize(filePath) {
  const stat = await fsp.stat(filePath);
  return stat.size;
}

async function convertSlinToWav(inputPath, outputPath) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "s16le",
    "-ar",
    "8000",
    "-ac",
    "1",
    "-i",
    inputPath,
    outputPath
  ]);
}

async function convertWavToSlin(inputPath, outputPath) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-ar",
    "8000",
    "-ac",
    "1",
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    outputPath
  ]);
}

function extractText(response) {
  if (typeof response?.output_text === "string") return response.output_text.trim();
  if (typeof response === "string") return response.trim();
  return "";
}

function previewText(text, limit = 120) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function previewForLogs(config, text, limit = 120) {
  if (config.assistant?.logTranscriptPreview) {
    return `"${previewText(text, limit)}"`;
  }
  return "<redacted>";
}

function qaPreviewForLogs(config, text, limit = 80) {
  if (!config.assistant?.qaLogTranscriptPreview) return "<qa-redacted>";
  return `"${previewText(text, limit)}"`;
}

function pcmRms(buffer) {
  if (!buffer?.length) return 0;
  const samples = Math.floor(buffer.length / 2);
  if (!samples) return 0;

  let sumSquares = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / samples);
}

function speechRmsThreshold(config) {
  return Math.max(100, Number(config.assistant?.speechRmsThreshold || 450));
}

function knowledgeVersion(knowledge) {
  const match = String(knowledge ?? "").match(/^Version:\s*(.+)$/m);
  return match ? match[1].trim() : "unknown";
}

function maxResponseChars(config) {
  return Math.max(80, Number(config.assistant?.maxResponseChars || 180));
}

function maxResponseSentences(config) {
  return Math.max(1, Number(config.assistant?.maxResponseSentences || 2));
}

function trimToChars(text, limit) {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  const sliced = compact.slice(0, limit).replace(/\s+\S*$/, "").trim();
  return `${sliced.replace(/[,.!?;:]+$/, "")}.`;
}

function limitSentences(text, maxSentences) {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  const sentences = compact.match(/[^.!?]+[.!?]?/g) || [compact];
  return sentences
    .slice(0, maxSentences)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAssistantResponse(text, config) {
  const protectedTokens = new Map();
  let tokenIndex = 0;
  const noBullets = String(text ?? "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, (match) => {
      const token = `__EMAIL_TOKEN_${tokenIndex++}__`;
      protectedTokens.set(token, match);
      return token;
    })
    .trim();
  const sentenceLimited = limitSentences(noBullets, maxResponseSentences(config));
  let restored = sentenceLimited;
  for (const [token, value] of protectedTokens.entries()) {
    restored = restored.replaceAll(token, value);
  }
  return trimToChars(sanitizeAssistantOutput(restored), maxResponseChars(config));
}

function sanitizeAssistantOutput(text) {
  const bannedGlobal =
    /\b(?:rückruf(?:nummer|wunsch|wünsche|wuensche)?|rueckruf(?:nummer|wunsch|wuensche)?|ruckruf(?:nummer|wunsch|wunsche)?|zurückrufen|zurueckrufen|zuruckrufen|zurückruft|zurueckruft|zuruckruft)\b/gi;
  return String(text ?? "")
    .replace(bannedGlobal, (match) => {
      const lower = match.toLowerCase();
      if (lower.includes("nummer")) return "Telefonnummer";
      if (lower.includes("wunsch") || lower.includes("wünsche") || lower.includes("wuensche")) return "Kontaktwunsch";
      if (lower.includes("zur")) return "telefonisch kontaktiert";
      return "telefonische Kontaktaufnahme";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function responseHasBannedCallbackWording(text) {
  return BANNED_OUTBOUND_CALLBACK_PATTERN.test(String(text ?? ""));
}

function protectInlineTokens(text) {
  const protectedTokens = new Map();
  let tokenIndex = 0;
  const protectedText = String(text ?? "")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, (match) => {
      const token = `__EMAIL_TOKEN_${tokenIndex++}__`;
      protectedTokens.set(token, match);
      return token;
    })
    .replace(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\b/gi, (match) => {
      const token = `__URL_TOKEN_${tokenIndex++}__`;
      protectedTokens.set(token, match);
      return token;
    });
  return { protectedText, protectedTokens };
}

function restoreInlineTokens(text, protectedTokens) {
  let restored = String(text ?? "");
  for (const [token, value] of protectedTokens.entries()) {
    restored = restored.replaceAll(token, value);
  }
  return restored;
}

function assembleLimitedResponse({ prefix, mandatorySuffix, config, maxSentencesOverride = null, maxCharsOverride = null }) {
  const suffix = String(mandatorySuffix ?? "").replace(/\s+/g, " ").trim();
  let lead = String(prefix ?? "").replace(/\s+/g, " ").trim();
  if (!suffix) {
    return {
      text: normalizeAssistantResponse(lead, config),
      containsRequiredSuffix: true
    };
  }

  const maxChars = Number.isFinite(maxCharsOverride) ? maxCharsOverride : maxResponseChars(config);
  let combined = lead ? `${lead} ${suffix}` : suffix;
  if (combined.replace(/\s+/g, " ").trim().length <= maxChars) {
    return {
      text: combined.replace(/\s+/g, " ").trim(),
      containsRequiredSuffix: true
    };
  }

  const maxSentences = Number.isFinite(maxSentencesOverride)
    ? maxSentencesOverride
    : maxResponseSentences(config);
  const suffixSentenceCount = (suffix.match(/[^.!?]+[.!?]?/g) || [suffix]).length;
  const leadMaxSentences = Math.max(0, maxSentences - suffixSentenceCount);
  const leadProtected = protectInlineTokens(lead);
  lead = leadProtected.protectedText;
  if (lead && leadMaxSentences > 0) {
    const leadSentences = lead.match(/[^.!?]+[.!?]?/g) || [lead];
    if (leadSentences.length > leadMaxSentences) {
      lead = leadSentences.slice(0, leadMaxSentences).join(" ").replace(/\s+/g, " ").trim();
    }
  } else if (leadMaxSentences === 0) {
    lead = "";
  }
  lead = restoreInlineTokens(lead, leadProtected.protectedTokens);

  const leadCharBudget = Math.max(0, maxChars - suffix.length - (lead ? 1 : 0));
  if (lead.length > leadCharBudget) {
    lead = trimToChars(lead, leadCharBudget);
  }

  combined = lead ? `${lead} ${suffix}` : suffix;
  if (combined.length > maxChars) {
    lead = trimToChars(lead, Math.max(0, maxChars - suffix.length - 1));
    combined = lead ? `${lead} ${suffix}` : suffix;
  }

  const suffixNorm = normalizeForIntent(suffix);
  const combinedNorm = normalizeForIntent(combined);
  return {
    text: combined.replace(/\s+/g, " ").trim(),
    containsRequiredSuffix: combinedNorm.includes(suffixNorm)
  };
}

function responseContainsInterestQuestion(text, question) {
  const normalized = normalizeForIntent(text);
  const questionNorm = normalizeForIntent(question);
  return Boolean(questionNorm) && normalized.includes(questionNorm);
}

function responseContainsHandoffQuestion(text, question = DEFAULT_HANDOFF_CHOICE_QUESTION) {
  const normalized = normalizeForIntent(text);
  const questionNorm = normalizeForIntent(question);
  if (questionNorm && normalized.includes(questionNorm)) return true;
  return /\b(e-?mail|telefon|telefonisch)\b/i.test(normalized) && /\b(mochten|moegen|starten|kontaktieren)\b/i.test(normalized);
}

function responseContainsFinalCloseQuestion(text, question = PERMISSION_GRANTED_FINAL_QUESTION) {
  const normalized = normalizeForIntent(text);
  const questionNorm = normalizeForIntent(question);
  if (questionNorm && normalized.includes(questionNorm)) return true;
  return (
    /\bhaben sie noch\b/i.test(normalized) &&
    (/\bkurze frage\b/i.test(normalized) || /\bverabschieden\b/i.test(normalized))
  );
}

function buildPermissionGrantedWithFinalQuestion(config, turnIndex) {
  const confirmation = PERMISSION_GRANTED_CONFIRMATION_BODY;
  const finalQuestion = PERMISSION_GRANTED_FINAL_QUESTION;
  const naiveLimited = normalizeAssistantResponse(`${confirmation} ${finalQuestion}`, config);
  const responseLimiterRemovedPermissionTail = !responseContainsFinalCloseQuestion(naiveLimited, finalQuestion);

  let assembled = assembleLimitedResponse({ prefix: confirmation, mandatorySuffix: finalQuestion, config });
  let containsFinalQuestion = responseContainsFinalCloseQuestion(assembled.text, finalQuestion);
  let finalPermissionResponseMissingQuestion = !containsFinalQuestion;

  console.log(
    `[voice-assistant] permission granted check turn_index=${turnIndex} permission_granted_contains_final_question=${containsFinalQuestion} final_permission_response_missing_question=${finalPermissionResponseMissingQuestion} response_limiter_removed_permission_tail=${responseLimiterRemovedPermissionTail}`
  );

  if (containsFinalQuestion) {
    return {
      text: assembled.text,
      containsFinalQuestion: true,
      finalPermissionResponseMissingQuestion: false,
      responseLimiterRemovedPermissionTail
    };
  }

  console.log(
    `[voice-assistant] ERROR turn_index=${turnIndex} permission_granted_contains_final_question=false final_permission_response_missing_question=true fallback=compressed_confirmation`
  );

  assembled = assembleLimitedResponse({
    prefix: COMPRESSED_PERMISSION_GRANTED_CONFIRMATION,
    mandatorySuffix: finalQuestion,
    config
  });
  containsFinalQuestion = responseContainsFinalCloseQuestion(assembled.text, finalQuestion);
  finalPermissionResponseMissingQuestion = !containsFinalQuestion;

  if (!containsFinalQuestion) {
    assembled = assembleLimitedResponse({
      prefix: COMPRESSED_PERMISSION_GRANTED_CONFIRMATION,
      mandatorySuffix: "Haben Sie noch eine kurze Frage, oder darf ich mich verabschieden?",
      config
    });
    containsFinalQuestion = responseContainsFinalCloseQuestion(assembled.text, finalQuestion);
    finalPermissionResponseMissingQuestion = !containsFinalQuestion;
  }

  if (!containsFinalQuestion) {
    assembled = { text: COMPRESSED_PERMISSION_GRANTED_FALLBACK, containsRequiredSuffix: true };
    containsFinalQuestion = responseContainsFinalCloseQuestion(assembled.text, finalQuestion);
    finalPermissionResponseMissingQuestion = !containsFinalQuestion;
    console.log(
      `[voice-assistant] ERROR turn_index=${turnIndex} permission_granted_contains_final_question=${containsFinalQuestion} final_permission_response_missing_question=${finalPermissionResponseMissingQuestion} fallback=hard_permission_close`
    );
  }

  console.log(
    `[voice-assistant] permission granted check turn_index=${turnIndex} permission_granted_contains_final_question=${containsFinalQuestion} final_permission_response_missing_question=${finalPermissionResponseMissingQuestion} response_limiter_removed_permission_tail=${responseLimiterRemovedPermissionTail}`
  );

  return {
    text: assembled.text,
    containsFinalQuestion,
    finalPermissionResponseMissingQuestion,
    responseLimiterRemovedPermissionTail
  };
}

function configuredContactEmail(config) {
  const value = String(config?.assistant?.contactEmail || "").trim();
  return value.includes("@") ? value : "";
}

function configuredWebsiteUrl(config) {
  return String(config?.assistant?.websiteUrl || "").trim();
}

function emailContactReferenceText(config) {
  const address = configuredContactEmail(config);
  if (address) return `Sie können uns an ${address} schreiben.`;
  return "Die E-Mail-Adresse finden Sie auf unserer Website.";
}

function contactDeclinedText(config) {
  return `Kein Problem. ${emailContactReferenceText(config)}`;
}

function wordsFrom(text) {
  return normalizeForIntent(text)
    .replace(/[^a-z0-9\s-]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeForIntent(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[’'`´]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasMostlyFiller(words) {
  if (!words.length) return true;
  const informative = words.filter((word) => word.length >= 4 && !FILLER_WORDS.has(word));
  return !informative.length || (words.length <= 2 && words.every((word) => FILLER_WORDS.has(word)));
}

function looksTruncated(text) {
  const normalized = normalizeForIntent(text);
  if (!normalized) return false;
  if (/(\.\.\.|…)\s*$/u.test(String(text ?? "").trim())) return true;
  if (/\b(und|oder|aber|weil|wenn|mit|für|fur|da|das|die|der|den|dem|ein|eine|einen|ich habe|ich wollte|ich brauche|können sie|konnen sie)\s*$/i.test(normalized)) {
    return true;
  }
  return false;
}

function looksMalformed(text, intent) {
  if (intent) return false;
  const normalized = normalizeForIntent(text);
  if (!normalized) return false;
  const words = wordsFrom(text);
  const alphaChars = normalized.replace(/[^a-z]/g, "").length;
  const oddWords = words.filter((word) => word.length >= 6 && !/[aeiou]/.test(word));
  if (alphaChars >= 8 && words.length <= 4 && oddWords.length) return true;
  if (/\b(sizinze|sizine|sinse|siense|sindse)\b/i.test(normalized)) return true;
  return false;
}

function isWeakTranscript(text, minChars) {
  return classifyTranscript(text, minChars, detectIntent(text)).quality !== "clear";
}

function classifyTranscript(text, minChars, intent) {
  const words = wordsFrom(text);
  const compact = words.join("");
  if (compact.length < minChars && !intent) return { quality: "unclear", reason: "too_short" };
  if (hasMostlyFiller(words) && !intent) return { quality: "unclear", reason: "mostly_filler" };
  if (looksMalformed(text, intent)) return { quality: "malformed", reason: "likely_malformed_stt" };
  if (intent) return { quality: "clear", reason: "intent_detected" };
  if (looksTruncated(text)) return { quality: "incomplete", reason: "looks_truncated" };
  if (!intent && words.length <= 4 && !/[?]/.test(String(text ?? ""))) {
    return { quality: "unclear", reason: "no_clear_intent" };
  }
  return { quality: "clear", reason: "clear" };
}

function detectIntent(text) {
  const lower = normalizeForIntent(text);
  if (
    /\b(mochte ich nicht sagen|moechte ich nicht sagen|lieber nicht|keine daten|keine angaben|ich schreibe ihnen selbst|ich sende eine e-?mail|ich melde mich selbst|nicht weitergeben)\b/i.test(
      lower
    )
  ) {
    return "refuses_contact_details";
  }
  if (/\b(per e-?mail|per e mail|per mail|per email|e-?\s*mail\s*,?\s*bitte|e mail\s*,?\s*bitte|email\s*,?\s*bitte|mail\s*,?\s*bitte|e-?mail ist besser|e mail ist besser|mail ist besser|schreiben sie mir)\b/i.test(lower)) {
    return "contact_preference_email";
  }
  if (/\b(telefonisch|per telefon|telefon ist besser|per anruf|anruf bitte|anrufen bitte|ruckruf bitte|rueckruf bitte|rufen sie mich an)\b/i.test(lower)) {
    return "contact_preference_phone";
  }
  if (/@|\b(punkt de|punkt com|gmail|outlook|web\.?de|gmx|mail adresse|e-?mail adresse)\b/i.test(lower)) {
    return "email_provided";
  }
  if (
    /\b(plus vier neun|0049|017|015|016|null eins|eins sieben|eins funf|eins sechs)\b/i.test(lower) ||
    /(?:\b\d[\d\s/-]{5,}\d\b)/.test(lower)
  ) {
    return "phone_provided";
  }
  if (
    /\b(can you|in english|english|speak english|hello there|could you help me|please help)\b/i.test(lower)
  ) {
    return "english_language";
  }
  if (
    /\b(platz eins|platz 1|seite 1|erste seite|google bringen|bei google nach oben|ranking garantieren|ranking garantie|garantie.*google|google.*garantie|platz eins bei google|auf platz eins|mich auf platz|mich auf)\b/i.test(lower)
  ) {
    return "seo_guarantee_question";
  }
  if (/\b(preis|preise|kostet|kosten|teuer|budget|angebot)\b/i.test(lower) || /\bwas kostet\b/i.test(lower)) {
    return "pricing_question";
  }
  const earlyPolicyMatch = matchProductPolicyFromText(text);
  if (earlyPolicyMatch?.key && isCompactProductInterestPhrase(lower)) {
    const mappedId = earlyPolicyMatch.key === "digital_assistant" ? "voice_agent" : earlyPolicyMatch.key;
    return productSelectionIntent(mappedId);
  }
  if (
    /\b(echte person|echter mensch|real person|ein mensch|einen mensch|eine person|bist du.*mensch|sind sie.*mensch|sind sie.*person|sehen sie.*mensch|sehn se.*mensch|spreche ich.*(ki|bot|assistent)|sind sie.*(echt|ki|bot|assistent)|roboter)\b/i.test(lower) ||
    (/\b(ki|ai|bot|digitaler assistent)\b/i.test(lower) &&
      !/\b(ai assistant|ai voice assistant|voice assistant|voice bot|call bot|ki assistent|ki telefonassistent)\b/i.test(lower)) ||
    /\b(sizinze|sizine|sinse|siense|sindse)\b.*\b(echte|person|mensch)\b/i.test(lower)
  ) {
    return "human_or_ai_question";
  }
  if (
    /\b(mit jemandem sprechen|mit einem menschen sprechen|mit einem mensch sprechen|einen menschen sprechen|einen mitarbeiter sprechen|mitarbeiter sprechen|team sprechen|geben sie das bitte weiter|geben sie es bitte weiter|team soll sich melden|jemand soll sich melden|kann mich jemand zuruckrufen|kann mich jemand zurueckrufen)\b/i.test(
      lower
    )
  ) {
    return "handoff_requested";
  }
  if (/\b(ruckruf|rueckruf|zuruckrufen|zurueckrufen|zuruck rufen|zurueck rufen|rufen sie mich|morgen.*rufen|morgen.*ruck|wann passt|callback|call ?back)\b/i.test(lower)) {
    return "callback_request";
  }
  if (
    /\b(kostenlose ersteinschaetzung|kostenlose ersteinschatzung|kostenlose analyse|erstanalyse|ersteinschaetzung)\b/i.test(
      lower
    )
  ) {
    return "free_analysis_request";
  }
  if (
    /\b(ich habe ihre e-?mail bekommen|ich habe eine e-?mail von ihnen bekommen|wegen ihrer e-?mail|wegen der nachricht|sie haben mir geschrieben|ich rufe wegen der e-?mail an)\b/i.test(lower)
  ) {
    return "email_campaign_caller";
  }
  if (
    /\b(welche technik|welche technologie|wie funktioniert das technisch|was steckt dahinter|technik dahinter)\b/i.test(
      lower
    )
  ) {
    return "technology_question";
  }
  if (isProductOverviewRequest(lower)) {
    return "product_overview_request";
  }
  if (isCompareProductsRequest(lower)) {
    return "compare_products_request";
  }
  {
    const productMatch = detectNamedProductMatch(lower);
    if (productMatch.id) {
      console.log(
        `[voice-assistant] product detection product_name_detected=${productMatch.id} product_detection_reason=${productMatch.reason || "explicit_name"}`
      );
      return productSelectionIntent(productMatch.id);
    }
  }
  if (/\b(was machen|machen sie genau|was macht|macht ihr|was bieten|wer ist technolohit)\b/i.test(lower)) {
    return "what";
  }
  if (
    /\b(website|websites|webseite|webseiten|homepage|homepages|internetauftritt)\b/i.test(lower) &&
    /\b(bauen|bauen sie|bouwen|erstellen|machen|entwickeln)\b/i.test(lower)
  ) {
    return "website";
  }
  if (/\b(bauen sie web|bouwen sie web|machen sie web|erstellen sie web)\b/i.test(lower)) {
    return "website";
  }
  if (/\b(intelligente website|intelligente websites|smart website|smarte website|neue website|moderne website)\b/i.test(lower)) {
    return "smart_website_interest";
  }
  if (/\b(website|websites|webseite|webseiten|homepage|homepages|internetauftritt)\b/i.test(lower)) {
    return "smart_website_interest";
  }
  if (/\b(telefonassistent|telefon assistent|telefon assistenten|so einen assistent|so einen telefon|assistent wie du|assistent|assistenten|rezeption|voice assistant|sprachassistent|ki telefon|telefon|anruf|anrufe beantworten|kundenservice)\b/i.test(lower)) {
    return "voice_assistant_question";
  }
  if (/\b(anfrage|anfragen|kundenanfrage|kundenfragen|kontakt|formular)\b/i.test(lower)) return "inquiries";
  if (/\b(sichtbarkeit|google|lokal|gefunden|ranking|seo)\b/i.test(lower)) return "visibility";
  return "";
}

function callerIntent(text) {
  return detectIntent(text);
}

function templateResponseForIntent(intent, config, callerText = "") {
  const caller = normalizeForIntent(callerText);
  const responses = {
    pricing_question:
      "Das hängt vom Umfang ab. Wenn Sie möchten, prüft unser Team Ihre Situation kurz und gibt Ihnen eine erste Einschätzung.",
    human_or_ai_question: "Ich bin der digitale Assistent von TechnoloHit.",
    what:
      "TechnoloHit bietet intelligente Websites, AISeoQ für SEO-Analysen, Botinteg für Chatbots und Automatisierung, LokalKI für sensible interne Daten und digitale Assistenten für Telefon und Empfang. Welches Thema interessiert Sie am meisten?",
    smart_website_interest:
      "Eine intelligente Website ist mehr als eine normale Homepage. Sie verbindet klare Seitenstruktur, KI-Chat und Anfrage-Erfassung - soll Ihre Website verbessert werden oder neu entstehen?",
    website:
      "Ja, TechnoloHit erstellt intelligente Websites für lokale Unternehmen. Haben Sie bereits eine Website?",
    product_overview_request: productOverviewResponse(config, DEFAULT_PRODUCT_CATALOG),
    product_selection_smart_website: productSelectionResponse(config, DEFAULT_PRODUCT_CATALOG, "smart_website"),
    product_selection_aiseoq: productSelectionResponse(config, DEFAULT_PRODUCT_CATALOG, "aiseoq"),
    product_selection_botinteg: productSelectionResponse(config, DEFAULT_PRODUCT_CATALOG, "botinteg"),
    product_selection_lokalki: productSelectionResponse(config, DEFAULT_PRODUCT_CATALOG, "lokalki"),
    product_selection_voice_agent: productSelectionResponse(config, DEFAULT_PRODUCT_CATALOG, "voice_agent"),
    product_more_detail_request: UNKNOWN_FALLBACK_TEXT,
    compare_products_request: compareProductsResponse(config),
    product_interest_confirmed: INTEREST_CONTACT_PREFERENCE_TEXT,
    product_interest_declined: "Alles klar. Haben Sie noch eine weitere Frage?",
    voice_assistant_question:
      "Ja, so ein Telefonassistent kann Teil der Lösung sein. Soll er Anrufe oder Website-Anfragen vorbereiten?",
    technology_question:
      "TechnoloHit nutzt eigene KI- und Automatisierungslösungen. Die Details erklärt Ihnen unser Team gern persönlich.",
    free_analysis_request:
      "Ja, gerne. Wir können Ihre Anfrage für eine kostenlose Ersteinschätzung aufnehmen. Wann passt Ihnen ein kurzes Telefonat am besten?",
    callback_request: /\bmorgen\b/i.test(caller)
      ? "Gerne. Wann passt Ihnen morgen ein kurzes Telefonat?"
      : "Gerne. Wann passt Ihnen ein kurzes Telefonat?",
    email_campaign_caller:
      "Danke, dann geht es um die kostenlose Website-Ersteinschätzung. Für welches Unternehmen rufen Sie an?",
    english_language:
      "Ich kann Ihnen aktuell am besten auf Deutsch helfen. Möchten Sie Ihr Anliegen kurz auf Deutsch beschreiben?",
    seo_guarantee_question:
      "Seriöse Ranking-Garantien geben wir nicht. Wir verbessern Struktur und Inhalte, damit Ihre Website bessere Chancen bei passenden Suchanfragen hat.",
    inquiries:
      "Ja, TechnoloHit kann helfen, Kundenanfragen strukturierter aufzunehmen und an das Team weiterzugeben. Über welchen Kanal kommen Ihre Anfragen heute meistens?",
    visibility:
      "TechnoloHit kann Website-Struktur und Inhalte auf relevante Suchanfragen ausrichten. Für welche Stadt oder Branche ist das für Sie interessant?"
  };
  return responses[intent] ? normalizeAssistantResponse(responses[intent], config) : "";
}

function unknownResponse(config) {
  return normalizeAssistantResponse(UNKNOWN_INTENT_TEXT, config);
}

function isCompactProductInterestPhrase(text) {
  const lower = normalizeForIntent(text);
  return /\b(interessiere mich|interessiert mich|brauche|mochte|möchte|will|wurde gern|konnte ich|bekommen|fur meine firma|für meine firma)\b/i.test(
    lower
  );
}

function buildCompactProductInterestResponse(config, productId) {
  const salesPitch = buildSalesProductPitch(config, productId);
  if (salesPitch) return normalizeAssistantResponse(salesPitch, config);
  if (productId === "voice_agent") {
    return normalizeAssistantResponse(
      "Verstanden, es geht um den KI-Telefonassistenten und die digitale Rezeption. Kurze Erklärung oder telefonischer Kontakt durch unser Team?",
      config
    );
  }
  const policy = productPolicyById(productId);
  if (!policy) return unknownResponse(config);
  return normalizeAssistantResponse(
    `Verstanden, es geht um ${policy.displayName}. Möchten Sie dazu eine kurze Erklärung, oder soll unser Team Sie telefonisch kontaktieren?`,
    config
  );
}

function isProductExplanationChoice(text) {
  const lower = normalizeForIntent(text);
  const compact = lower.replace(/[^a-z0-9]/g, "");
  return (
    /\b(erklar|erklär|erklaer|erklaeren|erklären|mehr dazu|mehr informationen|kurz mehr|kurze info|wie funktioniert|was ist|was ist das genau|details)\b/i.test(
      lower
    ) ||
    compact.includes("erklaerung") ||
    compact.includes("erklärung") ||
    compact.includes("kurzerklarung") ||
    compact.includes("kurzeerklarung") ||
    compact.includes("erklarmirdas") ||
    compact.includes("erklaermirdas")
  );
}

function isProductCallbackChoice(text) {
  const lower = normalizeForIntent(text);
  return (
    callbackPhraseIndicatesPhone(text) ||
    /\b(telefon|ruckruf|rueckruf|rückruf|zuruckrufen|zurueckrufen|team.*melden|zuruck melden)\b/i.test(lower)
  );
}

function appendRagFollowUpQuestion(text, config) {
  const base = normalizeAssistantResponse(text, config);
  if (!base) return base;
  if (/\?\s*$/.test(base)) return base;
  const followUp = "Haben Sie dazu noch eine kurze Frage, oder soll unser Team Sie telefonisch kontaktieren?";
  return normalizeAssistantResponse(`${base} ${followUp}`, config);
}

function asksForCallback(text) {
  const normalized = normalizeForIntent(text);
  return /\b(ruckruf|rueckruf|zuruckrufen|zurueckrufen|wann passt|meldet sich|team.*personlich|team.*persoenlich)\b/i.test(
    normalized
  );
}

function createProductState() {
  return {
    overviewOffered: false,
    awaitingSelection: false,
    awaitingInterestConfirmation: false,
    selectedProduct: null,
    selectedProductName: null,
    productDialogueState: "idle",
    handoffChoice: "none",
    botintegFollowupResolved: false,
    botintegFollowupRetryCount: 0,
    customerType: null,
    salesNeedCaptured: false,
    salesContext: {},
    lastProductIntent: null,
    lastProductTurnIndex: null
  };
}

function ensureProductState(state) {
  if (!state.product) state.product = createProductState();
  return state.product;
}

function productStage(product) {
  if (product?.awaitingInterestConfirmation) return "awaiting_interest_confirmation";
  if (product?.awaitingSelection) return "awaiting_selection";
  if (product?.selectedProduct) return "selected";
  if (product?.overviewOffered) return "overview_offered";
  return "not_started";
}

function productDialogueStage(product) {
  return product?.productDialogueState || "idle";
}

function normalizedProductIntakeStage(product) {
  const stage = productDialogueStage(product);
  if (stage === "product_pitch_interest_question") return "product_pitch_interest_question";
  if (stage === "product_interest_confirmed") return "product_interest_confirmed";
  if (stage === "product_interest_declined") return "product_interest_declined";
  if (stage === "sales_customer_type") return "sales_customer_type";
  if (stage === "sales_need_discovery") return "sales_need_discovery";
  if (stage === "sales_handoff_offer") return "sales_handoff_offer";
  if (stage === "handoff_choice_requested") return "handoff_choice_requested";
  if (stage === "email_instruction_given") return "email_instruction";
  if (stage === "phone_requested") return "phone_requested";
  if (stage === "permission_requested") return "permission_requested";
  if (stage === "closing_pending" || stage === "completed") return "closing";
  if (stage === "pitch") return "product_pitch_interest_question";
  return stage;
}

function productMetadata(product) {
  return {
    productFlowState: product ? productStage(product) : "not_started",
    productOverviewOffered: Boolean(product?.overviewOffered),
    productAwaitingSelection: Boolean(product?.awaitingSelection),
    productAwaitingInterestConfirmation: Boolean(product?.awaitingInterestConfirmation),
    productInterest: product?.selectedProduct ?? null,
    productInterestName: product?.selectedProductName ?? null,
    productDialogueState: productDialogueStage(product),
    handoffChoice: product?.handoffChoice || "none",
    productIntakeProduct: product?.selectedProduct ?? null,
    productIntakeStage: normalizedProductIntakeStage(product),
    botintegFollowupResolved: Boolean(product?.botintegFollowupResolved),
    botintegFollowupRetryCount: Number(product?.botintegFollowupRetryCount ?? 0),
    customerType: product?.customerType ?? null,
    salesNeedCaptured: Boolean(product?.salesNeedCaptured),
    salesStage: product?.productDialogueState?.startsWith("sales_") ? product.productDialogueState : null,
    currentProblem: product?.salesContext?.current_problem ?? "",
    desiredOutcome: product?.salesContext?.desired_outcome ?? "",
    productLastIntent: product?.lastProductIntent ?? null
  };
}

function isProductFlowActive(product) {
  if (!product) return false;
  return Boolean(product.awaitingSelection || product.awaitingInterestConfirmation);
}

function productList(catalog) {
  const products = Array.isArray(catalog?.products) ? catalog.products : DEFAULT_PRODUCT_CATALOG.products;
  return products
    .filter((product) => product?.id && product?.name)
    .sort((a, b) => Number(a.number ?? 99) - Number(b.number ?? 99));
}

function productById(catalog, productId) {
  return productList(catalog).find((product) => product.id === productId) || null;
}

function productOverviewResponse(config, catalog) {
  const listed = "intelligente Websites, AISeoQ für SEO-Analysen, Botinteg für Chatbots und Automatisierung, LokalKI für sensible interne Daten und digitale Assistenten für Telefon und Empfang";
  return normalizeAssistantResponse(
    `TechnoloHit bietet ${listed}. Welches Thema interessiert Sie am meisten?`,
    config
  );
}

function productSelectionResponse(config, catalog, productId) {
  const policy = productPolicyById(productId);
  if (!policy) return normalizeAssistantResponse(UNKNOWN_FALLBACK_TEXT, config);
  const assembled = assembleLimitedResponse({
    prefix: policy.pitchShort,
    mandatorySuffix: policy.mandatoryInterestQuestion,
    config
  });
  return assembled.text;
}

function productDetailResponse(config, catalog, productId) {
  const policy = productPolicyById(productId);
  if (!policy) return normalizeAssistantResponse(UNKNOWN_FALLBACK_TEXT, config);
  const salesPitch = buildSalesProductPitch(config, productId);
  if (salesPitch) return normalizeAssistantResponse(salesPitch, config);
  if (productId === "voice_agent") {
    return normalizeAssistantResponse(
      "Die Digitale Rezeption beantwortet Anrufe, fragt das Anliegen ab und notiert wichtige Infos. Möchten Sie per E-Mail starten oder telefonisch?",
      config
    );
  }
  const assembled = assembleLimitedResponse({
    prefix: policy.pitchShort,
    mandatorySuffix: policy.mandatoryInterestQuestion,
    config
  });
  return assembled.text;
}

function buildPitchWithMandatoryQuestion(config, productId, turnIndex) {
  const policy = productPolicyById(productId);
  if (!policy) return { text: normalizeAssistantResponse(UNKNOWN_FALLBACK_TEXT, config), containsQuestion: false };
  const question = String(policy.mandatoryInterestQuestion || "").trim();
  const pitch = String(policy.pitchShort || "").trim();
  let assembled = assembleLimitedResponse({ prefix: pitch, mandatorySuffix: question, config });
  let containsQuestion = responseContainsInterestQuestion(assembled.text, question);
  console.log(
    `[voice-assistant] product intake check turn_index=${turnIndex} product_intake_product=${productId} product_pitch_contains_next_question=${containsQuestion}`
  );
  if (containsQuestion) return { text: assembled.text, containsQuestion: true };

  console.log(
    `[voice-assistant] ERROR turn_index=${turnIndex} product_intake_product=${productId} product_pitch_contains_next_question=false fallback=compressed_pitch`
  );

  const pitchFirstSentence = (pitch.match(/[^.!?]+[.!?]?/g) || [pitch])[0].trim();
  assembled = assembleLimitedResponse({ prefix: pitchFirstSentence, mandatorySuffix: question, config });
  containsQuestion = responseContainsInterestQuestion(assembled.text, question);
  if (!containsQuestion) {
    assembled = assembleLimitedResponse({ prefix: "", mandatorySuffix: question, config });
    containsQuestion = responseContainsInterestQuestion(assembled.text, question);
  }
  if (!containsQuestion) {
    console.log(
      `[voice-assistant] ERROR turn_index=${turnIndex} product_intake_product=${productId} product_pitch_contains_next_question=false`
    );
  }
  return { text: assembled.text, containsQuestion };
}

function buildInterestConfirmedWithHandoffQuestion(config, productId, turnIndex, acknowledgement) {
  const policy = productPolicyById(productId);
  const ack = String(
    acknowledgement || policy?.interestConfirmedAcknowledgement || DEFAULT_INTEREST_CONFIRMED_ACK
  ).trim();
  const handoffQuestion = String(policy?.handoffChoiceQuestion || DEFAULT_HANDOFF_CHOICE_QUESTION).trim();
  let assembled = assembleLimitedResponse({ prefix: ack, mandatorySuffix: handoffQuestion, config });
  let containsHandoffQuestion = responseContainsHandoffQuestion(assembled.text, handoffQuestion);
  console.log(
    `[voice-assistant] product intake check turn_index=${turnIndex} product_intake_product=${productId || "none"} product_interest_confirmed_contains_handoff_question=${containsHandoffQuestion}`
  );
  if (containsHandoffQuestion) return { text: assembled.text, containsHandoffQuestion: true };

  console.log(
    `[voice-assistant] ERROR turn_index=${turnIndex} product_intake_product=${productId || "none"} product_interest_confirmed_contains_handoff_question=false fallback=compressed_ack`
  );

  assembled = assembleLimitedResponse({
    prefix: COMPRESSED_INTEREST_CONFIRMED_ACK,
    mandatorySuffix: handoffQuestion,
    config
  });
  containsHandoffQuestion = responseContainsHandoffQuestion(assembled.text, handoffQuestion);
  if (!containsHandoffQuestion) {
    assembled = assembleLimitedResponse({
      prefix: COMPRESSED_INTEREST_CONFIRMED_ACK,
      mandatorySuffix: "Möchten Sie per E-Mail starten oder soll unser Team Sie telefonisch kontaktieren?",
      config
    });
    containsHandoffQuestion = responseContainsHandoffQuestion(assembled.text, handoffQuestion);
  }
  if (!containsHandoffQuestion) {
    assembled = { text: COMPRESSED_HANDOFF_FALLBACK_TEXT, containsRequiredSuffix: true };
    containsHandoffQuestion = responseContainsHandoffQuestion(assembled.text, handoffQuestion);
    console.log(
      `[voice-assistant] ERROR turn_index=${turnIndex} product_intake_product=${productId || "none"} product_interest_confirmed_contains_handoff_question=false fallback=hard_handoff`
    );
  }
  return { text: assembled.text, containsHandoffQuestion };
}

function markHandoffChoiceRequested(ctx, productState, productId, turnIndex) {
  productState.productDialogueState = "handoff_choice_requested";
  const intake = ensureIntakeState(turnState(ctx));
  intake.contactPreferenceAsked = true;
  intake.waitingFor = "contact_preference";
  console.log(
    `[voice-assistant] product_intake_product=${productId || productState.selectedProduct || "none"} product_intake_stage=handoff_choice_requested handoff_choice=none turn_index=${turnIndex}`
  );
}

function productSelectionIntent(productId) {
  return PRODUCT_ID_TO_INTENT[productId] || "";
}

function isProductOverviewRequest(lower) {
  return /\b(welche produkte|welche produkt|was fur produkte|was fuer produkte|produktliste|liste der produkte|welche losungen|welche loesungen|was fur losungen|was fuer loesungen|alle losungen|alle loesungen|was bieten sie|was bietet ihr|was bietet technolohit|was verkaufen sie|was gibt es bei ihnen|was haben sie fur produkte|was haben sie fuer produkte)\b/i.test(
    lower
  );
}

function isProductExplanationRequest(lower) {
  return /\b(was ist|was bedeutet|erklar|erklaer|erklaren sie|erzaehl|erzahlen sie|mehr uber|mehr ueber|details zu|kurz mehr|produkt)\b/i.test(
    lower
  );
}

function detectNamedProductMatch(text, options = {}) {
  const lower = normalizeForIntent(text);
  const compact = lower.replace(/[^a-z0-9]/g, "");
  const force = Boolean(options.force);
  const explanation = force || isProductExplanationRequest(lower);

  if (/\b(aiseoq|ai seo q|ai seoq|a i seo q|seo q|seo arbeitsbereich|seo workspace)\b/i.test(lower)) {
    return { id: "aiseoq", reason: "explicit_name" };
  }
  if (
    /\b(botinteg|bot integ|botintek|botintegg|ki chatbot|ki chatbots|chatbot|chatbots|chat bot|faq bot|automatisierung|automation|whatsapp|instagram|facebook)\b/i.test(
      lower
    ) ||
    compact.includes("botinteg") ||
    compact.includes("botintek") ||
    compact.includes("botintegg")
  ) {
    return { id: "botinteg", reason: /\bbotinteg|bot integ|botintek|botintegg\b/i.test(lower) ? "explicit_name" : "alias" };
  }
  if (/\b(lokalki|lokal ki|lokale ki|private ki|privater chatgpt|chatgpt private|offline ki|interne ki|sensiblen daten|sensible daten|eigener server)\b/i.test(lower)) {
    return { id: "lokalki", reason: "explicit_name" };
  }
  if (/\b(digitale rezeption|digital reception|voice agent|voice assistant|ai voice agent|ai assistant|ai voice assistant|voice bot|call bot|sprachassistent)\b/i.test(lower)) {
    return { id: "voice_agent", reason: "explicit_name" };
  }
  if (
    /\b(ki assistent|ki telefonassistent|telefonassistent|telefon assistent|ki telefon|anrufe beantworten|digitaler assistent|telefon ki)\b/i.test(
      lower
    )
  ) {
    return { id: "voice_agent", reason: "alias" };
  }
  if (/\b(smart website|smart webseite|smarte website|smarte webseite|intelligente website|intelligente webseite)\b/i.test(lower) && explanation) {
    return { id: "smart_website", reason: "explicit_name" };
  }
  const policyMatch = matchProductPolicyFromText(text);
  if (policyMatch?.key) {
    if (policyMatch.key === "digital_assistant") return { id: "voice_agent", reason: "policy_alias" };
    return { id: policyMatch.key, reason: "policy_alias" };
  }
  return { id: "", reason: "none" };
}

function detectNamedProductId(text, options = {}) {
  return detectNamedProductMatch(text, options).id;
}

function detectProductNumberId(text, allowBareNumber = false) {
  const lower = normalizeForIntent(text).replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  const compact = lower.replace(/[^a-z0-9]/g, "");
  const candidates = [
    ["1", "(?:1|eins|ein|erste|erster)"],
    ["2", "(?:2|zwei|zweite|zweiter)"],
    ["3", "(?:3|drei|dritte|dritter)"],
    ["4", "(?:4|vier|vierte|vierter)"],
    ["5", "(?:5|funf|fuenf|fünf|funfte|fuenfte|fünfte|funfter|fuenfter|fünfter)"]
  ];

  for (const [number, pattern] of candidates) {
    const explicit = new RegExp(`\\b(?:nummer|produkt|punkt|zahl|losung|loesung)\\s*${pattern}\\b`, "i");
    const bare = new RegExp(`^${pattern.replaceAll("(?:", "(?:")}$`, "i");
    if (explicit.test(lower) || (allowBareNumber && bare.test(compact))) {
      return PRODUCT_NUMBER_TO_ID[number] || "";
    }
  }
  return "";
}

function detectProductSelectionId(text, options = {}) {
  return detectProductSelectionMatch(text, options).id;
}

function detectProductSelectionMatch(text, options = {}) {
  const allowNumber = Boolean(options.allowNumber);
  const numberId = detectProductNumberId(text, allowNumber);
  if (numberId) return { id: numberId, reason: "number" };
  const named = detectNamedProductMatch(text, options);
  return { id: named.id, reason: named.reason };
}

function isLikelySttPromptLeak(text) {
  const normalized = normalizeForIntent(text).replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (STT_PROMPT_LEAK_PATTERN.test(normalized)) return true;
  return (
    normalized.includes("telefonat mit technolohit") &&
    normalized.includes("mogliche begriffe") &&
    normalized.includes("smart website") &&
    normalized.includes("botinteg")
  );
}

function callbackPhraseIndicatesPhone(callerText) {
  const normalized = normalizeForIntent(callerText);
  return /\b(ja,\s*ein\s*(ruckruf|rueckruf|rückruf)|ja\s*(ruckruf|rueckruf|rückruf)|(ruckruf|rueckruf|rückruf)\s*bitte|telefonisch|per telefon|anruf bitte|rufen sie mich an|callback|call back|hochboost|hoch boost)\b/i.test(
    normalized
  );
}

function isProductMoreDetailRequest(text) {
  const lower = normalizeForIntent(text);
  return /\b(mehr|mehr dazu|mehr information|genauer|details|detail|ausfuhrlicher|ausführlicher|erklaren sie|erklaeren sie|erzahl|erzaehl|wie funktioniert)\b/i.test(
    lower
  );
}

function isCompareProductsRequest(text) {
  const lower = normalizeForIntent(text);
  return /\b(unterschied|unterschiede|vergleichen|vergleich|welches produkt passt|welche losung passt|welche loesung passt|was passt besser)\b/i.test(
    lower
  );
}

function isPositiveShortAnswer(text) {
  return detectPermissionAnswer(text).value === "granted";
}

function isNegativeShortAnswer(text) {
  return detectPermissionAnswer(text).value === "denied" || isClosingAnswer(text);
}

function resolveProductIntent(callerText, detectedIntent, product, intake) {
  const intent = detectedIntent && detectedIntent !== "unknown" ? detectedIntent : "";
  const lower = normalizeForIntent(callerText);
  const intakeActive = Boolean(intake && (intake.contactPreferenceAsked || isIntakeActive(intake)));

  if (intakeActive) {
    const preferenceMatch = detectContactPreferenceMatch(callerText, intent, intake);
    if (preferenceMatch.preference === "email") return "contact_preference_email";
    if (preferenceMatch.preference === "phone") return "contact_preference_phone";
    if (intent === "callback_request" || intent === "contact_preference_email" || intent === "contact_preference_phone") {
      return intent;
    }
    if (intent.startsWith("product_selection_") && String(callerText || "").trim().length <= 32) {
      return "unknown";
    }
  }

  if (intent === "smart_website_interest") return "product_selection_smart_website";

  if (product?.awaitingSelection) {
    const productMatch = detectProductSelectionMatch(callerText, { allowNumber: true, force: true });
    if (productMatch.id) {
      console.log(
        `[voice-assistant] product detection product_name_detected=${productMatch.id} product_detection_reason=${productMatch.reason || "explicit_name"}`
      );
      return productSelectionIntent(productMatch.id);
    }
    if (isCompareProductsRequest(callerText)) return "compare_products_request";
  }

  if (product?.awaitingInterestConfirmation) {
    if (isCompareProductsRequest(callerText)) return "compare_products_request";
    if (intent === "contact_preference_email" || intent === "contact_preference_phone" || intent === "callback_request") {
      return intent;
    }
    if (product?.selectedProduct && intent === productSelectionIntent(product.selectedProduct)) {
      return "unknown";
    }
    const productMatch = detectProductSelectionMatch(callerText, { allowNumber: true, force: true });
    if (productMatch.id) {
      console.log(
        `[voice-assistant] product detection product_name_detected=${productMatch.id} product_detection_reason=${productMatch.reason || "explicit_name"}`
      );
      return productSelectionIntent(productMatch.id);
    }
    if (isProductMoreDetailRequest(callerText)) return "product_more_detail_request";
  }

  if (intent) return intent;
  if (isProductOverviewRequest(lower)) return "product_overview_request";
  if (isCompareProductsRequest(callerText)) return "compare_products_request";
  if (product?.selectedProduct && isProductMoreDetailRequest(callerText)) return "product_more_detail_request";
  const productMatch = detectProductSelectionMatch(callerText, { allowNumber: false });
  if (productMatch.id) {
    console.log(
      `[voice-assistant] product detection product_name_detected=${productMatch.id} product_detection_reason=${productMatch.reason || "explicit_name"}`
    );
  }
  return productSelectionIntent(productMatch.id);
}

function setSelectedProduct(productState, catalog, productId, intent, turnIndex) {
  const product = productById(catalog, productId);
  productState.overviewOffered = true;
  productState.awaitingSelection = false;
  productState.awaitingInterestConfirmation = true;
  productState.selectedProduct = productId;
  productState.selectedProductName = product?.name || productId;
  productState.productDialogueState = "sales_customer_type";
  productState.botintegFollowupResolved = productId !== "botinteg";
  productState.botintegFollowupRetryCount = 0;
  productState.customerType = null;
  productState.salesNeedCaptured = false;
  productState.salesContext = {};
  productState.lastProductIntent = intent;
  productState.lastProductTurnIndex = turnIndex;
}

function compareProductsResponse(config) {
  return normalizeAssistantResponse(
    "Kurz gesagt: Smart Website ist für Sichtbarkeit und Leads, Botinteg für Chat und Automatisierung, LokalKI für private Daten. Welches Thema ist für Sie wichtiger?",
    config
  );
}

function maybeCreateProductResponse(config, ctx, turnIndex, callerText, analysis, catalog) {
  const productState = ensureProductState(turnState(ctx));
  const intent = analysis?.detectedIntent ?? "unknown";

  if (intent === "product_overview_request") {
    productState.overviewOffered = true;
    productState.awaitingSelection = true;
    productState.awaitingInterestConfirmation = false;
    productState.lastProductIntent = intent;
    productState.lastProductTurnIndex = turnIndex;
    return {
      text: productOverviewResponse(config, catalog),
      detectedIntent: intent,
      finalResponseTemplate: "product_intake",
      product: productState
    };
  }

  if (intent === "compare_products_request") {
    productState.overviewOffered = true;
    productState.awaitingSelection = true;
    productState.awaitingInterestConfirmation = false;
    productState.lastProductIntent = intent;
    productState.lastProductTurnIndex = turnIndex;
    return {
      text: compareProductsResponse(config),
      detectedIntent: intent,
      finalResponseTemplate: "product_intake",
      product: productState
    };
  }

  const productId = PRODUCT_INTENT_TO_ID[intent];
  if (productId) {
    setSelectedProduct(productState, catalog, productId, intent, turnIndex);
    productState.handoffChoice = "none";
    console.log(
      `[voice-assistant] product_intake_product=${productId} product_intake_stage=sales_customer_type handoff_choice=none turn_index=${turnIndex}`
    );
    return {
      text: buildCompactProductInterestResponse(config, productId),
      detectedIntent: intent,
      finalResponseTemplate: "product_intake",
      product: productState
    };
  }

  if (productState.awaitingSelection && intent === "unknown") {
    return {
      text: normalizeAssistantResponse(
        "Ich habe Sie akustisch nicht sicher verstanden. Sagen Sie bitte nur den Produktnamen oder die Zahl eins bis fünf.",
        config
      ),
      detectedIntent: "product_selection_reask",
      product: productState
    };
  }

  if (productState.awaitingInterestConfirmation && productState.selectedProduct) {
    const policy = productPolicyById(productState.selectedProduct);
    const interestQuestion = policy?.mandatoryInterestQuestion || "Möchten Sie so etwas für Ihr Unternehmen prüfen lassen?";

    if (productState.productDialogueState === "sales_customer_type") {
      if (isProductExplanationChoice(callerText) || intent === "product_more_detail_request") {
        const explanation = buildSalesProductExplanation(productState.selectedProduct);
        const suffix = buildCustomerTypeResponse("unknown", productState.selectedProduct);
        return {
          text: normalizeAssistantResponse(`${explanation} ${suffix}`, config),
          detectedIntent: "sales_product_explanation",
          finalResponseTemplate: "sales_policy",
          product: productState
        };
      }
      const customerType = classifyCustomerType(callerText);
      if (customerType === "unknown") {
        return {
          text: normalizeAssistantResponse(buildCustomerTypeResponse("unknown", productState.selectedProduct), config),
          detectedIntent: "sales_customer_type_reask",
          finalResponseTemplate: "sales_policy",
          product: productState
        };
      }
      productState.customerType = customerType;
      productState.productDialogueState = "sales_need_discovery";
      productState.salesContext.customer_type = customerType;
      return {
        text: normalizeAssistantResponse(buildCustomerTypeResponse(customerType, productState.selectedProduct), config),
        detectedIntent: `sales_customer_type_${customerType}`,
        finalResponseTemplate: "sales_policy",
        product: productState
      };
    }

    if (productState.productDialogueState === "sales_need_discovery") {
      productState.salesNeedCaptured = true;
      productState.salesContext.current_problem = String(callerText || "").replace(/\s+/g, " ").trim().slice(0, 180);
      markHandoffChoiceRequested(ctx, productState, productState.selectedProduct, turnIndex);
      productState.productDialogueState = "sales_handoff_offer";
      return {
        text: normalizeAssistantResponse(buildHandoffOffer(productState.selectedProduct), config),
        detectedIntent: "sales_handoff_offer",
        finalResponseTemplate: "sales_policy",
        product: productState
      };
    }

    if (productState.productDialogueState === "product_compact_offer") {
      if (
        isProductCallbackChoice(callerText) ||
        isPositiveShortAnswer(callerText) ||
        intent === "contact_preference_phone" ||
        intent === "callback_request"
      ) {
        productState.productDialogueState = "handoff_choice_requested";
        productState.handoffChoice = "phone";
        console.log(
          `[voice-assistant] product_intake_product=${productState.selectedProduct} product_intake_stage=handoff_choice_requested handoff_choice=phone turn_index=${turnIndex}`
        );
        return null;
      }
      if (isProductExplanationChoice(callerText) || intent === "product_more_detail_request") {
        markHandoffChoiceRequested(ctx, productState, productState.selectedProduct, turnIndex);
        const detailResponse = productDetailResponse(config, catalog, productState.selectedProduct);
        return {
          text: detailResponse,
          detectedIntent: "product_more_detail_request",
          finalResponseTemplate: "product_intake",
          product: productState
        };
      }
      return {
        text: buildCompactProductInterestResponse(config, productState.selectedProduct),
        detectedIntent: "product_compact_offer_reask",
        finalResponseTemplate: "product_intake",
        product: productState
      };
    }

    const adviceSignal =
      /\b(beratung|beraten|nicht sicher|unsicher|weiss nicht|weiß nicht|keine ahnung|was passt)\b/i.test(
        normalizeForIntent(callerText)
      );
    const interestSignal =
      isPositiveShortAnswer(callerText) ||
      /\b(klingt interessant|interessant|passt fur uns|passt für uns|ja klingt gut|ja klingt interessant)\b/i.test(
        normalizeForIntent(callerText)
      );

    if (productState.productDialogueState === "product_pitch_interest_question") {
      if (interestSignal) {
        const confirmedResponse = buildInterestConfirmedWithHandoffQuestion(
          config,
          productState.selectedProduct,
          turnIndex
        );
        if (confirmedResponse.containsHandoffQuestion) {
          markHandoffChoiceRequested(ctx, productState, productState.selectedProduct, turnIndex);
        } else {
          productState.productDialogueState = "product_interest_confirmed";
        }
        return {
          text: confirmedResponse.text,
          detectedIntent: "product_interest_confirmed",
          finalResponseTemplate: "product_intake",
          product: productState
        };
      }

      if (isNegativeShortAnswer(callerText)) {
        productState.productDialogueState = "product_interest_declined";
        return {
          text: normalizeAssistantResponse(
            "Alles klar. Interessiert Sie ein anderes Produkt, oder möchten Sie eine kurze Beratung?",
            config
          ),
          detectedIntent: "product_interest_declined",
          finalResponseTemplate: "product_intake",
          product: productState
        };
      }

      if (adviceSignal) {
        const consultationResponse = buildInterestConfirmedWithHandoffQuestion(
          config,
          productState.selectedProduct,
          turnIndex,
          CONSULTATION_CONFIRMED_ACK
        );
        if (consultationResponse.containsHandoffQuestion) {
          markHandoffChoiceRequested(ctx, productState, productState.selectedProduct, turnIndex);
        } else {
          productState.productDialogueState = "product_interest_confirmed";
        }
        return {
          text: consultationResponse.text,
          detectedIntent: "product_interest_consultation",
          finalResponseTemplate: "product_intake",
          product: productState
        };
      }

      return {
        text: normalizeAssistantResponse(interestQuestion, config),
        detectedIntent: "product_interest_reask",
        finalResponseTemplate: "product_intake",
        product: productState
      };
    }

    if (intent === "contact_preference_email") {
      productState.productDialogueState = "handoff_choice_requested";
      productState.handoffChoice = "email";
      console.log(
        `[voice-assistant] product_intake_product=${productState.selectedProduct} product_intake_stage=handoff_choice_requested handoff_choice=email turn_index=${turnIndex}`
      );
      return null;
    }
    if (intent === "contact_preference_phone" || intent === "callback_request") {
      productState.productDialogueState = "handoff_choice_requested";
      productState.handoffChoice = "phone";
      console.log(
        `[voice-assistant] product_intake_product=${productState.selectedProduct} product_intake_stage=handoff_choice_requested handoff_choice=phone turn_index=${turnIndex}`
      );
      return null;
    }
    if (intent === "product_interest_declined" || isNegativeShortAnswer(callerText)) {
      productState.awaitingInterestConfirmation = false;
      productState.productDialogueState = "product_interest_declined";
      productState.handoffChoice = "none";
      return {
        text: normalizeAssistantResponse("Alles klar. Interessiert Sie ein anderes Produkt, oder möchten Sie eine kurze Beratung?", config),
        detectedIntent: "product_interest_declined",
        finalResponseTemplate: "product_intake",
        product: productState
      };
    }

    if (productState.productDialogueState === "product_interest_confirmed" || adviceSignal) {
      const retryResponse = buildInterestConfirmedWithHandoffQuestion(
        config,
        productState.selectedProduct,
        turnIndex,
        adviceSignal ? CONSULTATION_CONFIRMED_ACK : undefined
      );
      if (retryResponse.containsHandoffQuestion) {
        markHandoffChoiceRequested(ctx, productState, productState.selectedProduct, turnIndex);
        return {
          text: retryResponse.text,
          detectedIntent: adviceSignal ? "product_interest_consultation" : "handoff_choice_requested",
          finalResponseTemplate: "product_intake",
          product: productState
        };
      }
      productState.productDialogueState = "product_interest_confirmed";
      return {
        text: retryResponse.text,
        detectedIntent: "product_interest_confirmed",
        finalResponseTemplate: "product_intake",
        product: productState
      };
    }

    if (productState.productDialogueState === "handoff_choice_requested") {
      const reaskResponse = buildInterestConfirmedWithHandoffQuestion(
        config,
        productState.selectedProduct,
        turnIndex
      );
      if (reaskResponse.containsHandoffQuestion) {
        return {
          text: reaskResponse.text,
          detectedIntent: "handoff_choice_reask",
          finalResponseTemplate: "product_intake",
          product: productState
        };
      }
    }

    if (productState.productDialogueState === "product_interest_declined") {
      productState.awaitingSelection = true;
      productState.awaitingInterestConfirmation = false;
      return {
        text: normalizeAssistantResponse(
          "Gerne. Welches Thema interessiert Sie: Smart Website, AISeoQ, Botinteg, LokalKI oder digitaler Assistent?",
          config
        ),
        detectedIntent: "product_selection_reopen",
        finalResponseTemplate: "product_intake",
        product: productState
      };
    }

    return null;
  }

  return null;
}

function createIntakeState() {
  return {
    handoffRequested: false,
    callbackRequested: false,
    contactPreferenceAsked: false,
    contactPreference: null,
    contactRoute: null,
    contactPermissionRequested: false,
    contactPermissionGranted: null,
    permissionDetected: null,
    permissionDetectionSource: null,
    permissionRetryCount: 0,
    contactDetailRequested: false,
    contactDetailAttempted: false,
    contactDetailRetryCount: 0,
    contactDetailType: null,
    contactDetailSource: null,
    contactDetailNormalized: "",
    emailDirectOffered: false,
    leadCreated: false,
    waitingFor: null,
    completed: false,
    declined: false,
    failed: false,
    closingPending: false,
    finalQuestionAsked: false,
    finalGoodbyeSent: false,
    failedReason: null,
    maxTurnsExtendedForIntake: false,
    maxTurnsBlockedByActiveIntake: false,
    maxTurnsBlockedByPermissionState: false,
    softIntakeMaxTurnProtected: false,
    postCompletionFollowupUsed: false,
    businessFallbackQuestionCount: 0
  };
}

function ensureIntakeState(state) {
  if (!state.intake) state.intake = createIntakeState();
  return state.intake;
}

function intakeStage(intake) {
  if (intake.finalGoodbyeSent) return "closed_warm";
  if (
    (intake.waitingFor === "post_completion_question" || intake.waitingFor === "post_completion_actual_question") &&
    intake.postCompletionFollowupUsed
  ) {
    return "post_completion_followup_pending";
  }
  if (intake.closingPending) return "closing_pending";
  if (intake.completed) return "completed";
  if (intake.declined) return "declined";
  if (intake.failed) return "failed";
  if (intake.contactPermissionGranted === true) return "permission_granted";
  if (intake.contactPermissionGranted === false) return "permission_denied";
  if (intake.contactPermissionRequested) return "permission_requested";
  if (intake.contactDetailRequested) return "contact_detail_requested";
  if (intake.contactDetailAttempted) return "contact_detail_attempted";
  if (intake.contactPreference) return "contact_preference_detected";
  if (intake.contactPreferenceAsked) return "contact_preference_requested";
  if (intake.handoffRequested || intake.callbackRequested) return "started";
  return "not_started";
}

function intakeMetadata(intake) {
  const normalizedPhone =
    intake?.contactDetailType === "phone" && intake?.contactDetailNormalized
      ? String(intake.contactDetailNormalized)
      : "";
  return {
    handoffRequested: Boolean(intake?.handoffRequested),
    callbackRequested: Boolean(intake?.callbackRequested),
    contactPreferenceAsked: Boolean(intake?.contactPreferenceAsked),
    contactPreference: intake?.contactPreference ?? null,
    contactRoute: intake?.contactRoute ?? null,
    contactPermissionRequested: Boolean(intake?.contactPermissionRequested),
    contactPermissionGranted:
      typeof intake?.contactPermissionGranted === "boolean" ? intake.contactPermissionGranted : null,
    permissionDetected: intake?.permissionDetected ?? null,
    permissionDetectionSource: intake?.permissionDetectionSource ?? null,
    permissionRetryCount: Number(intake?.permissionRetryCount ?? 0),
    contactDetailAttempted: Boolean(intake?.contactDetailAttempted),
    contactDetailRetryCount: Number(intake?.contactDetailRetryCount ?? 0),
    contactDetailType: intake?.contactDetailType ?? null,
    contactDetailSource: intake?.contactDetailSource ?? null,
    contactDetailValid: Boolean(
      intake?.contactDetailType === "phone" ? isUsableCallbackPhone(normalizedPhone) : intake?.contactDetailAttempted
    ),
    emailDirectOffered: Boolean(intake?.emailDirectOffered),
    softIntakeLeadCreated: Boolean(intake?.leadCreated),
    softIntakeWaitingFor: intake?.waitingFor ?? null,
    softIntakeCompleted: Boolean(intake?.completed),
    closingPending: Boolean(intake?.closingPending),
    finalQuestionAsked: Boolean(intake?.finalQuestionAsked),
    finalGoodbyeSent: Boolean(intake?.finalGoodbyeSent),
    maxTurnsExtendedForIntake: Boolean(intake?.maxTurnsExtendedForIntake),
    maxTurnsBlockedByActiveIntake: Boolean(intake?.maxTurnsBlockedByActiveIntake),
    maxTurnsBlockedByPermissionState: Boolean(intake?.maxTurnsBlockedByPermissionState),
    softIntakeMaxTurnProtected: Boolean(intake?.softIntakeMaxTurnProtected),
    postCompletionFollowupUsed: Boolean(intake?.postCompletionFollowupUsed),
    softIntakeFailedReason: intake?.failedReason ?? null,
    softIntakeState: intake ? intakeStage(intake) : "not_started"
  };
}

function permissionContextMatchLabel(permission) {
  if (permission?.value === "granted") return "granted";
  if (permission?.value === "denied") return "denied";
  return "none";
}

function postCompletionFollowupLabel(intake, callerText) {
  if (!intake?.closingPending && !intake?.postCompletionFollowupUsed) return "none";
  if (
    (intake?.waitingFor === "post_completion_question" || intake?.waitingFor === "post_completion_actual_question") &&
    intake?.postCompletionFollowupUsed
  ) {
    return "pending";
  }
  if (isClosingAnswer(callerText) || isGoodbye(callerText)) return "close";
  if (intake?.closingPending && !intake?.postCompletionFollowupUsed) return "question";
  return "none";
}

function needsSoftIntakeTurnProtection(intake) {
  if (!intake) return false;
  if (intake.closingPending) return true;
  if (
    intake.completed &&
    intake.postCompletionFollowupUsed &&
    (intake.waitingFor === "post_completion_question" || intake.waitingFor === "post_completion_actual_question")
  ) {
    return true;
  }
  if (intake.completed || intake.declined || intake.failed) return false;
  if (intake.contactPermissionRequested && intake.contactPermissionGranted === null) return true;
  if (intake.contactDetailRequested && !intake.contactDetailAttempted) return true;
  if (intake.contactPreferenceAsked && !intake.contactPreference) return true;
  return false;
}

function isIntakeActive(intake) {
  if (!intake) return false;
  if (intake.closingPending) return true;
  if (intake.completed || intake.declined || intake.failed) return false;
  return Boolean(intake.contactPreferenceAsked || intake.contactDetailRequested || intake.contactPermissionRequested);
}

function completedIntakeFinishReason(intake) {
  if (!intake) return "";
  if (intake.finalGoodbyeSent) return "human_warm_goodbye";
  if (intake.closingPending || intake.finalQuestionAsked) return "";
  if (intake.completed) {
    if (intake.contactRoute === "email_direct") return "soft_intake_email_directed";
    return "soft_intake_completed";
  }
  if (intake.declined) return "soft_intake_declined";
  if (intake.failed) return "soft_intake_failed";
  return "";
}

async function emitIntakeEvent(config, ctx, eventType, turnIndex, detectedIntent, intake) {
  await persist.onSoftIntakeEvent(config, ctx, eventType, {
    turnIndex,
    detectedIntent,
    ...intakeMetadata(intake)
  });
}

function isSoftIntakeTrigger(intent) {
  return new Set([
    "handoff_requested",
    "callback_request",
    "pricing_question",
    "free_analysis_request",
    "email_campaign_caller",
    "voice_assistant_question",
    "product_interest_confirmed",
    "website"
  ]).has(intent);
}

function detectPermissionAnswer(text) {
  const normalized = normalizeForIntent(text).replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  const compact = normalized.replace(/[^a-z0-9]/g, "");

  if (
    /\b(nein|nee|lieber nicht|nicht weitergeben|keine daten|keine angaben|mochte ich nicht|moechte ich nicht|nein danke)\b/i.test(
      normalized
    ) ||
    compact.includes("neindanke") ||
    compact.includes("liebernicht")
  ) {
    return { value: "denied", source: "negative_phrase" };
  }

  if (
    /\b(ja|ja gerne|ja bitte|genau|ok|okay|okey|oke|in ordnung|passt|durfen sie|duerfen sie|konnen sie|koennen sie|machen sie|ist okay|das ist okay|einverstanden|gerne)\b/i.test(
      normalized
    ) ||
    compact.includes("jagerne") ||
    compact.includes("jabitte") ||
    compact.includes("jagern") ||
    compact === "ja" ||
    compact === "gerne" ||
    compact === "okay" ||
    compact === "ok"
  ) {
    return { value: "granted", source: "positive_phrase" };
  }

  return { value: "unclear", source: "unrecognized" };
}

function detectPermissionAnswerInRequestedState(text) {
  const base = detectPermissionAnswer(text);
  if (base.value !== "unclear") {
    return { ...base, contextMatch: permissionContextMatchLabel(base) };
  }

  const normalized = normalizeForIntent(text).replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (!compact) return { value: "unclear", source: "unrecognized", contextMatch: "none" };

  if (
    compact.length <= 16 &&
    (/^(ja|jaa|jo|jep|jup|yes|ok|okay|oke|genau|passt|gerne|einverstanden)/i.test(compact) ||
      compact.startsWith("ja"))
  ) {
    return { value: "granted", source: "permission_context_short_yes", contextMatch: "granted" };
  }

  if (
    compact.length <= 16 &&
    (/^(nein|nee|nope|no)/i.test(compact) || compact.startsWith("nein"))
  ) {
    return { value: "denied", source: "permission_context_short_no", contextMatch: "denied" };
  }

  return { value: "unclear", source: "unrecognized", contextMatch: "none" };
}

function isClosingAnswer(text) {
  return isClearCloseSignal(text);
}

function isClearCloseSignal(text) {
  const normalized = normalizeForIntent(text).replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (!normalized) return false;
  if (/\b(nein danke|nein, danke)\b/i.test(normalized)) return true;
  if (/\b(auf wiederhoren|auf wiederhoeren|auf wiedersehen|tschuss|tschuess|ciao)\b/i.test(normalized)) return true;
  if (compact === "nein" || compact === "danke" || compact === "neindanke") return true;
  if (
    tokens.length <= 5 &&
    /\bdanke\b/i.test(normalized) &&
    /\b(tschuss|tschuess|auf wiederhoren|auf wiederhoeren|auf wiedersehen|wiederhor|wiederhoer)\b/i.test(normalized)
  ) {
    return true;
  }
  if (tokens.length <= 4 && /\b(alles gut|passt|passt so|alles klar|keine weitere frage|kein weiteres|das war alles)\b/i.test(normalized)) {
    return true;
  }
  if (tokens.length <= 3 && /\bnein\b/i.test(normalized) && /\bdanke\b/i.test(normalized)) return true;
  return false;
}

function isBusinessFallbackClosingContext(intake) {
  if (!intake) return false;
  return Boolean(
    intake.closingPending ||
      intake.finalQuestionAsked ||
      intake.waitingFor === "closing_answer" ||
      intake.waitingFor === "post_completion_actual_question" ||
      intake.waitingFor === "post_completion_question"
  );
}

function shouldWarmGoodbyeOnClearClose(callerText, intake) {
  if (!isClearCloseSignal(callerText) && !isGoodbye(callerText)) return false;
  return isBusinessFallbackClosingContext(intake) || Boolean(intake?.completed && intake?.postCompletionFollowupUsed);
}

function looksLikeQuestionFragment(text) {
  const normalized = normalizeForIntent(text).replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return /^(soll ich|muss ich|kann ich|darf ich|brauche ich|mochte ich|mohte ich|wie |was |wo |wann |warum |wieso |weshalb |welche |welcher |welches |gibt es )/.test(
    normalized
  );
}

function shouldGuardIncompleteClosingQuestion(callerText, analysis) {
  if (isClearCloseSignal(callerText) || isGoodbye(callerText)) return false;
  if (matchBusinessFallbackFromText(callerText)) return false;
  if (analysis?.transcriptQuality === "incomplete" || analysis?.transcriptQuality === "unclear") return true;
  if (looksTruncated(callerText)) return true;
  if (looksLikeQuestionFragment(callerText)) return true;
  return false;
}

function buildIncompleteClosingQuestionResponse(callerText, config) {
  return normalizeAssistantResponse(POST_CAPTURE_INCOMPLETE_QUESTION_TEXT, config);
}

function isPostCompletionBusinessFallbackEligible(intake) {
  if (!intake?.completed || !intake?.postCompletionFollowupUsed) return false;
  return (
    intake.waitingFor === "post_completion_actual_question" || intake.waitingFor === "post_completion_question"
  );
}

function isBusinessFallbackEligible(intake, product) {
  if (isPostCompletionBusinessFallbackEligible(intake)) return true;
  if (isBusinessFallbackClosingContext(intake)) return true;
  if (isProductFlowActive(product)) return false;
  if (isIntakeActive(intake) && !intake?.closingPending) return false;
  return true;
}

function logBusinessFallbackDecision(turnIndex, details) {
  const {
    intent = "none",
    source = "generic",
    nextStep = "close_question",
    answered = false,
    guidance = "none",
    websiteConfigured = false,
    clearCloseDetected = false,
    fallbackQuestionCount = 0
  } = details;
  console.log(
    `[voice-assistant] business fallback turn_index=${turnIndex} business_fallback_intent=${intent} business_fallback_source=${source} business_fallback_next_step=${nextStep} business_fallback_guidance=${guidance} voice_website_url_configured=${websiteConfigured} clear_close_detected=${clearCloseDetected} fallback_question_count=${fallbackQuestionCount} post_completion_followup_answered=${answered}`
  );
}

function maybeCreateBusinessFallbackResponse(config, ctx, turnIndex, callerText, analysis, product) {
  const intake = ensureIntakeState(turnState(ctx));
  const productState = product || ensureProductState(turnState(ctx));
  const clearCloseDetected = isClearCloseSignal(callerText) || isGoodbye(callerText);
  const websiteConfigured = Boolean(configuredWebsiteUrl(config));

  if (!isBusinessFallbackEligible(intake, productState)) return null;
  if (clearCloseDetected || isFollowupQuestionOnlySignal(callerText)) {
    return null;
  }

  const match = matchBusinessFallbackFromText(callerText);
  if (!match) {
    logBusinessFallbackDecision(turnIndex, {
      source: "generic",
      answered: false,
      guidance: "none",
      websiteConfigured,
      clearCloseDetected,
      fallbackQuestionCount: Number(intake.businessFallbackQuestionCount || 0)
    });
    return null;
  }

  const built = buildBusinessFallbackResponse(match.intent, {
    contactEmail: configuredContactEmail(config),
    websiteUrl: configuredWebsiteUrl(config),
    fallbackQuestionCount: Number(intake.businessFallbackQuestionCount || 0)
  });
  let prefix = built.body;
  if (built.guidance) {
    prefix = `${prefix} ${built.guidance}`;
  }
  let assembled = assembleLimitedResponse({
    prefix,
    mandatorySuffix: BUSINESS_FALLBACK_CLOSE_QUESTION,
    config,
    maxSentencesOverride: 4,
    maxCharsOverride: Math.max(maxResponseChars(config), 260)
  });
  const website = configuredWebsiteUrl(config).replace(/^https?:\/\//i, "");
  const email = configuredContactEmail(config);
  if (website && !normalizeForIntent(assembled.text).includes(normalizeForIntent(website))) {
    assembled = assembleLimitedResponse({
      prefix: built.body,
      mandatorySuffix: BUSINESS_FALLBACK_CLOSE_QUESTION,
      config,
      maxSentencesOverride: 4,
      maxCharsOverride: Math.max(maxResponseChars(config), 260)
    });
  }
  if (email && built.intent === "email_contents_question" && !assembled.text.includes(email)) {
    assembled = assembleLimitedResponse({
      prefix: built.body,
      mandatorySuffix: BUSINESS_FALLBACK_CLOSE_QUESTION,
      config,
      maxSentencesOverride: 5,
      maxCharsOverride: Math.max(maxResponseChars(config), 280)
    });
  }
  intake.businessFallbackQuestionCount = Number(intake.businessFallbackQuestionCount || 0) + 1;
  intake.closingPending = true;
  intake.finalQuestionAsked = true;
  intake.waitingFor = "closing_answer";
  logBusinessFallbackDecision(turnIndex, {
    intent: built.intent,
    source: "deterministic",
    nextStep: built.nextStep,
    answered: true,
    guidance: built.guidanceType,
    websiteConfigured,
    clearCloseDetected: false,
    fallbackQuestionCount: intake.businessFallbackQuestionCount
  });

  return {
    text: assembled.text,
    detectedIntent: built.intent,
    finalResponseTemplate: "business_fallback",
    businessFallbackIntent: built.intent,
    businessFallbackSource: "deterministic",
    businessFallbackGuidance: built.guidanceType,
    businessFallbackNextStep: built.nextStep,
    intake
  };
}

function logClosingDecision(turnIndex, guard, reason) {
  console.log(
    `[voice-assistant] soft intake closing turn_index=${turnIndex} closing_incomplete_question_guard=${guard} closing_reason=${reason}`
  );
}

function isPermissionDenied(text) {
  return detectPermissionAnswer(text).value === "denied";
}

function detailTypeFromIntent(intent, intake) {
  if (intent === "email_provided") return "email";
  if (intent === "phone_provided") return "phone";
  if (intake?.contactPreference === "email" && intent === "contact_preference_email") return "email";
  if (intake?.contactPreference === "phone" && intent === "contact_preference_phone") return "phone";
  return null;
}

function detectContactPreferenceAnswer(text, intent) {
  return detectContactPreferenceMatch(text, intent, null).preference;
}

function detectContactPreferenceMatch(text, intent, intake) {
  if (intent === "contact_preference_email") return { preference: "email", reason: "intent_match" };
  if (intent === "contact_preference_phone") return { preference: "phone", reason: "intent_match" };

  const normalized = normalizeForIntent(text);
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  const callbackContextActive = Boolean(
    intake &&
    (
      intake.waitingFor === "contact_preference" ||
      (intake.contactPreferenceAsked && !intake.contactPreference && !intake.contactDetailRequested) ||
      intake.handoffRequested ||
      intake.callbackRequested
    )
  );

  if (
    /\b(e-?\s*mail|e mail|i mail|imail|email|emil|emeil|e mehl|mail|mehl|schriftlich|schreiben|medvita|med vita)\b/i.test(normalized) ||
    compact.includes("email") ||
    compact.includes("emailbitte") ||
    compact.includes("imail") ||
    compact.includes("emil") ||
    compact.includes("emeil") ||
    compact.includes("medvita") ||
    compact.includes("peremail") ||
    compact.includes("permail") ||
    compact.includes("mailbitte")
  ) {
    return { preference: "email", reason: "fuzzy_keyword" };
  }

  if (
    /\b(telefonisch|telefon|telefonnummer|per anruf|anruf|anrufen|rufen|ruf|rueckruf|ruckruf|rückruf|rueck ruf|ruck ruf|rück ruf|zurueckrufen|zuruckrufen|zurückrufen|zurueck rufen|zuruck rufen|zurück rufen|per telefon|bitte anrufen|rufen sie mich an|call ?back|callback|call me|phone|handy)\b/i.test(normalized) ||
    compact.includes("telefon") ||
    compact.includes("telefonisch") ||
    compact.includes("anrufen") ||
    compact.includes("anruf") ||
    compact.includes("rufbitte") ||
    compact.includes("callme") ||
    compact.includes("callback") ||
    compact.includes("phone") ||
    compact.includes("rufensiemichan") ||
    compact.includes("zurueckrufen") ||
    compact.includes("zuruckrufen") ||
    compact.includes("ruckruf") ||
    compact.includes("rueckruf") ||
    compact.includes("rückruf")
  ) {
    return { preference: "phone", reason: "fuzzy_keyword" };
  }

  if (
    callbackContextActive &&
    (
      /\b(hochboost|hoch boost|hockboost|hock boost|hochbust|hoch bust|hochruf|hauchruf|holt ruf|hold ruf|hohl ruf|hauch auf|hoch auf|auch auf|hauch bitte|hoch bitte|rot gross|rot gros|rot groß|morspitze|rotkrostitzel)\b/i.test(
        normalized
      ) ||
      compact.includes("hochboost") ||
      compact.includes("hockboost") ||
      compact.includes("hochbust") ||
      compact.includes("hochruf") ||
      compact.includes("hauchruf") ||
      compact.includes("holtruf") ||
      compact.includes("holdruf") ||
      compact.includes("hohlruf") ||
      compact.includes("hauchauf") ||
      compact.includes("hochauf") ||
      compact.includes("auchauf") ||
      compact.includes("hauchbitte") ||
      compact.includes("hochbitte") ||
      compact.includes("morspitze") ||
      compact.includes("rotgross") ||
      compact.includes("rotgros") ||
      compact.includes("rotkrostitzel")
    )
  ) {
    return { preference: "phone", reason: "state_scoped_fuzzy_keyword" };
  }

  const singleToken = compact.split(/\s+/).filter(Boolean)[0] || compact;
  if (singleToken.length >= 4 && singleToken.length <= 12) {
    if (
      /ruf|ruck|rueck|ruc|anruf/.test(singleToken) ||
      (callbackContextActive &&
        (
          /^ho(ch|t).*(ro|ru|ruf|boost)?$/.test(singleToken) ||
          /^hoch/.test(singleToken) ||
          /^hotr/.test(singleToken)
        ))
    ) {
      return {
        preference: "phone",
        reason: intake?.waitingFor === "contact_preference" ? "state_override" : "fuzzy_keyword"
      };
    }
    if (/mail|mehl|emai|imei|imail/.test(singleToken)) {
      return {
        preference: "email",
        reason: intake?.waitingFor === "contact_preference" ? "state_override" : "fuzzy_keyword"
      };
    }
  }

  return { preference: null, reason: "none" };
}

function isLikelyEmailDetail(callerText, intent) {
  if (intent === "email_provided") return true;
  const normalized = normalizeForIntent(callerText);
  return /@|\b(at|ät|et|punkt|dot|gmail|gmx|web\.?de|outlook|mail|e-?mail)\b/i.test(normalized);
}

function isLikelyPhoneDetail(callerText, intent) {
  if (intent === "phone_provided") return true;
  const normalized = normalizeForIntent(callerText);
  if (/(?:\+|00)?\d[\d\s/-]{5,}\d/.test(normalized)) return true;
  return /\b(null|eins|zwei|drei|vier|fuenf|fünf|sechs|sieben|acht|neun|plus|telefonnummer)\b/i.test(
    normalized
  );
}

function normalizeSpokenPhone(text) {
  const raw = String(text ?? "").toLowerCase();
  const digitMatch = raw.match(/\+?\d[\d\s()./-]{5,}\d/);
  if (digitMatch) {
    const value = digitMatch[0].replace(/[^\d+]/g, "");
    return value.startsWith("00") ? `+${value.slice(2)}` : value;
  }

  const digitWords = new Map([
    ["null", "0"],
    ["zero", "0"],
    ["eins", "1"],
    ["ein", "1"],
    ["eine", "1"],
    ["zwei", "2"],
    ["drei", "3"],
    ["vier", "4"],
    ["funf", "5"],
    ["fuenf", "5"],
    ["fÃ¼nf", "5"],
    ["sechs", "6"],
    ["sieben", "7"],
    ["acht", "8"],
    ["neun", "9"]
  ]);

  let hasPlus = false;
  const digits = [];
  for (const word of normalizeForIntent(raw).split(/\s+/).filter(Boolean)) {
    if (word === "plus") {
      hasPlus = true;
      continue;
    }
    const digit = digitWords.get(word);
    if (digit) digits.push(digit);
  }

  if (digits.length < 6) return "";
  return `${hasPlus ? "+" : ""}${digits.join("")}`;
}

function phoneDigitCount(value) {
  return String(value ?? "").replace(/\D/g, "").length;
}

function isUsableCallbackPhone(value) {
  return phoneDigitCount(value) >= 10;
}

function isLikelyContactDetail(callerText, intent, intake) {
  const detailType = intake?.contactDetailType || intake?.contactPreference || "unknown";
  if (detailType === "email") return isLikelyEmailDetail(callerText, intent);
  if (detailType === "phone") return isLikelyPhoneDetail(callerText, intent);
  return isLikelyEmailDetail(callerText, intent) || isLikelyPhoneDetail(callerText, intent);
}

function isFollowupQuestionOnlySignal(text) {
  const normalized = normalizeForIntent(text).replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || !/\b(frage|question)\b/i.test(normalized)) return false;

  const hasQuestionWords = /\b(was|wie|wann|wo|warum|wieso|weshalb|welche|welcher|welches)\b/i.test(normalized);
  const hasTopicTail = /\b(zu|wegen|uber|ueber)\b\s+[a-z0-9]{3,}/i.test(normalized);
  const tokens = normalized.split(" ").filter(Boolean);

  if (hasQuestionWords || hasTopicTail) return false;
  if (
    /\b(ja|klar|doch|genau)?\s*(ich\s*)?(habe|hab|hatte|haette)?\s*(noch\s*)?(eine\s*)?frage\b/i.test(normalized) &&
    tokens.length <= 10
  ) {
    return true;
  }
  return /\b(noch\s*)?eine\s*frage\b/i.test(normalized) && tokens.length <= 6;
}

function withHumanClosingQuestion(baseText, config) {
  return normalizeAssistantResponse(`${baseText} ${HUMAN_CLOSING_QUESTION_TEXT}`, config);
}

function intakeMaxTurnsCloseText(intake, config) {
  if (intake?.closingPending || intake?.finalQuestionAsked) {
    return normalizeAssistantResponse(HUMAN_WARM_GOODBYE_TEXT, config);
  }
  if (intake?.contactPermissionRequested && intake?.contactPermissionGranted === null) {
    return normalizeAssistantResponse(MAX_TURNS_INTAKE_PERMISSION_MISSING_TEXT, config);
  }
  if (intake?.contactDetailRequested && intake?.contactDetailType === "phone") {
    return normalizeAssistantResponse(MAX_TURNS_INTAKE_PHONE_MISSING_TEXT, config);
  }
  return normalizeAssistantResponse(contactDeclinedText(config), config);
}

function softIntakeTriggerText(intent, config, callerText) {
  if (intent === "handoff_requested" || intent === "callback_request") {
    return HANDOFF_CONTACT_PREFERENCE_TEXT;
  }
  if (intent === "pricing_question") {
    return "Das hängt vom Umfang ab. Möchten Sie lieber per E-Mail schreiben oder telefonisch kontaktiert werden?";
  }
  if (intent === "smart_website_interest") {
    const policy = productPolicyById("smart_website");
    return policy
      ? `${policy.pitchShort} ${policy.mandatoryInterestQuestion}`
      : "Für Details können Sie uns per E-Mail schreiben, oder unser Team kontaktiert Sie telefonisch. Was ist Ihnen lieber: E-Mail oder Telefon?";
  }
  if (intent === "website") {
    return "Ja, TechnoloHit erstellt intelligente Websites. Möchten Sie lieber per E-Mail schreiben oder telefonisch kontaktiert werden?";
  }
  if (intent === "free_analysis_request") {
    return "Gerne. Möchten Sie lieber per E-Mail schreiben oder telefonisch kontaktiert werden?";
  }
  if (intent === "email_campaign_caller") {
    return "Danke, dann geht es um die kostenlose Website-Ersteinschätzung. Möchten Sie lieber per E-Mail schreiben oder telefonisch kontaktiert werden?";
  }
  if (intent === "voice_assistant_question") {
    return "Ja, so ein Telefonassistent kann Teil der Lösung sein. Möchten Sie lieber per E-Mail schreiben oder telefonisch kontaktiert werden?";
  }
  if (intent === "product_interest_confirmed") {
    return INTEREST_CONTACT_PREFERENCE_TEXT;
  }
  const answers = {
    pricing_question:
      "Das hängt vom Umfang ab. Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?",
    smart_website_interest:
      "Eine intelligente Website ist mehr als eine normale Homepage. Für Details können Sie uns per E-Mail schreiben, oder unser Team kontaktiert Sie telefonisch. Was ist Ihnen lieber: E-Mail oder Telefon?",
    website:
      "Ja, TechnoloHit erstellt intelligente Websites. Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?",
    free_analysis_request:
      "Gerne. Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?",
    email_campaign_caller:
      "Danke, dann geht es um die kostenlose Website-Ersteinschätzung. Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?",
    voice_assistant_question:
      "Ja, so ein Telefonassistent kann Teil der Lösung sein. Möchten Sie lieber per E-Mail oder telefonisch kontaktiert werden?",
    product_interest_confirmed: INTEREST_CONTACT_PREFERENCE_TEXT
  };
  return answers[intent] || `${templateResponseForIntent(intent, config, callerText)} ${INTEREST_CONTACT_PREFERENCE_TEXT}`;
}

async function completeEmailDirectIntake(config, ctx, turnIndex, detectedIntent, intake) {
  const product = ensureProductState(turnState(ctx));
  const policy = productPolicyById(product?.selectedProduct || "") || null;
  const emailReference = emailContactReferenceText(config);
  const emailInstruction = policy?.emailInstruction || "Schreiben Sie uns bitte kurz Ihr Anliegen und Ihre wichtigsten Fragen.";
  const confirmationText = `${emailReference} ${emailInstruction}`;
  const contactEmail = configuredContactEmail(config);
  console.log(
    `[voice-assistant] email intake turn_index=${turnIndex} voice_contact_email_configured=${Boolean(contactEmail)}`
  );
  product.awaitingSelection = false;
  product.awaitingInterestConfirmation = false;
  product.productDialogueState = "email_instruction_given";
  product.handoffChoice = "email";
  console.log(
    `[voice-assistant] product_intake_product=${product.selectedProduct || "none"} product_intake_stage=email_instruction handoff_choice=email turn_index=${turnIndex}`
  );
  intake.contactPreference = "email";
  intake.contactRoute = "email_direct";
  intake.contactDetailType = null;
  intake.contactDetailSource = null;
  intake.contactDetailRequested = false;
  intake.contactDetailAttempted = false;
  intake.emailDirectOffered = true;
  intake.completed = true;
  intake.closingPending = true;
  intake.finalQuestionAsked = true;
  intake.waitingFor = "closing_answer";

  await emitIntakeEvent(config, ctx, "contact_preference_detected", turnIndex, detectedIntent, intake);
  await emitIntakeEvent(config, ctx, "soft_intake_email_directed", turnIndex, detectedIntent, intake);
  const leadId = await persist.onSoftIntakeLeadReady(config, ctx, {
    turnIndex,
    detectedIntent,
    contactRoute: "email_direct",
    contactPreference: "email",
    contactPermissionGranted: null,
    emailDirectTo: contactEmail || null,
    noVoiceEmailCapture: true,
    notes: contactEmail
      ? "Caller chose direct email path; contact email provided by VOICE_CONTACT_EMAIL."
      : "Caller chose direct email path; no explicit contact email configured in VOICE_CONTACT_EMAIL."
  });
  intake.leadCreated = Boolean(leadId);

  return {
    text: normalizeAssistantResponse(confirmationText, config),
    detectedIntent,
    finalResponseTemplate: "email_instruction",
    intake
  };
}

async function requestPhoneDetailIntake(config, ctx, turnIndex, detectedIntent, intake) {
  const product = ensureProductState(turnState(ctx));
  product.awaitingSelection = false;
  product.awaitingInterestConfirmation = false;
  product.productDialogueState = "phone_requested";
  product.handoffChoice = "phone";
  console.log(
    `[voice-assistant] product_intake_product=${product.selectedProduct || "none"} product_intake_stage=phone_request handoff_choice=phone turn_index=${turnIndex}`
  );
  const callerPhone = callerIdForCallback(ctx);
  intake.contactPreference = "phone";
  intake.contactRoute = "callback";
  intake.contactDetailType = "phone";
  intake.contactDetailRetryCount = 0;

  await emitIntakeEvent(config, ctx, "contact_preference_detected", turnIndex, detectedIntent, intake);

  if (hasUsableCallerId(ctx)) {
    intake.contactDetailRequested = false;
    intake.contactDetailAttempted = true;
    intake.contactDetailSource = "caller_id";
    intake.contactDetailNormalized = callerPhone;
    intake.contactPermissionRequested = true;
    intake.waitingFor = "permission";
    intake.permissionRetryCount = 0;
    intake.permissionDetected = null;
    intake.permissionDetectionSource = null;
    await emitIntakeEvent(config, ctx, "contact_permission_requested", turnIndex, detectedIntent, intake);
    return {
      text: normalizeAssistantResponse(CALLBACK_NUMBER_CONFIRM_PERMISSION_TEXT, config),
      detectedIntent,
      finalResponseTemplate: "permission",
      intake
    };
  }

  intake.contactDetailSource = "voice";
  intake.contactDetailRequested = true;
  intake.waitingFor = "contact_detail";
  await emitIntakeEvent(config, ctx, "contact_detail_requested", turnIndex, detectedIntent, intake);
  return {
    text: normalizeAssistantResponse(PHONE_DETAIL_REQUEST_TEXT, config),
    detectedIntent,
    finalResponseTemplate: "phone_request",
    intake
  };
}

async function maybeCreateSoftIntakeResponse(config, ctx, turnIndex, callerText, analysis) {
  const state = turnState(ctx);
  const intake = ensureIntakeState(state);
  const productState = ensureProductState(state);
  const intent = analysis?.detectedIntent ?? "unknown";

  if (intake.waitingFor === "post_completion_actual_question" && intake.postCompletionFollowupUsed) {
    if (isClearCloseSignal(callerText) || isGoodbye(callerText)) {
      intake.closingPending = false;
      intake.finalGoodbyeSent = true;
      intake.waitingFor = null;
      productState.productDialogueState = "completed";
      logClosingDecision(turnIndex, false, "clear_close");
      console.log(
        `[voice-assistant] product_intake_product=${productState.selectedProduct || "none"} product_intake_stage=closing handoff_choice=${productState.handoffChoice || "none"} turn_index=${turnIndex}`
      );
      return {
        text: normalizeAssistantResponse(POST_CAPTURE_WARM_GOODBYE_TEXT, config),
        detectedIntent: "post_capture_warm_goodbye",
        intake
      };
    }

    const businessFallbackResponse = maybeCreateBusinessFallbackResponse(
      config,
      ctx,
      turnIndex,
      callerText,
      analysis,
      productState
    );
    if (businessFallbackResponse?.text) {
      return businessFallbackResponse;
    }

    if (shouldGuardIncompleteClosingQuestion(callerText, analysis)) {
      logClosingDecision(turnIndex, true, "incomplete_question_clarified");
      return {
        text: buildIncompleteClosingQuestionResponse(callerText, config),
        detectedIntent: "post_completion_incomplete_question_clarified",
        intake
      };
    }

    if (isFollowupQuestionOnlySignal(callerText)) {
      logClosingDecision(turnIndex, false, "followup_question");
      return {
        text: normalizeAssistantResponse(POST_CAPTURE_QUESTION_PROMPT_TEXT, config),
        detectedIntent: "post_completion_question_prompt",
        intake
      };
    }

    intake.waitingFor = "post_completion_question";
    logClosingDecision(turnIndex, false, "followup_question");
    return null;
  }

  if (intake.closingPending) {
    const followupLabel = postCompletionFollowupLabel(intake, callerText);
    console.log(
      `[voice-assistant] soft intake closing turn_index=${turnIndex} post_completion_followup=${followupLabel} closing_policy=ask_final_question soft_intake_state=${intakeStage(intake)}`
    );

    if (isClearCloseSignal(callerText) || isGoodbye(callerText)) {
      intake.closingPending = false;
      intake.finalGoodbyeSent = true;
      intake.waitingFor = null;
      productState.productDialogueState = "completed";
      logClosingDecision(turnIndex, false, "clear_close");
      console.log(
        `[voice-assistant] product_intake_product=${productState.selectedProduct || "none"} product_intake_stage=closing handoff_choice=${productState.handoffChoice || "none"} turn_index=${turnIndex}`
      );
      console.log(
        `[voice-assistant] soft intake closing turn_index=${turnIndex} post_completion_followup=close closing_policy=warm_goodbye soft_intake_state=${intakeStage(intake)}`
      );
      return {
        text: normalizeAssistantResponse(POST_CAPTURE_WARM_GOODBYE_TEXT, config),
        detectedIntent: "post_capture_warm_goodbye",
        intake
      };
    }

    const businessFallbackResponse = maybeCreateBusinessFallbackResponse(
      config,
      ctx,
      turnIndex,
      callerText,
      analysis,
      productState
    );
    if (businessFallbackResponse?.text) {
      return businessFallbackResponse;
    }

    if (isFollowupQuestionOnlySignal(callerText)) {
      intake.postCompletionFollowupUsed = true;
      intake.closingPending = false;
      intake.waitingFor = "post_completion_actual_question";
      logClosingDecision(turnIndex, false, "followup_question");
      console.log(
        `[voice-assistant] soft intake closing turn_index=${turnIndex} post_completion_followup=collect_question closing_policy=ask_final_question soft_intake_state=${intakeStage(intake)}`
      );
      return {
        text: normalizeAssistantResponse(POST_CAPTURE_QUESTION_PROMPT_TEXT, config),
        detectedIntent: "post_completion_question_prompt",
        intake
      };
    }

    if (shouldGuardIncompleteClosingQuestion(callerText, analysis)) {
      logClosingDecision(turnIndex, true, "incomplete_question_clarified");
      return {
        text: buildIncompleteClosingQuestionResponse(callerText, config),
        detectedIntent: "post_completion_incomplete_question_clarified",
        intake
      };
    }

    if (!intake.postCompletionFollowupUsed && analysis?.transcriptQuality !== "clear") {
      intake.postCompletionFollowupUsed = true;
      intake.waitingFor = "closing_answer";
      logClosingDecision(turnIndex, false, "unclear_retry");
      console.log(
        `[voice-assistant] soft intake closing turn_index=${turnIndex} post_completion_followup=question closing_policy=ask_final_question soft_intake_state=${intakeStage(intake)}`
      );
      return {
        text: normalizeAssistantResponse(POST_CAPTURE_FOLLOWUP_RETRY_TEXT, config),
        detectedIntent: "post_completion_followup_retry",
        intake
      };
    }

    if (!intake.postCompletionFollowupUsed) {
      intake.postCompletionFollowupUsed = true;
      intake.closingPending = false;
      intake.waitingFor = "post_completion_question";
      logClosingDecision(turnIndex, false, "followup_question");
      console.log(
        `[voice-assistant] soft intake closing turn_index=${turnIndex} post_completion_followup=question closing_policy=ask_final_question soft_intake_state=${intakeStage(intake)}`
      );
      return null;
    }

    logClosingDecision(turnIndex, true, "incomplete_question_clarified");
    return {
      text: buildIncompleteClosingQuestionResponse(callerText, config),
      detectedIntent: "post_completion_incomplete_question_clarified",
      intake
    };
  }

  if (
    !intake.contactPermissionRequested &&
    (intent === "refuses_contact_details" ||
    ((intake.contactPreferenceAsked || intake.contactDetailRequested) &&
      !intake.contactPermissionRequested &&
      isPermissionDenied(callerText)))
  ) {
    intake.waitingFor = "closing_answer";
    intake.declined = true;
    intake.contactPermissionGranted = false;
    intake.closingPending = true;
    intake.finalQuestionAsked = true;
    productState.productDialogueState = "closing_pending";
    await emitIntakeEvent(config, ctx, "soft_intake_declined", turnIndex, intent, intake);
    return {
      text: withHumanClosingQuestion(contactDeclinedText(config), config),
      detectedIntent: "refuses_contact_details",
      intake
    };
  }

  if (intake.contactPermissionRequested && intake.contactPermissionGranted === null) {
    intake.waitingFor = "permission";
    const permission = detectPermissionAnswerInRequestedState(callerText);
    intake.permissionDetected = permission.value;
    intake.permissionDetectionSource = permission.source;
    console.log(
      `[voice-assistant] soft intake permission turn_index=${turnIndex} permission_context_match=${permission.contextMatch ?? permissionContextMatchLabel(permission)} match_reason=${permission.source} soft_intake_state=${intakeStage(intake)}`
    );

    if (permission.value === "granted") {
      const phoneCaptureSource = intake.contactDetailSource || "voice";
      intake.contactPermissionGranted = true;
      intake.completed = true;
      productState.productDialogueState = "closing_pending";
      console.log(
        `[voice-assistant] product_intake_product=${productState.selectedProduct || "none"} product_intake_stage=permission handoff_choice=${productState.handoffChoice || "none"} turn_index=${turnIndex}`
      );
      await emitIntakeEvent(config, ctx, "contact_permission_granted", turnIndex, intent, intake);
      const leadId = await persist.onSoftIntakeLeadReady(config, ctx, {
        turnIndex,
        detectedIntent: "contact_permission_granted",
        contactRoute: intake.contactRoute || "callback",
        contactPreference: intake.contactPreference || "phone",
        contactPermissionGranted: true,
        normalizedPhone: intake.contactDetailNormalized || "",
        contactDetailSource: phoneCaptureSource,
        noVoiceEmailCapture: true,
        notes:
          phoneCaptureSource === "caller_id"
            ? "Caller requested callback and granted permission; callback number prefilled from caller ID."
            : "Caller requested callback and granted permission; phone captured best-effort from voice transcript."
      });
      intake.leadCreated = Boolean(leadId);
      const permissionGrantedResponse =
        phoneCaptureSource === "caller_id"
          ? {
              text: normalizeAssistantResponse(PERMISSION_GRANTED_CONFIRMATION_BODY, config),
              containsFinalQuestion: false,
              finalPermissionResponseMissingQuestion: false,
              responseLimiterRemovedPermissionTail: false
            }
          : buildPermissionGrantedWithFinalQuestion(config, turnIndex);
      if (permissionGrantedResponse.containsFinalQuestion) {
        intake.closingPending = true;
        intake.finalQuestionAsked = true;
        intake.waitingFor = "closing_answer";
      } else {
        intake.closingPending = false;
        intake.finalQuestionAsked = false;
        intake.waitingFor = "post_completion_question";
      }
      return {
        text: permissionGrantedResponse.text,
        detectedIntent: "contact_permission_granted",
        intake
      };
    }

    if (permission.value === "denied") {
      await emitIntakeEvent(config, ctx, "contact_permission_denied", turnIndex, intent, intake);
      intake.contactPermissionGranted = false;
      intake.declined = true;
      intake.closingPending = true;
      intake.finalQuestionAsked = true;
      intake.waitingFor = "closing_answer";
      productState.productDialogueState = "closing_pending";
      console.log(
        `[voice-assistant] product_intake_product=${productState.selectedProduct || "none"} product_intake_stage=permission handoff_choice=${productState.handoffChoice || "none"} turn_index=${turnIndex}`
      );
      return {
        text: withHumanClosingQuestion(contactDeclinedText(config), config),
        detectedIntent: "contact_permission_denied",
        intake
      };
    }

    if (intake.permissionRetryCount < PERMISSION_RETRY_LIMIT) {
      intake.permissionRetryCount += 1;
      return {
        text: normalizeAssistantResponse(CONTACT_PERMISSION_REASK_TEXT, config),
        detectedIntent: "permission_unclear_retry",
        intake
      };
    }

    intake.failed = true;
    intake.failedReason = "permission_unclear_after_retry";
    intake.waitingFor = null;
    return {
      text: normalizeAssistantResponse(MAX_TURNS_INTAKE_PERMISSION_MISSING_TEXT, config),
      detectedIntent: "permission_unclear_failed",
      intake
    };
  }

  if (intake.contactDetailRequested && !intake.contactDetailAttempted) {
    intake.waitingFor = "contact_detail";
    const detailType = detailTypeFromIntent(intent, intake) || intake.contactPreference || intake.contactDetailType;
    intake.contactDetailType = detailType || intake.contactDetailType || "unknown";

    if (intake.contactDetailType === "email") {
      return completeEmailDirectIntake(config, ctx, turnIndex, "contact_preference_email", intake);
    }

    if (isLikelyContactDetail(callerText, intent, intake)) {
      intake.contactDetailSource = "voice";
      const normalizedPhone = intake.contactDetailType === "phone" ? normalizeSpokenPhone(callerText) : "";

      if (intake.contactDetailType === "phone" && !isUsableCallbackPhone(normalizedPhone)) {
        intake.contactDetailNormalized = "";
        intake.contactDetailAttempted = false;
        intake.contactPermissionGranted = null;
        intake.contactPermissionRequested = false;
        intake.completed = false;
        intake.waitingFor = "contact_detail";
        productState.productDialogueState = "phone_requested";
        intake.contactDetailRetryCount += 1;
        await emitIntakeEvent(config, ctx, "contact_detail_incomplete", turnIndex, intent, intake);
        return {
          text: normalizeAssistantResponse(PHONE_DETAIL_INCOMPLETE_REASK_TEXT, config),
          detectedIntent: "phone_detail_incomplete_reask",
          finalResponseTemplate: "phone_request",
          intake
        };
      }

      intake.contactDetailAttempted = true;
      intake.contactDetailNormalized = normalizedPhone;
      intake.contactPermissionGranted = true;
      intake.contactPermissionRequested = false;
      intake.completed = true;
      productState.productDialogueState = "closing_pending";
      await emitIntakeEvent(config, ctx, "contact_permission_granted", turnIndex, intent, intake);
      const leadId = await persist.onSoftIntakeLeadReady(config, ctx, {
        turnIndex,
        detectedIntent: "contact_permission_granted",
        contactRoute: intake.contactRoute || "callback",
        contactPreference: intake.contactPreference || "phone",
        contactPermissionGranted: true,
        normalizedPhone: intake.contactDetailNormalized || "",
        contactDetailSource: "voice",
        noVoiceEmailCapture: true,
        notes:
          "Caller requested callback; phone captured from voice. Permission implied by callback number question."
      });
      intake.leadCreated = Boolean(leadId);
      const confirmationText = normalizeAssistantResponse(PERMISSION_GRANTED_CONFIRMATION_BODY, config);
      intake.closingPending = true;
      intake.finalQuestionAsked = true;
      intake.waitingFor = "closing_answer";
      return {
        text: confirmationText,
        detectedIntent: "contact_permission_granted",
        intake
      };
    }

    if (intake.contactDetailType === "phone") {
      intake.contactDetailRetryCount += 1;
      return {
        text: normalizeAssistantResponse(PHONE_DETAIL_INCOMPLETE_REASK_TEXT, config),
        detectedIntent: "phone_detail_incomplete_reask",
        finalResponseTemplate: "phone_request",
        intake
      };
    }

    if (intake.contactDetailRetryCount < DETAIL_RETRY_LIMIT) {
      intake.contactDetailRetryCount += 1;
      return {
        text: normalizeAssistantResponse(EMAIL_DETAIL_REASK_TEXT, config),
        detectedIntent: intent,
        intake
      };
    }

    intake.failed = true;
    intake.waitingFor = null;
    await emitIntakeEvent(config, ctx, "soft_intake_declined", turnIndex, intent, intake);
    return {
      text: normalizeAssistantResponse(
        intake.contactDetailType === "phone"
          ? MAX_TURNS_INTAKE_PHONE_MISSING_TEXT
          : MAX_TURNS_INTAKE_EMAIL_MISSING_TEXT,
        config
      ),
      detectedIntent: intent,
      intake
    };
  }

  if (intent === "email_provided" && !intake.contactPermissionRequested) {
    return completeEmailDirectIntake(config, ctx, turnIndex, "contact_preference_email", intake);
  }

  if (intent === "contact_preference_email" && !intake.contactDetailRequested) {
    return completeEmailDirectIntake(config, ctx, turnIndex, intent, intake);
  }

  if (intent === "contact_preference_phone" && !intake.contactDetailRequested) {
    return requestPhoneDetailIntake(config, ctx, turnIndex, intent, intake);
  }

  if (intake.contactPreferenceAsked && !intake.contactPreference && !intake.contactDetailRequested) {
    const preferenceMatch = detectContactPreferenceMatch(callerText, intent, intake);
    const attemptCount = Number(intake.contactDetailRetryCount || 0) + 1;
    const qaTokenPreview = config.assistant?.qaLogTranscriptPreview
      ? normalizeForIntent(callerText)
          .split(/\s+/)
          .map((token) => token.replace(/[^a-z]/g, ""))
          .filter((token) => token.length >= 2 && token.length <= 14)
          .slice(0, 8)
          .join("|")
      : "";
    console.log(
      `[voice-assistant] contact preference check turn_index=${turnIndex} contact_preference_match=${preferenceMatch.preference || "none"} match_reason=${preferenceMatch.reason || "none"} attempt_count=${attemptCount}${qaTokenPreview ? ` qa_tokens=${qaTokenPreview}` : ""}`
    );

    if (preferenceMatch.preference === "email") {
      return completeEmailDirectIntake(config, ctx, turnIndex, "contact_preference_email", intake);
    }

    if (preferenceMatch.preference === "phone") {
      return requestPhoneDetailIntake(config, ctx, turnIndex, "contact_preference_phone", intake);
    }

    if (intake.contactDetailRetryCount >= CONTACT_PREFERENCE_RETRY_LIMIT) {
      intake.failed = true;
      intake.failedReason = "contact_preference_unclear_after_retry";
      intake.waitingFor = null;
      return {
        text: normalizeAssistantResponse(CONTACT_PREFERENCE_FAILED_TEXT, config),
        detectedIntent: intent,
        intake
      };
    }

    intake.contactDetailRetryCount += 1;
    intake.waitingFor = "contact_preference";
    const retryText =
      intake.contactDetailRetryCount >= 3
        ? CONTACT_PREFERENCE_REASK_LAST_TEXT
        : intake.contactDetailRetryCount === 2
          ? CONTACT_PREFERENCE_REASK_SECOND_TEXT
          : CONTACT_PREFERENCE_REASK_TEXT;
    return {
      text: normalizeAssistantResponse(retryText, config),
      detectedIntent: intent,
      intake
    };
  }

  if (isSoftIntakeTrigger(intent) && !intake.contactPreferenceAsked) {
    const product = ensureProductState(state);
    product.awaitingSelection = false;
    product.awaitingInterestConfirmation = false;
    product.productDialogueState = "handoff_choice_requested";
    product.handoffChoice = "none";
    intake.handoffRequested = intent === "handoff_requested" || intent === "callback_request";
    intake.callbackRequested = intent === "callback_request";
    await emitIntakeEvent(config, ctx, "soft_intake_started", turnIndex, intent, intake);

    // For explicit callback phrases like "Ja, ein Rückruf", skip re-asking callback/email.
    if (intent === "callback_request" && callbackPhraseIndicatesPhone(callerText)) {
      intake.contactPreferenceAsked = true;
      return requestPhoneDetailIntake(config, ctx, turnIndex, "contact_preference_phone", intake);
    }

    intake.contactPreferenceAsked = true;
    intake.waitingFor = "contact_preference";
    await emitIntakeEvent(config, ctx, "contact_preference_requested", turnIndex, intent, intake);

    return {
      text: normalizeAssistantResponse(softIntakeTriggerText(intent, config, callerText), config),
      detectedIntent: intent,
      intake
    };
  }

  return null;
}

function clarificationForQuality(quality) {
  return quality === "incomplete" ? PARTIAL_TRANSCRIPT_TEXT : CLARIFICATION_TEXT;
}

function analyzeCallerTranscript(text, minChars) {
  const detectedIntent = detectIntent(text);
  const classification = classifyTranscript(text, minChars, detectedIntent);
  return {
    detectedIntent: detectedIntent || "unknown",
    normalizedIntent: detectedIntent || "unknown",
    transcriptQuality: classification.quality,
    transcriptQualityReason: classification.reason
  };
}

function extractKeywords(text) {
  return wordsFrom(text).filter((word) => word.length >= 4 && !STOP_WORDS.has(word) && !FILLER_WORDS.has(word));
}

function retrievalKeywords(text) {
  return new Set(
    wordsFrom(text)
      .map((word) => word.trim())
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word) && !FILLER_WORDS.has(word))
  );
}

function retrievalPhrase(text) {
  return normalizeForIntent(text).replace(/[^a-z0-9\s-]/gi, " ").replace(/\s+/g, " ").trim();
}

function retrievalCompact(text) {
  return retrievalPhrase(text).replace(/[-\s]+/g, "");
}

function retrieveFaqAnswer(config, callerText, faqCatalog) {
  if (!config?.knowledgeRetrieval?.enabled) return null;
  const faqs = Array.isArray(faqCatalog?.faqs) ? faqCatalog.faqs : [];
  if (!faqs.length) return null;

  const callerTokens = retrievalKeywords(callerText);
  const callerPhrase = retrievalPhrase(callerText);
  const callerCompact = retrievalCompact(callerText);
  if (!callerTokens.size && !callerPhrase) return null;
  const minScore = Math.max(1, Number(config?.knowledgeRetrieval?.minScore ?? 2));

  let best = null;
  let bestScore = 0;
  for (const faq of faqs) {
    const keys = Array.isArray(faq?.keywords_de) ? faq.keywords_de : [];
    if (!keys.length) continue;

    let score = 0;
    for (const key of keys) {
      const keyPhrase = retrievalPhrase(String(key ?? ""));
      if (!keyPhrase) continue;
      const keyCompact = retrievalCompact(keyPhrase);

      // Strongest signal: direct phrase match, including hyphen/spacing-insensitive compare.
      if (
        (callerPhrase && callerPhrase.includes(keyPhrase)) ||
        (callerCompact && keyCompact && callerCompact.includes(keyCompact))
      ) {
        score += Math.max(2, Math.min(4, keyPhrase.split(" ").filter(Boolean).length));
        continue;
      }

      // Secondary signal: token overlap.
      const keyTokens = retrievalKeywords(keyPhrase);
      for (const token of keyTokens) {
        if (callerTokens.has(token)) score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = faq;
    }
  }

  if (!best || bestScore < minScore) {
    return {
      hit: false,
      bestId: best ? String(best.id ?? "faq") : null,
      bestScore,
      minScore
    };
  }
  const answer = normalizeAssistantResponse(best.answer_de ?? "", config);
  if (!answer) {
    return {
      hit: false,
      bestId: String(best.id ?? "faq"),
      bestScore,
      minScore
    };
  }
  return {
    hit: true,
    answer,
    score: bestScore,
    id: String(best.id ?? "faq"),
    minScore
  };
}

const RAG_NEVER_ROUTE_PATTERN =
  /\b(rueckruf|ruckruf|rückruf|per anruf|telefonisch|per e-?mail|nummer\s*(eins|zwei|drei|vier|fuenf|fünf|1|2|3|4|5)|ja|nein|unter dieser nummer)\b/i;

function looksSemanticKnowledgeQuestion(text) {
  const normalized = normalizeForIntent(text);
  if (!normalized || normalized.length < 8) return false;
  if (RAG_NEVER_ROUTE_PATTERN.test(normalized)) return false;
  return (
    /\?$/.test(String(text || "").trim()) ||
    /\b(was ist|was sind|was macht|wie funktioniert|erklar|erklär|erzaehl|erzähl|unterschied|details)\b/i.test(normalized)
  );
}

function isRagFlowBlocked(state, callerText) {
  const intake = ensureIntakeState(state);
  if (isIntakeActive(intake)) return true;
  const product = ensureProductState(state);
  if (product.awaitingSelection) return true;
  if (product.awaitingInterestConfirmation && !looksSemanticKnowledgeQuestion(callerText)) return true;
  return false;
}

function ragChunkToPhoneAnswer(chunk, config) {
  const content = String(chunk?.content || "").replace(/\s+/g, " ").trim();
  if (!content) return "";
  const directLine = content.match(/(?:Kurze Telefonantwort|Antwort):\s*([^.\n!?]+[.!?]?)/i);
  if (directLine?.[1]) {
    return normalizeAssistantResponse(directLine[1], config);
  }
  const firstSentence = (content.match(/[^.!?]+[.!?]?/g) || [content])[0];
  return normalizeAssistantResponse(firstSentence, config);
}

function normalizeSemanticRagQuery(text) {
  const raw = String(text || "").trim();
  const normalized = normalizeForIntent(raw);
  if (!normalized) return raw;
  const looksLokalKiPrivacy =
    /\bsensibl\w*\s+intern\w*\s+dokument\w*\b/.test(normalized) ||
    /\bsensibl\w*\s+daten\b/.test(normalized) ||
    /\bdatenschutz\b/.test(normalized);
  if (looksLokalKiPrivacy) {
    return "Kann LokalKI mit sensiblen internen Dokumenten und sensiblen Daten arbeiten?";
  }
  return raw;
}

function isApprovedRagDeterministicChunk(chunk) {
  const sourceUri = String(chunk?.source_uri || "");
  const metadata = chunk?.metadata && typeof chunk.metadata === "object" ? chunk.metadata : {};
  const acceptedBy = String(metadata.accepted_by || "");
  const boostReason = String(metadata.score_boost_reason || "");
  const semanticIntent = Array.isArray(metadata.semantic_product_intent)
    ? metadata.semantic_product_intent.map((item) => String(item || "").toLowerCase())
    : [];
  return (
    sourceUri.includes("products.technolohit.json") &&
    acceptedBy === "deterministic_semantic_product_router" &&
    boostReason === "semantic_product_intent" &&
    semanticIntent.includes("lokalki")
  );
}

async function maybeRetrieveRagFallback(config, callerText, turnIndex, effectiveAnalysis, state) {
  if (!config?.rag?.enabled) return { used: false, reason: "rag_disabled" };
  if (!config?.rag?.apiUrl) return { used: false, reason: "rag_api_url_missing" };
  if ((effectiveAnalysis?.transcriptQuality ?? "clear") !== "clear") return { used: false, reason: "transcript_not_clear" };
  if (!looksSemanticKnowledgeQuestion(callerText)) return { used: false, reason: "not_semantic_question" };
  if (isRagFlowBlocked(state, callerText)) return { used: false, reason: "flow_blocked" };

  const baseMinScore = Number(config?.rag?.minScore ?? 0.72);
  const baseTimeoutMs = Number(config?.rag?.timeoutMs || 700);
  const qaTimeoutMs = Math.max(baseTimeoutMs, Number(config?.rag?.qaTimeoutMs || 1200));
  const qaRetryDelta = Math.max(0, Number(config?.rag?.qaRetryDelta || 0.08));
  const qaAcceptFloor = Math.max(0, Number(config?.rag?.qaAcceptFloor || 0.65));
  const normalizedRagQuery = normalizeSemanticRagQuery(callerText);

  const payload = {
    tenant_id: "technolohit",
    query: callerText,
    language: "de",
    top_k: 3,
    min_score: baseMinScore,
    context: {
      turn_index: turnIndex,
      detected_intent: effectiveAnalysis?.detectedIntent ?? "unknown",
      transcript_quality: effectiveAnalysis?.transcriptQuality ?? "clear",
      source: "voice_bridge_fallback"
    }
  };

  console.log(
    `[voice-assistant] rag attempt turn_index=${turnIndex} phase=initial timeout_ms=${baseTimeoutMs} min_score=${baseMinScore.toFixed(2)}`
  );
  let result = await retrieveRagContext(config, { ...payload, timeoutMs: baseTimeoutMs });
  if (!result.ok && result.reason === "timeout" && config?.rag?.qaMode) {
    console.log(
      `[voice-assistant] rag attempt turn_index=${turnIndex} phase=timeout_retry timeout_ms=${qaTimeoutMs} min_score=${baseMinScore.toFixed(2)}`
    );
    result = await retrieveRagContext(config, { ...payload, timeoutMs: qaTimeoutMs });
  }
  if (!result.ok) return { used: false, reason: result.reason, latencyMs: result.latencyMs ?? 0 };

  let body = result.data || {};
  let hit = Boolean(body.hit);
  let firstChunk = Array.isArray(body.answer_context) ? body.answer_context[0] : null;
  let score = Number(firstChunk?.score ?? 0);
  let acceptedByRelaxedQa = false;

  if (!hit && normalizedRagQuery && normalizedRagQuery !== callerText) {
    console.log(
      `[voice-assistant] rag attempt turn_index=${turnIndex} phase=query_normalize_retry timeout_ms=${qaTimeoutMs} min_score=${baseMinScore.toFixed(2)}`
    );
    const normalizedRetry = await retrieveRagContext(config, {
      ...payload,
      query: normalizedRagQuery,
      timeoutMs: config?.rag?.qaMode ? qaTimeoutMs : baseTimeoutMs
    });
    if (normalizedRetry.ok) {
      result = normalizedRetry;
      body = normalizedRetry.data || {};
      hit = Boolean(body.hit);
      firstChunk = Array.isArray(body.answer_context) ? body.answer_context[0] : null;
      score = Number(firstChunk?.score ?? 0);
    }
  }

  if (!hit && config?.rag?.qaMode) {
    const relaxedMinScore = Math.max(0, baseMinScore - qaRetryDelta);
    if (relaxedMinScore < baseMinScore) {
      console.log(
        `[voice-assistant] rag attempt turn_index=${turnIndex} phase=no_hit_retry timeout_ms=${qaTimeoutMs} min_score=${relaxedMinScore.toFixed(2)}`
      );
      const retryResult = await retrieveRagContext(config, { ...payload, min_score: relaxedMinScore, timeoutMs: qaTimeoutMs });
      if (retryResult.ok) {
        result = retryResult;
        body = retryResult.data || {};
        hit = Boolean(body.hit);
        firstChunk = Array.isArray(body.answer_context) ? body.answer_context[0] : null;
        score = Number(firstChunk?.score ?? 0);
        if (hit && Number.isFinite(score) && score >= Math.max(relaxedMinScore, qaAcceptFloor) && score < baseMinScore) {
          acceptedByRelaxedQa = true;
        }
      } else {
        return { used: false, reason: retryResult.reason, latencyMs: retryResult.latencyMs ?? 0 };
      }
    }
  }

  if (!hit) {
    return {
      used: false,
      reason: "rag_no_hit",
      latencyMs: result.latencyMs ?? 0,
      hitCount: Number(result.hitCount || 0),
      topScore: Number.isFinite(Number(result.topScore)) ? Number(result.topScore) : null
    };
  }

  if (!Number.isFinite(score) || (score < baseMinScore && !acceptedByRelaxedQa)) {
    if (firstChunk && isApprovedRagDeterministicChunk(firstChunk)) {
      const deterministicText = ragChunkToPhoneAnswer(firstChunk, config);
      if (deterministicText) {
        return {
          used: true,
          text: deterministicText,
          score,
          sourceUri: String(firstChunk?.source_uri || result.topSource || ""),
          sourceTitle: String(firstChunk?.title || result.topTitle || ""),
          hitCount: Number(result.hitCount || (Array.isArray(body.answer_context) ? body.answer_context.length : 0)),
          topScore: Number.isFinite(score) ? score : null,
          qaRelaxed: acceptedByRelaxedQa,
          deterministicSemanticAccepted: true,
          latencyMs: Number(body?.latency_ms ?? result.latencyMs ?? 0)
        };
      }
    }
    return {
      used: false,
      reason: "rag_low_confidence",
      latencyMs: result.latencyMs ?? 0,
      hitCount: Number(result.hitCount || 0),
      topScore: Number.isFinite(score) ? score : null,
      topSource: String(firstChunk?.source_uri || result.topSource || ""),
      topTitle: String(firstChunk?.title || result.topTitle || "")
    };
  }

  const text = ragChunkToPhoneAnswer(firstChunk, config);
  if (!text) {
    return {
      used: false,
      reason: "rag_empty_answer",
      latencyMs: result.latencyMs ?? 0,
      hitCount: Number(result.hitCount || 0),
      topScore: Number.isFinite(score) ? score : null,
      topSource: String(firstChunk?.source_uri || result.topSource || ""),
      topTitle: String(firstChunk?.title || result.topTitle || "")
    };
  }

  return {
    used: true,
    text,
    score,
    sourceUri: String(firstChunk?.source_uri || result.topSource || ""),
    sourceTitle: String(firstChunk?.title || result.topTitle || ""),
    hitCount: Number(result.hitCount || (Array.isArray(body.answer_context) ? body.answer_context.length : 0)),
    topScore: Number.isFinite(score) ? score : null,
    qaRelaxed: acceptedByRelaxedQa,
    latencyMs: Number(body?.latency_ms ?? result.latencyMs ?? 0)
  };
}

function responseAddressesCaller(callerText, responseText) {
  const intent = detectIntent(callerText);
  const response = String(responseText ?? "").toLowerCase();
  if (intent === "pricing_question") return /\b(preis|kost|umfang|team|details)\b/i.test(response);
  if (intent === "human_or_ai_question") return /digital[er]* assistent|technolohit/i.test(response);
  if (intent === "english_language") return /\b(deutsch|anliegen)\b/i.test(response);
  if (intent === "seo_guarantee_question") return /\b(garantie|ranking|struktur|inhalten|suchanfragen)\b/i.test(response);
  if (intent === "technology_question") return /\b(ki|system|sichtbarkeit|automatisierung|team)\b/i.test(response);
  if (intent === "free_analysis_request") return /\b(ersteinschätzung|einschätzung|ruckruf|rückruf)\b/i.test(response);
  if (intent === "callback_request") return /\b(rueckruf|ruckruf|rückruf|telefonisch|e-?mail)\b/i.test(response);
  if (intent === "handoff_requested") return /\b(team|e-?mail|telefonisch|kontaktiert|erreichen)\b/i.test(response);
  if (intent === "contact_preference_email") return /\b(e-?mail|adresse|ruckmeldung|rückmeldung)\b/i.test(response);
  if (intent === "contact_preference_phone") return /\b(telefon|telefonnummer|ruckruf|rückruf)\b/i.test(response);
  if (intent === "email_provided" || intent === "phone_provided") return /\b(danke|team|weitergeben|meldet)\b/i.test(response);
  if (intent === "refuses_contact_details") return /\b(kein problem|info@technolohit\.com|e-?mail)\b/i.test(response);
  if (intent === "email_campaign_caller") return /\b(e-?mail|ersteinschätzung|unternehmen)\b/i.test(response);
  if (intent === "smart_website_interest") return /\b(intelligent|website|anfragen|unternehmen)\b/i.test(response);
  if (intent === "product_overview_request") return /smart|aiseoq|botinteg|lokalki|rezeption|lösung|loesung/i.test(response);
  if (intent === "product_selection_smart_website") return /smart|website|sichtbarkeit|lead|anfrage|ki-chat/i.test(response);
  if (intent === "product_selection_aiseoq") return /aiseoq|seo|wettbewerb|agenturen|reports/i.test(response);
  if (intent === "product_selection_botinteg") return /botinteg|chatbot|automatisierung|lead|faq|social/i.test(response);
  if (intent === "product_selection_lokalki") return /lokalki|private|lokal|daten|dokumente|datenschutz/i.test(response);
  if (intent === "product_selection_voice_agent") return /rezeption|voice|anruf|telefon|rückruf|ruckruf|lead/i.test(response);
  if (intent === "compare_products_request") return /smart|botinteg|lokalki|produkt|lösung|loesung/i.test(response);
  if (intent === "product_interest_confirmed") return /rückruf|ruckruf|e-?mail|team|melden/i.test(response);
  if (intent === "what") return /technolohit|website|assistent|automatisierung|anfragen/i.test(response);
  if (intent === "website") return /website|webseite|homepage|internetauftritt/i.test(response);
  if (intent === "voice_assistant_question") return /assistent|rezeption|kundenfragen|telefon|website/i.test(response);
  if (intent === "inquiries") return /anfrage|anfragen|kontakt|team|kunden/i.test(response);
  if (intent === "visibility") return /sichtbarkeit|google|lokal|ranking|website|kunden/i.test(response);

  const callerKeywords = extractKeywords(callerText);
  if (!callerKeywords.length) return true;
  return callerKeywords.some((word) => response.includes(word));
}

function responseTemplateFromIntent(intent) {
  const value = String(intent || "");
  if (
    value === "contact_preference_email" ||
    value === "soft_intake_email_directed" ||
    value === "email_provided"
  ) {
    return "email_instruction";
  }
  if (value === "contact_preference_phone" || value === "callback_request" || value === "phone_provided") {
    return "phone_request";
  }
  if (value.includes("permission")) return "permission";
  if (
    value.includes("goodbye") ||
    value.includes("closing") ||
    value === "product_interest_declined" ||
    value === "post_capture_warm_goodbye"
  ) {
    return "closing";
  }
  if (value.startsWith("product_")) return "product_intake";
  return "soft_intake";
}

function makeSafeError(err) {
  const status = err?.status ? `status=${err.status}` : "";
  const code = err?.code ? ` code=${err.code}` : "";
  const message = err?.message ?? String(err);
  return `${status}${code} ${message}`.trim();
}

function isGoodbye(text) {
  return /\b(tsch(ü|u)ss|auf wiederh(ö|o)ren|bis bald|sch(ö|o)nen tag|danke das war|das war alles|reicht erstmal)\b/i.test(
    text
  );
}

function sequenceNumber(turnIndex, speaker) {
  return (turnIndex * 2) - (speaker === "caller" ? 1 : 0);
}

function turnState(ctx) {
  if (!ctx.assistantTurn) {
    ctx.assistantTurn = {
      active: false,
      started: false,
      completed: false,
      currentTurnIndex: 0,
      chunks: [],
      bytes: 0,
      history: [],
      clarificationAsked: false,
      unknownIntentCount: 0,
      intake: createIntakeState(),
      product: createProductState()
    };
  }
  ensureIntakeState(ctx.assistantTurn);
  ensureProductState(ctx.assistantTurn);
  return ctx.assistantTurn;
}

export function captureAssistantTurnAudio(config, ctx, payload) {
  if (!config.assistant?.enabled) return;
  if (!payload?.length) return;

  const state = ctx.assistantTurn;
  if (!state?.active) return;

  const maxListenMs = Math.max(1000, Number(config.assistant.maxListenMs || 10000));
  const maxBytes = Math.max(0, Math.floor(config.sampleRate * 2 * (maxListenMs / 1000)));
  if (state.bytes + payload.length > maxBytes) return;

  const chunk = Buffer.from(payload);
  state.chunks.push(chunk);
  state.bytes += payload.length;

  const rms = pcmRms(chunk);
  state.lastRms = rms;
  if (rms >= speechRmsThreshold(config)) {
    state.speechDetected = true;
    state.lastSpeechAt = nowMs();
  }
}

async function writeTurnCallerAudio(config, ctx, turnIndex, pcm) {
  const dir = String(config.recording?.dir || "/app/recordings");
  await fsp.mkdir(dir, { recursive: true });

  const slinPath = path.join(dir, `${safeBaseName(ctx, `turn${turnIndex}-caller`)}.slin`);
  const wavPath = path.join(dir, `${safeBaseName(ctx, `turn${turnIndex}-caller`)}.wav`);

  await fsp.writeFile(slinPath, pcm);
  await convertSlinToWav(slinPath, wavPath);

  const result = {
    slinPath,
    wavPath,
    audioBytes: pcm.length,
    wavBytes: await fileSize(wavPath)
  };
  console.log(
    `[voice-assistant] caller turn audio wrote turn=${turnIndex} slin=${slinPath} wav=${wavPath} bytes=${result.audioBytes}`
  );
  return result;
}

async function listenForTurn(config, ctx, turnIndex) {
  const state = turnState(ctx);
  state.currentTurnIndex = turnIndex;
  state.active = true;
  state.chunks = [];
  state.bytes = 0;
  state.speechDetected = false;
  state.speechEndDetected = false;
  state.lastSpeechAt = null;
  state.lastRms = 0;

  const intake = ensureIntakeState(state);
  const product = ensureProductState(state);
  const fastTurnContext = Boolean(
    intake.closingPending ||
      intake.waitingFor === "permission" ||
      intake.waitingFor === "contact_preference" ||
      intake.waitingFor === "contact_detail" ||
      (product.awaitingInterestConfirmation && product.selectedProduct === "botinteg")
  );

  const baseMinListenMs = Math.max(250, Number(config.assistant.minListenMs || 2500));
  const baseMaxListenMs = Math.max(baseMinListenMs, Number(config.assistant.maxListenMs || 10000));
  const baseEndSilenceMs = Math.max(250, Number(config.assistant.endSilenceMs || 900));
  const minListenMs = fastTurnContext ? Math.min(baseMinListenMs, 1400) : baseMinListenMs;
  const maxListenMs = fastTurnContext ? Math.min(baseMaxListenMs, 6200) : baseMaxListenMs;
  const endSilenceMs = fastTurnContext ? Math.min(baseEndSilenceMs, 650) : baseEndSilenceMs;
  const startedAt = nowMs();
  console.log(
    `[voice-assistant] listening for caller turn=${turnIndex} min_listen_ms=${minListenMs} max_listen_ms=${maxListenMs} end_silence_ms=${endSilenceMs} fast_turn_context=${fastTurnContext}`
  );

  while (!ctx.closed) {
    await sleep(100);
    const elapsedMs = elapsedSince(startedAt);

    if (elapsedMs >= maxListenMs) {
      break;
    }

    if (!state.speechDetected || elapsedMs < minListenMs) {
      continue;
    }

    const silenceMs = state.lastSpeechAt ? Date.now() - state.lastSpeechAt : 0;
    if (silenceMs >= endSilenceMs) {
      state.speechEndDetected = true;
      break;
    }
  }

  state.active = false;
  const listenDurationMs = elapsedSince(startedAt);
  const pcm = state.bytes ? Buffer.concat(state.chunks, state.bytes) : Buffer.alloc(0);
  return {
    pcm,
    audioBytes: state.bytes,
    listenDurationMs,
    speechDetected: Boolean(state.speechDetected),
    speechEndDetected: Boolean(state.speechEndDetected),
    lastRms: state.lastRms || 0
  };
}

async function transcribeTurn(config, ctx, turnIndex, audio, timings) {
  const model = config.transcription?.model || "gpt-4o-mini-transcribe";
  const language = config.transcription?.language || "de";
  const minChars = Math.max(0, Number(config.assistant?.minTranscriptChars ?? 5));

  const request = {
    file: fs.createReadStream(audio.wavPath),
    model,
    language,
    response_format: "json"
  };

  if (config.transcription?.prompt) {
    request.prompt = config.transcription.prompt;
  }

  const startedAt = nowMs();
  const response = await getClient().audio.transcriptions.create(request);
  timings.transcriptionMs = elapsedSince(startedAt);

  const text = typeof response?.text === "string" ? response.text.trim() : "";
  if (!text) {
    console.log(
      `[voice-assistant] turn transcribed turn_index=${turnIndex} length=0 caller_transcript_preview="" normalized_intent=unknown transcript_quality=unclear transcription_ms=${timings.transcriptionMs}`
    );
    return "";
  }

  if (isLikelySttPromptLeak(text)) {
    console.log(
      `[voice-assistant] turn transcribed turn_index=${turnIndex} length=${text.length} caller_transcript_preview=${previewForLogs(config, text)} normalized_intent=unknown transcript_quality=unclear transcript_rejected_reason=stt_prompt_leak transcription_ms=${timings.transcriptionMs}`
    );
    return "";
  }

  const analysis = analyzeCallerTranscript(text, minChars);

  await persist.onTurnTranscribed(config, ctx, {
    text,
    model,
    language,
    recordingWavPath: audio.wavPath,
    recordingSlinPath: audio.slinPath,
    audioBytes: audio.audioBytes,
    turnIndex,
    sequenceNumber: sequenceNumber(turnIndex, "caller"),
    detectedIntent: analysis.detectedIntent,
    transcriptQuality: analysis.transcriptQuality,
    transcriptQualityReason: analysis.transcriptQualityReason,
    timings
  });

  console.log(
    `[voice-assistant] turn transcribed turn_index=${turnIndex} length=${text.length} caller_transcript_preview=${previewForLogs(config, text)} normalized_intent=${analysis.normalizedIntent} transcript_quality=${analysis.transcriptQuality} transcription_ms=${timings.transcriptionMs}`
  );
  if (config.assistant?.qaLogTranscriptPreview) {
    console.log(
      `[voice-assistant][qa] transcript turn_index=${turnIndex} qa_preview=${qaPreviewForLogs(config, text)} normalized_intent=${analysis.normalizedIntent} transcript_quality=${analysis.transcriptQuality}`
    );
  }
  return text;
}

function conversationHistoryText(history) {
  const compactHistory = history.slice(-HISTORY_TURNS);
  if (!compactHistory.length) return "Noch kein vorheriger Dialog.";
  return compactHistory
    .map((entry, index) => `Turn ${index + 1} Anrufer: ${entry.caller}\nTurn ${index + 1} Assistent: ${entry.assistant}`)
    .join("\n\n");
}

async function createAssistantResponse(config, ctx, turnIndex, callerText, history, timings, analysis) {
  const knowledge = await readKnowledge();
  const productCatalog = await readProductCatalog();
  const faqCatalog = await readFaqCatalog();
  const model = config.assistant.model || "gpt-4o-mini";
  const version = knowledgeVersion(knowledge);
  const baseIntent = analysis?.detectedIntent && analysis.detectedIntent !== "unknown" ? analysis.detectedIntent : "";
  const state = turnState(ctx);
  const resolvedProductIntent = resolveProductIntent(
    callerText,
    baseIntent,
    ensureProductState(state),
    ensureIntakeState(state)
  );
  const effectiveAnalysis =
    resolvedProductIntent && resolvedProductIntent !== baseIntent
      ? {
          ...analysis,
          detectedIntent: resolvedProductIntent,
          normalizedIntent: resolvedProductIntent,
          transcriptQuality: "clear",
          transcriptQualityReason: "product_context_resolved"
        }
      : analysis;
  const intent =
    effectiveAnalysis?.detectedIntent && effectiveAnalysis.detectedIntent !== "unknown"
      ? effectiveAnalysis.detectedIntent
      : "";

  if (intent && intent !== "unknown" && (effectiveAnalysis?.transcriptQuality ?? "clear") === "clear") {
    state.unknownIntentCount = 0;
  }

  const instructions = [
    "Du bist der digitale Assistent von TechnoloHit am Telefon.",
    "Antworte immer auf Deutsch, natürlich, kurz, warm, ruhig und professionell.",
    "Jede Antwort muss direkt auf die neueste Aussage des Anrufers eingehen.",
    "Nutze nur diese drei Quellen: die neueste Anruferaussage, den kurzen bisherigen Dialog und den TechnoloHit-Kontext.",
    "Erfinde keine Services, Preise, Garantien, Rechtsaussagen, Verfügbarkeiten, Zeitpläne oder technischen Details.",
    "Wenn du etwas nicht sicher weißt, sage das kurz und biete an, dass ein Teammitglied zurückruft oder Details klärt.",
    `Wenn du unsicher bist, nutze sinngemäß diese Fallback-Antwort: "${UNKNOWN_FALLBACK_TEXT}"`,
    "Keine Marketingabsätze, keine Listen, keine Stichpunkte und nicht die Frage ignorieren.",
    "Stelle höchstens eine kurze Rückfrage.",
    `Halte die Antwort telefongeeignet: maximal ${maxResponseSentences(config)} kurze Sätze und maximal ${maxResponseChars(config)} Zeichen.`,
    "Für bekannte Absichten werden kurze direkte Antworten bevorzugt.",
    'Wenn gefragt wird, ob du eine KI oder echte Person bist, antworte genau: "Ich bin der digitale Assistent von TechnoloHit."',
    "Wenn nach Preisen gefragt wird, nenne keine Zahlen und erkläre, dass es vom Umfang abhängt.",
    "Gib keine SEO-Ranking-Garantien und keine Produktnamen wie Botinteg, AISeoQ oder LokalKI als Standardantwort."
  ].join(" ");

  let text = "";
  let usedClarificationFallback = false;
  let usedRelevanceFallback = false;
  let usedTemplateResponse = false;
  let usedLlmResponse = false;
  let responseDetectedIntent = effectiveAnalysis?.detectedIntent ?? "unknown";
  let finalResponseTemplate = "none";
  let businessFallbackIntent = "none";
  let businessFallbackSource = "none";
  let businessFallbackGuidance = "none";
  let businessFallbackNextStep = "none";

  const productResponse = maybeCreateProductResponse(config, ctx, turnIndex, callerText, effectiveAnalysis, productCatalog);
  if (productResponse?.text) {
    text = productResponse.text;
    timings.responseGenerationMs = 0;
    usedTemplateResponse = true;
    responseDetectedIntent = productResponse.detectedIntent ?? responseDetectedIntent;
    finalResponseTemplate =
      productResponse.finalResponseTemplate || responseTemplateFromIntent(productResponse.detectedIntent);
  } else {
    const softIntakeResponse = await maybeCreateSoftIntakeResponse(
      config,
      ctx,
      turnIndex,
      callerText,
      effectiveAnalysis
    );
    if (softIntakeResponse?.text) {
      text = softIntakeResponse.text;
      timings.responseGenerationMs = 0;
      usedTemplateResponse = true;
      responseDetectedIntent = softIntakeResponse.detectedIntent ?? responseDetectedIntent;
      finalResponseTemplate =
        softIntakeResponse.finalResponseTemplate || responseTemplateFromIntent(softIntakeResponse.detectedIntent);
      if (softIntakeResponse.businessFallbackIntent) {
        businessFallbackIntent = softIntakeResponse.businessFallbackIntent;
        businessFallbackSource = softIntakeResponse.businessFallbackSource || "deterministic";
        businessFallbackGuidance = softIntakeResponse.businessFallbackGuidance || "none";
        businessFallbackNextStep = softIntakeResponse.businessFallbackNextStep || "none";
      }
    } else {
      const businessFallbackResponse = maybeCreateBusinessFallbackResponse(
        config,
        ctx,
        turnIndex,
        callerText,
        effectiveAnalysis,
        ensureProductState(state)
      );
      if (businessFallbackResponse?.text) {
        text = businessFallbackResponse.text;
        timings.responseGenerationMs = 0;
        usedTemplateResponse = true;
        responseDetectedIntent = businessFallbackResponse.detectedIntent ?? responseDetectedIntent;
        finalResponseTemplate = businessFallbackResponse.finalResponseTemplate || "business_fallback";
        businessFallbackIntent = businessFallbackResponse.businessFallbackIntent || responseDetectedIntent;
        businessFallbackSource = businessFallbackResponse.businessFallbackSource || "deterministic";
        businessFallbackGuidance = businessFallbackResponse.businessFallbackGuidance || "none";
        businessFallbackNextStep = businessFallbackResponse.businessFallbackNextStep || "none";
      } else if (KNOWN_INTENTS.has(intent)) {
        text = templateResponseForIntent(intent, config, callerText);
        if ((intent === "what" || intent === "product_overview_request") && history.length > 0) {
          text = unknownResponse(config);
          responseDetectedIntent = "unknown_intent_clarification";
          finalResponseTemplate = "clarification";
        }
        timings.responseGenerationMs = 0;
        usedTemplateResponse = true;
        finalResponseTemplate =
          finalResponseTemplate === "clarification" ? finalResponseTemplate : "product_intake";
      } else {
      state.unknownIntentCount = Number(state.unknownIntentCount || 0) + 1;
      const unknownCount = state.unknownIntentCount;
      const voiceAgentSynonym = matchProductPolicyFromText(callerText)?.key === "digital_assistant";

      if (unknownCount > UNKNOWN_INTENT_LOOP_LIMIT) {
        text = normalizeAssistantResponse(UNKNOWN_LOOP_HANDOFF_TEXT, config);
        timings.responseGenerationMs = 0;
        usedTemplateResponse = true;
        responseDetectedIntent = "unknown_intent_loop_handoff";
        finalResponseTemplate = "soft_intake";
        const intakeState = ensureIntakeState(state);
        intakeState.contactPreferenceAsked = true;
        intakeState.waitingFor = "contact_preference";
      } else if (voiceAgentSynonym && unknownCount === 1) {
        text = normalizeAssistantResponse(VOICE_AGENT_SYNONYM_CLARIFICATION_TEXT, config);
        timings.responseGenerationMs = 0;
        usedTemplateResponse = true;
        responseDetectedIntent = "voice_agent_synonym_clarification";
        finalResponseTemplate = "clarification";
      } else {
      const intakeActive = isIntakeActive(ensureIntakeState(state));
      const productActive = isProductFlowActive(ensureProductState(state));
      const faqHit = !intakeActive && !productActive ? retrieveFaqAnswer(config, callerText, faqCatalog) : null;

      if (faqHit?.hit) {
        text = faqHit.answer;
        timings.responseGenerationMs = 0;
        usedTemplateResponse = true;
        responseDetectedIntent = "knowledge_retrieval_answer";
        finalResponseTemplate = "knowledge";
        console.log(
          `[voice-assistant] retrieval hit turn_index=${turnIndex} faq_id=${faqHit.id} score=${faqHit.score} min_score=${faqHit.minScore}`
        );
      } else {
        if (faqHit && !faqHit.hit) {
          console.log(
            `[voice-assistant] retrieval miss turn_index=${turnIndex} best_faq_id=${faqHit.bestId ?? "none"} best_score=${faqHit.bestScore} min_score=${faqHit.minScore}`
          );
        }
        const ragResult = await maybeRetrieveRagFallback(config, callerText, turnIndex, effectiveAnalysis, state);
        if (ragResult.used) {
          text = appendRagFollowUpQuestion(ragResult.text, config);
          timings.responseGenerationMs = Number(ragResult.latencyMs || 0);
          usedTemplateResponse = true;
          responseDetectedIntent = "rag_fallback_answer";
          finalResponseTemplate = "knowledge";
          const hitTopScore = Number(ragResult.topScore ?? ragResult.score);
          const hitTopScoreText = Number.isFinite(hitTopScore) ? hitTopScore.toFixed(4) : "n/a";
          console.log(
            `[voice-assistant] rag fallback hit turn_index=${turnIndex} rag_status=hit latency_ms=${timings.responseGenerationMs} hit_count=${Number(ragResult.hitCount || 0)} top_score=${hitTopScoreText} selected_title=${ragResult.sourceTitle || "unknown"} selected_source=${ragResult.sourceUri || "unknown"} qa_relaxed=${Boolean(ragResult.qaRelaxed)} deterministic_semantic_accepted=${Boolean(ragResult.deterministicSemanticAccepted)}`
          );
        } else {
          if (config?.rag?.enabled) {
            const topScore =
              ragResult.topScore == null || Number.isNaN(Number(ragResult.topScore))
                ? "n/a"
                : Number(ragResult.topScore).toFixed(4);
            console.log(
              `[voice-assistant] rag fallback skip turn_index=${turnIndex} rag_status=skip reason=${ragResult.reason || "unknown"} latency_ms=${Number(ragResult.latencyMs || 0)} hit_count=${Number(ragResult.hitCount || 0)} top_score=${topScore} selected_title=${ragResult.topTitle || "n/a"} selected_source=${ragResult.topSource || "n/a"}`
            );
          }
          const startedAt = nowMs();
          if (ctx.qaMode) {
            text = unknownResponse(config);
            timings.responseGenerationMs = 0;
            usedTemplateResponse = true;
            usedRelevanceFallback = true;
            usedLlmResponse = false;
            finalResponseTemplate = "qa_skipped_llm";
          } else {
          const response = await getClient().responses.create({
            model,
            instructions,
            input: `TechnoloHit-Kontext (${KNOWLEDGE_SOURCE}, ${version}):\n${knowledge}\n\nProduktkatalog (${PRODUCT_CATALOG_SOURCE}):\n${JSON.stringify(productCatalog)}\n\nFAQ-Katalog (${FAQ_CATALOG_SOURCE}):\n${JSON.stringify(faqCatalog)}\n\nKompakter bisheriger Dialog:\n${conversationHistoryText(history)}\n\nNeueste Aussage des Anrufers:\n${callerText}\n\nErkannte Absicht: unknown\nTranskriptqualität: ${effectiveAnalysis?.transcriptQuality ?? "clear"}\n\nAntworte jetzt als Telefonassistent. Beziehe dich direkt auf das Hauptthema der neuesten Aussage. Wenn du es nicht sicher beantworten kannst, nutze die Unknown-Antwort.`,
            max_output_tokens: 110
          });
          timings.responseGenerationMs = elapsedSince(startedAt);
          usedLlmResponse = true;
          finalResponseTemplate = "llm";

          text = normalizeAssistantResponse(extractText(response), config);
          if (!text) {
            text = unknownResponse(config);
            usedTemplateResponse = true;
            usedRelevanceFallback = true;
            usedLlmResponse = false;
          } else if (!responseAddressesCaller(callerText, text)) {
            text = unknownResponse(config);
            usedTemplateResponse = true;
            usedRelevanceFallback = true;
            usedLlmResponse = false;
          }
          }
        }
      }
      }
    }
    }
  }

  if (!text) {
    text = CLARIFICATION_TEXT;
    usedClarificationFallback = true;
  }

  const intakeState = ensureIntakeState(turnState(ctx));
  if (
    intakeState.completed &&
    intakeState.postCompletionFollowupUsed &&
    intakeState.waitingFor === "post_completion_question" &&
    !intakeState.finalGoodbyeSent &&
    responseDetectedIntent !== "post_capture_warm_goodbye" &&
    finalResponseTemplate !== "business_fallback" &&
    !responseContainsFinalCloseQuestion(text)
  ) {
    text = normalizeAssistantResponse(`${text} ${POST_CAPTURE_FINAL_CLOSE_QUESTION_TEXT}`, config);
    intakeState.closingPending = true;
    intakeState.waitingFor = "closing_answer";
    console.log(
      `[voice-assistant] soft intake closing turn_index=${turnIndex} post_completion_followup=pending closing_policy=ask_final_question soft_intake_state=${intakeStage(intakeState)}`
    );
  }

  const currentIntake = intakeMetadata(turnState(ctx).intake);
  const currentProduct = productMetadata(turnState(ctx).product);
  const closingPolicyLog = currentIntake.closingPending ? "ask_final_question" : "not_applicable";

  const permissionContextMatch =
    intakeState.permissionDetectionSource ||
    (intakeState.contactPermissionRequested && intakeState.contactPermissionGranted === null ? "awaiting" : "none");

  const metadata = {
    responseText: text,
    normalizedIntent: responseDetectedIntent,
    transcriptQuality: effectiveAnalysis?.transcriptQuality ?? "clear",
    product_intake_product: currentProduct.productIntakeProduct ?? currentProduct.productInterest ?? null,
    product_intake_stage: currentProduct.productIntakeStage ?? "idle",
    handoff_choice: currentProduct.handoffChoice ?? "none",
    soft_intake_state: currentIntake.softIntakeState ?? "not_started",
    softIntakeCompleted: Boolean(currentIntake.softIntakeCompleted),
    softIntakeLeadCreated: Boolean(currentIntake.softIntakeLeadCreated),
    contactDetailAttempted: Boolean(currentIntake.contactDetailAttempted),
    contactDetailValid: Boolean(currentIntake.contactDetailValid),
    product_flow_state: currentProduct.productFlowState ?? "not_started",
    business_fallback_intent: businessFallbackIntent,
    business_fallback_source: businessFallbackSource,
    business_fallback_guidance: businessFallbackGuidance,
    business_fallback_next_step: businessFallbackNextStep,
    final_response_template: finalResponseTemplate,
    used_template_response: usedTemplateResponse,
    used_llm_response: usedLlmResponse,
    closing_reason: null,
    clear_close_detected: false,
    permission_context_match: permissionContextMatch
  };

  if (!ctx.qaMode) {
    await persist.onAssistantResponseCreated(config, ctx, {
      text,
      model,
      language: "de",
      knowledgeFile: knowledgePath,
      knowledgeSource: KNOWLEDGE_SOURCE,
      knowledgeVersion: version,
      assistantModel: model,
      responseChars: text.length,
      detectedIntent: responseDetectedIntent,
      transcriptQuality: effectiveAnalysis?.transcriptQuality ?? "clear",
      transcriptQualityReason: effectiveAnalysis?.transcriptQualityReason ?? "clear",
      usedTemplateResponse,
      usedLlmResponse,
      usedClarificationFallback,
      usedRelevanceFallback,
      finalResponseTemplate,
      turnIndex,
      sequenceNumber: sequenceNumber(turnIndex, "assistant"),
      timings,
      ...currentIntake,
      ...currentProduct
    });
  }

  console.log(
    `[voice-assistant] response created turn_index=${turnIndex} caller_transcript_preview=${previewForLogs(config, callerText)} normalized_intent=${responseDetectedIntent} transcript_quality=${effectiveAnalysis?.transcriptQuality ?? "clear"} response_preview=${previewForLogs(config, text)} used_template_response=${usedTemplateResponse} used_llm_response=${usedLlmResponse} clarification_fallback=${usedClarificationFallback} relevance_fallback=${usedRelevanceFallback} final_response_template=${finalResponseTemplate} response_chars=${text.length} soft_intake_state=${currentIntake.softIntakeState} product_flow_state=${currentProduct.productFlowState} product_interest=${currentProduct.productInterest ?? ""} product_intake_stage=${currentProduct.productIntakeStage ?? "idle"} handoff_choice=${currentProduct.handoffChoice ?? "none"} closing_policy=${closingPolicyLog} response_generation_ms=${timings.responseGenerationMs}`
  );
  return { text, metadata };
}

async function synthesizeAssistantResponse(config, ctx, turnIndex, text, timings) {
  const dir = String(config.recording?.dir || "/app/recordings");
  await fsp.mkdir(dir, { recursive: true });

  const wavPath = path.join(dir, `${safeBaseName(ctx, `turn${turnIndex}-assistant`)}.wav`);
  const slinPath = path.join(dir, `${safeBaseName(ctx, `turn${turnIndex}-assistant`)}.slin`);

  const startedAt = nowMs();
  const audio = await getClient().audio.speech.create({
    model: config.assistant.ttsModel || "gpt-4o-mini-tts",
    voice: config.assistant.ttsVoice || "marin",
    input: text,
    speed: Math.min(1.15, Math.max(0.75, Number(config.assistant.ttsSpeed || 1.0))),
    instructions:
      "Speak German with a warm, calm, professional business receptionist tone. Natural pacing, clear pronunciation, friendly and concise.",
    response_format: "wav"
  });

  const wav = Buffer.from(await audio.arrayBuffer());
  if (!wav.length) throw new Error("assistant TTS response was empty");

  await fsp.writeFile(wavPath, wav);
  await convertWavToSlin(wavPath, slinPath);

  const pcm = await fsp.readFile(slinPath);
  if (!pcm.length) throw new Error("assistant PCM conversion produced empty audio");

  timings.ttsMs = elapsedSince(startedAt);
  console.log(
    `[voice-assistant] response synthesized turn=${turnIndex} wav=${wavPath} slin=${slinPath} bytes=${pcm.length} tts_ms=${timings.ttsMs}`
  );
  return { wavPath, slinPath, pcm };
}

async function playAssistantAudio(config, ctx, socket, playback, turnIndex, assistantAudio, timings) {
  if (ctx.closed || !socket.writable) return null;

  playback.stopSilenceWriter(ctx);
  const startedAt = nowMs();
  const stats = await playback.streamPcmToSocket(socket, assistantAudio.pcm, config, "assistant response");
  timings.playbackMs = elapsedSince(startedAt);
  if (timings.turnStartedAt) {
    timings.totalTurnMs = elapsedSince(timings.turnStartedAt);
  }

  await persist.onAssistantResponsePlayed(config, ctx, {
    ttsModel: config.assistant.ttsModel,
    ttsVoice: config.assistant.ttsVoice,
    frames: stats.frames,
    bytes: stats.bytes,
    audioFile: assistantAudio.slinPath,
    turnIndex,
    timings
  });

  playback.startSilenceWriter(config, ctx, socket);
  return stats;
}

async function createAndPlayClarification(config, ctx, socket, playback, turnIndex, timings, analysis) {
  timings.responseGenerationMs = timings.responseGenerationMs ?? 0;
  const clarificationText = clarificationForQuality(analysis?.transcriptQuality);
  await persist.onAssistantResponseCreated(config, ctx, {
    text: clarificationText,
    model: "static_clarification",
    language: "de",
    knowledgeFile: knowledgePath,
    knowledgeSource: KNOWLEDGE_SOURCE,
    knowledgeVersion: "static",
    assistantModel: "static_clarification",
    responseChars: clarificationText.length,
    detectedIntent: analysis?.detectedIntent ?? "unknown",
    transcriptQuality: analysis?.transcriptQuality ?? "unclear",
    transcriptQualityReason: analysis?.transcriptQualityReason ?? "unclear",
    usedTemplateResponse: false,
    usedLlmResponse: false,
    usedClarificationFallback: true,
    usedRelevanceFallback: false,
    turnIndex,
    sequenceNumber: sequenceNumber(turnIndex, "assistant"),
    timings
  });
  console.log(
    `[voice-assistant] response created turn_index=${turnIndex} normalized_intent=${analysis?.normalizedIntent ?? "unknown"} transcript_quality=${analysis?.transcriptQuality ?? "unclear"} response_preview=${previewForLogs(config, clarificationText)} used_template_response=false clarification_fallback=true relevance_fallback=false response_chars=${clarificationText.length} response_generation_ms=${timings.responseGenerationMs}`
  );

  const assistantAudio = await synthesizeAssistantResponse(config, ctx, turnIndex, clarificationText, timings);
  await playAssistantAudio(config, ctx, socket, playback, turnIndex, assistantAudio, timings);
  return clarificationText;
}

async function createAndPlayMaxTurnsClose(
  config,
  ctx,
  socket,
  playback,
  turnIndex,
  timings,
  responseText,
  intakeContext = {}
) {
  const text = responseText || MAX_TURNS_CALLBACK_TEXT;
  timings.responseGenerationMs = timings.responseGenerationMs ?? 0;
  await persist.onAssistantResponseCreated(config, ctx, {
    text,
    model: "static_max_turns",
    language: "de",
    knowledgeFile: knowledgePath,
    knowledgeSource: KNOWLEDGE_SOURCE,
    knowledgeVersion: "static",
    assistantModel: "static_max_turns",
    responseChars: text.length,
    detectedIntent: text === MAX_TURNS_CALLBACK_TEXT ? "max_turns_callback" : "max_turns_wrapup",
    transcriptQuality: "clear",
    transcriptQualityReason: "max_turns",
    usedTemplateResponse: true,
    usedLlmResponse: false,
    usedClarificationFallback: false,
    usedRelevanceFallback: false,
    turnIndex,
    sequenceNumber: sequenceNumber(turnIndex, "assistant"),
    timings,
    ...intakeContext
  });

  console.log(
    `[voice-assistant] max turns closing turn_index=${turnIndex} response_preview=${previewForLogs(config, text)} response_chars=${text.length}`
  );

  const assistantAudio = await synthesizeAssistantResponse(config, ctx, turnIndex, text, timings);
  await playAssistantAudio(config, ctx, socket, playback, turnIndex, assistantAudio, timings);
}

async function runAssistantConversation(config, ctx, socket, playback) {
  const state = turnState(ctx);
  const maxTurns = Math.max(1, Number(config.assistant.maxTurns || 3));
  const maxTurnsWithIntake = Math.max(maxTurns, Number(config.assistant.maxTurnsWithIntake || maxTurns + 2));
  const maxTurnsWithHumanClosing = maxTurnsWithIntake + 1;
  const maxTurnsWithSoftIntakePending = maxTurnsWithIntake + 3;
  const conversationTurnLimit = Math.max(maxTurnsWithHumanClosing, maxTurnsWithSoftIntakePending);
  const minChars = Math.max(0, Number(config.assistant.minTranscriptChars ?? 5));
  let finishReason = "max_turns";
  let turnsCompleted = 0;
  let effectiveMaxTurns = maxTurns;

  for (let turnIndex = 1; turnIndex <= conversationTurnLimit; turnIndex += 1) {
    const intakeBeforeTurn = ensureIntakeState(state);
    const productBeforeTurn = ensureProductState(state);
    const activeSoftIntake = isIntakeActive(intakeBeforeTurn);
    const activeProductFlow = isProductFlowActive(productBeforeTurn);
    const activeBotintegClarification =
      activeProductFlow &&
      productBeforeTurn.selectedProduct === "botinteg" &&
      !productBeforeTurn.botintegFollowupResolved;
    const awaitingHumanClosing = Boolean(intakeBeforeTurn.closingPending);
    const waitingForPermission =
      intakeBeforeTurn.contactPermissionRequested &&
      intakeBeforeTurn.contactPermissionGranted === null &&
      intakeBeforeTurn.waitingFor === "permission";
    const softIntakeTurnProtection = needsSoftIntakeTurnProtection(intakeBeforeTurn);
    effectiveMaxTurns = softIntakeTurnProtection
      ? maxTurnsWithSoftIntakePending
      : awaitingHumanClosing
        ? maxTurnsWithHumanClosing
        : activeSoftIntake
          ? maxTurnsWithIntake
          : activeBotintegClarification
            ? maxTurnsWithHumanClosing
            : activeProductFlow
              ? maxTurnsWithIntake
              : maxTurns;
    if (softIntakeTurnProtection && turnIndex > maxTurns) {
      intakeBeforeTurn.softIntakeMaxTurnProtected = true;
      intakeBeforeTurn.maxTurnsExtendedForIntake = true;
      intakeBeforeTurn.maxTurnsBlockedByActiveIntake = true;
      if (waitingForPermission) intakeBeforeTurn.maxTurnsBlockedByPermissionState = true;
    } else if (activeSoftIntake && turnIndex > maxTurns) {
      intakeBeforeTurn.maxTurnsExtendedForIntake = true;
      intakeBeforeTurn.maxTurnsBlockedByActiveIntake = true;
      if (waitingForPermission) intakeBeforeTurn.maxTurnsBlockedByPermissionState = true;
    }
    if (softIntakeTurnProtection && turnIndex === maxTurns + 1) {
      console.log(
        `[voice-assistant] soft intake max turn protection turn_index=${turnIndex} soft_intake_max_turn_protected=true soft_intake_state=${intakeStage(intakeBeforeTurn)}`
      );
    }
    if (turnIndex > effectiveMaxTurns) {
      finishReason = "max_turns";
      break;
    }

    if (ctx.closed) {
      finishReason = "call_closed";
      break;
    }

    const turnStartedAt = nowMs();
    const timings = {
      turnStartedAt,
      listenDurationMs: 0,
      transcriptionMs: null,
      responseGenerationMs: null,
      ttsMs: null,
      playbackMs: null,
      totalTurnMs: null
    };

    try {
      const listened = await listenForTurn(config, ctx, turnIndex);
      timings.listenDurationMs = listened.listenDurationMs;
      timings.speechEndDetected = listened.speechEndDetected;
      timings.speechDetected = listened.speechDetected;
      timings.audioBytesCaptured = listened.audioBytes;

      if (!listened.audioBytes) {
        const intakeOnSilence = ensureIntakeState(state);
        if (intakeOnSilence.closingPending) {
          const closeText = normalizeAssistantResponse(POST_CAPTURE_WARM_GOODBYE_TEXT, config);
          logClosingDecision(turnIndex, false, "silence");
          console.log(
            `[voice-assistant] soft intake closing turn_index=${turnIndex} post_completion_followup=close closing_policy=warm_goodbye soft_intake_state=${intakeStage(intakeOnSilence)}`
          );
          timings.responseGenerationMs = 0;
          const assistantAudio = await synthesizeAssistantResponse(config, ctx, turnIndex, closeText, timings);
          await playAssistantAudio(config, ctx, socket, playback, turnIndex, assistantAudio, timings);
          intakeOnSilence.closingPending = false;
          intakeOnSilence.finalGoodbyeSent = true;
          intakeOnSilence.waitingFor = null;
          state.history.push({ caller: "", assistant: closeText });
          turnsCompleted = turnIndex;
          timings.totalTurnMs = elapsedSince(turnStartedAt);
          finishReason = "human_warm_goodbye";
          console.log(
            `[voice-assistant] turn timings turn=${turnIndex} listen_duration_ms=${timings.listenDurationMs} speech_end_detected=${timings.speechEndDetected} audio_bytes_captured=${timings.audioBytesCaptured} transcription_ms=${timings.transcriptionMs} response_generation_ms=${timings.responseGenerationMs} tts_ms=${timings.ttsMs} playback_ms=${timings.playbackMs} total_turn_ms=${timings.totalTurnMs}`
          );
          break;
        }
        finishReason = "silence";
        if (config.assistant.endOnSilence) break;
        await persist.onTurnFailed(config, ctx, new Error("no caller audio captured during turn window"), {
          phase: "listen",
          turnIndex,
          timings
        });
        continue;
      }

      const callerAudio = await writeTurnCallerAudio(config, ctx, turnIndex, listened.pcm);
      const callerText = await transcribeTurn(config, ctx, turnIndex, callerAudio, timings);
      if (!callerText) {
        const intakeAfterTranscription = ensureIntakeState(state);
        if (intakeAfterTranscription.closingPending) {
          const closeText = normalizeAssistantResponse(POST_CAPTURE_WARM_GOODBYE_TEXT, config);
          logClosingDecision(turnIndex, false, "silence");
          console.log(
            `[voice-assistant] soft intake closing turn_index=${turnIndex} post_completion_followup=close closing_policy=warm_goodbye soft_intake_state=${intakeStage(intakeAfterTranscription)} transcript_rejected_reason=stt_prompt_leak`
          );
          timings.responseGenerationMs = 0;
          const assistantAudio = await synthesizeAssistantResponse(config, ctx, turnIndex, closeText, timings);
          await playAssistantAudio(config, ctx, socket, playback, turnIndex, assistantAudio, timings);
          intakeAfterTranscription.closingPending = false;
          intakeAfterTranscription.finalGoodbyeSent = true;
          intakeAfterTranscription.waitingFor = null;
          state.history.push({ caller: "", assistant: closeText });
          turnsCompleted = turnIndex;
          timings.totalTurnMs = elapsedSince(turnStartedAt);
          finishReason = "human_warm_goodbye";
          console.log(
            `[voice-assistant] turn timings turn=${turnIndex} listen_duration_ms=${timings.listenDurationMs} speech_end_detected=${timings.speechEndDetected} audio_bytes_captured=${timings.audioBytesCaptured} transcription_ms=${timings.transcriptionMs} response_generation_ms=${timings.responseGenerationMs} tts_ms=${timings.ttsMs} playback_ms=${timings.playbackMs} total_turn_ms=${timings.totalTurnMs}`
          );
          break;
        }
      }
      const analysis = analyzeCallerTranscript(callerText, minChars);
      const intake = ensureIntakeState(state);
      const product = ensureProductState(state);

      if (callerText && shouldWarmGoodbyeOnClearClose(callerText, intake)) {
        const closeText = normalizeAssistantResponse(POST_CAPTURE_WARM_GOODBYE_TEXT, config);
        logClosingDecision(turnIndex, false, "clear_close");
        console.log(
          `[voice-assistant] soft intake closing turn_index=${turnIndex} clear_close_detected=true closing_reason=clear_close soft_intake_state=${intakeStage(intake)} fallback_question_count=${Number(intake.businessFallbackQuestionCount || 0)}`
        );
        intake.closingPending = false;
        intake.finalGoodbyeSent = true;
        intake.waitingFor = null;
        product.productDialogueState = "completed";
        timings.responseGenerationMs = 0;
        const assistantAudio = await synthesizeAssistantResponse(config, ctx, turnIndex, closeText, timings);
        await playAssistantAudio(config, ctx, socket, playback, turnIndex, assistantAudio, timings);
        state.history.push({ caller: callerText, assistant: closeText });
        turnsCompleted = turnIndex;
        timings.totalTurnMs = elapsedSince(turnStartedAt);
        finishReason = "human_warm_goodbye";
        console.log(
          `[voice-assistant] turn timings turn=${turnIndex} listen_duration_ms=${timings.listenDurationMs} speech_end_detected=${timings.speechEndDetected} audio_bytes_captured=${timings.audioBytesCaptured} transcription_ms=${timings.transcriptionMs} response_generation_ms=${timings.responseGenerationMs} tts_ms=${timings.ttsMs} playback_ms=${timings.playbackMs} total_turn_ms=${timings.totalTurnMs}`
        );
        break;
      }

      const permissionFirst =
        intake.contactPermissionRequested &&
        intake.contactPermissionGranted === null &&
        intake.waitingFor === "permission";
      const awaitingSoftIntakeInput = isIntakeActive(intake);
      const awaitingProductInput = isProductFlowActive(product);
      const businessFallbackEligible = isBusinessFallbackEligible(intake, product);
      const businessFallbackMatch = Boolean(matchBusinessFallbackFromText(callerText));
      const usable =
        permissionFirst ||
        analysis.transcriptQuality === "clear" ||
        awaitingSoftIntakeInput ||
        awaitingProductInput ||
        isPostCompletionBusinessFallbackEligible(intake) ||
        (businessFallbackEligible && businessFallbackMatch) ||
        (isBusinessFallbackClosingContext(intake) &&
          (isClearCloseSignal(callerText) || isGoodbye(callerText)));

      if (!usable) {
        if (!state.clarificationAsked) {
          state.clarificationAsked = true;
          const assistantText = await createAndPlayClarification(
            config,
            ctx,
            socket,
            playback,
            turnIndex,
            timings,
            analysis
          );
          state.history.push({ caller: callerText, assistant: assistantText });
          turnsCompleted = turnIndex;
          timings.totalTurnMs = elapsedSince(turnStartedAt);
          console.log(
            `[voice-assistant] turn timings turn=${turnIndex} listen_duration_ms=${timings.listenDurationMs} speech_end_detected=${timings.speechEndDetected} audio_bytes_captured=${timings.audioBytesCaptured} transcription_ms=${timings.transcriptionMs} response_generation_ms=${timings.responseGenerationMs} tts_ms=${timings.ttsMs} playback_ms=${timings.playbackMs} total_turn_ms=${timings.totalTurnMs}`
          );
          continue;
        }

        finishReason = "unusable_input";
        break;
      }

      if (isGoodbye(callerText) && !intake.closingPending) {
        finishReason = "caller_goodbye";
        break;
      }

      const assistantResult = await createAssistantResponse(
        config,
        ctx,
        turnIndex,
        callerText,
        state.history,
        timings,
        analysis
      );
      const assistantText = assistantResult.text;
      const assistantAudio = await synthesizeAssistantResponse(config, ctx, turnIndex, assistantText, timings);
      await playAssistantAudio(config, ctx, socket, playback, turnIndex, assistantAudio, timings);

      state.history.push({ caller: callerText, assistant: assistantText });
      turnsCompleted = turnIndex;
      timings.totalTurnMs = elapsedSince(turnStartedAt);
      console.log(
        `[voice-assistant] turn timings turn=${turnIndex} listen_duration_ms=${timings.listenDurationMs} speech_end_detected=${timings.speechEndDetected} audio_bytes_captured=${timings.audioBytesCaptured} transcription_ms=${timings.transcriptionMs} response_generation_ms=${timings.responseGenerationMs} tts_ms=${timings.ttsMs} playback_ms=${timings.playbackMs} total_turn_ms=${timings.totalTurnMs}`
      );
      const intakeFinishReason = completedIntakeFinishReason(ensureIntakeState(state));
      if (intakeFinishReason) {
        finishReason = intakeFinishReason;
        break;
      }
    } catch (err) {
      timings.totalTurnMs = elapsedSince(turnStartedAt);
      await persist.onTurnFailed(config, ctx, new Error(makeSafeError(err)), {
        phase: "assistant",
        turnIndex,
        timings
      });
      finishReason = "turn_failed";
      if (!ctx.closed && socket.writable) {
        playback.startSilenceWriter(config, ctx, socket);
      }
      break;
    }
  }

  if (finishReason === "max_turns" && turnsCompleted >= effectiveMaxTurns && !ctx.closed && socket.writable) {
    const intake = ensureIntakeState(state);
    if (!needsSoftIntakeTurnProtection(intake)) {
      const lastAssistant = state.history.at(-1)?.assistant || "";
      const closeText = isIntakeActive(intake)
        ? intakeMaxTurnsCloseText(intake, config)
        : asksForCallback(lastAssistant)
          ? MAX_TURNS_WRAPUP_TEXT
          : MAX_TURNS_CALLBACK_TEXT;
      const closeTimings = {
        turnStartedAt: nowMs(),
        listenDurationMs: null,
        transcriptionMs: null,
        responseGenerationMs: 0,
        ttsMs: null,
        playbackMs: null,
        totalTurnMs: null
      };
      await createAndPlayMaxTurnsClose(
        config,
        ctx,
        socket,
        playback,
        turnsCompleted + 1,
        closeTimings,
        closeText,
        intakeMetadata(intake)
      );
    } else {
      console.log(
        `[voice-assistant] max turns close skipped while soft intake pending soft_intake_state=${intakeStage(intake)} soft_intake_max_turn_protected=${Boolean(intake.softIntakeMaxTurnProtected)}`
      );
    }
  }

  state.completed = true;
  await persist.onConversationFinished(config, ctx, {
    reason: finishReason,
    turnsCompleted
  });
  console.log(`[voice-assistant] conversation finished reason=${finishReason} turns_completed=${turnsCompleted}`);
}

export function createQaDialogueContext(overrides = {}) {
  const callerPhoneNormalized =
    overrides.callerPhoneNormalized !== undefined ? overrides.callerPhoneNormalized : "+491701234567";
  const callerPhoneRaw =
    overrides.callerPhoneRaw !== undefined ? overrides.callerPhoneRaw : "+49 170 1234567";
  return {
    qaMode: true,
    bridgeCallId: overrides.bridgeCallId || "qa-text-harness",
    externalCallId: overrides.externalCallId || "qa:text-harness",
    assistantTurn: null,
    ...overrides,
    callerPhoneNormalized,
    callerPhoneRaw
  };
}

function cloneDialogueSnapshot(ctx) {
  const state = turnState(ctx);
  return {
    intake: structuredClone(state.intake),
    product: structuredClone(state.product),
    clarificationAsked: Boolean(state.clarificationAsked),
    unknownIntentCount: Number(state.unknownIntentCount || 0),
    history: structuredClone(state.history)
  };
}

function buildQaTurnMetadata({
  text,
  analysis,
  metadata,
  closingReason = null,
  clearCloseDetected = false,
  finishReason = null
}) {
  const merged = {
    ...(metadata || {}),
    responseText: text,
    transcriptQuality: analysis?.transcriptQuality ?? metadata?.transcriptQuality ?? "clear",
    closing_reason: closingReason ?? metadata?.closing_reason ?? null,
    clear_close_detected: clearCloseDetected,
    finish_reason: finishReason
  };
  return merged;
}

export async function processTextTurn({
  state,
  transcript,
  config,
  turnIndex = null,
  qaMode = true
}) {
  const ctx = state?.ctx || state;
  ctx.qaMode = qaMode !== false;
  const assistantState = turnState(ctx);
  const minChars = Math.max(1, Number(config?.assistant?.minTranscriptChars ?? 5));
  const callerText = String(transcript ?? "").trim();
  const turnIndexNum = Number(turnIndex ?? assistantState.currentTurnIndex + 1);
  assistantState.currentTurnIndex = turnIndexNum;

  const timings = { responseGenerationMs: 0 };
  const intake = ensureIntakeState(assistantState);
  const product = ensureProductState(assistantState);
  const analysis = analyzeCallerTranscript(callerText, minChars);

  if (callerText && shouldWarmGoodbyeOnClearClose(callerText, intake)) {
    const closeText = normalizeAssistantResponse(POST_CAPTURE_WARM_GOODBYE_TEXT, config);
    logClosingDecision(turnIndexNum, false, "clear_close");
    intake.closingPending = false;
    intake.finalGoodbyeSent = true;
    intake.waitingFor = null;
    product.productDialogueState = "completed";
    const currentIntake = intakeMetadata(intake);
    const currentProduct = productMetadata(product);
    const metadata = buildQaTurnMetadata({
      text: closeText,
      analysis,
      metadata: {
        normalizedIntent: "post_capture_warm_goodbye",
        product_intake_product: currentProduct.productIntakeProduct ?? currentProduct.productInterest ?? null,
        product_intake_stage: currentProduct.productIntakeStage ?? "idle",
        handoff_choice: currentProduct.handoffChoice ?? "none",
        soft_intake_state: currentIntake.softIntakeState ?? "not_started",
        product_flow_state: currentProduct.productFlowState ?? "not_started",
        business_fallback_intent: "none",
        business_fallback_source: "none",
        business_fallback_guidance: "none",
        business_fallback_next_step: "none",
        final_response_template: "warm_goodbye",
        used_template_response: true,
        used_llm_response: false,
        permission_context_match: intake.permissionDetectionSource || "none"
      },
      closingReason: "clear_close",
      clearCloseDetected: true,
      finishReason: "human_warm_goodbye"
    });
    assistantState.history.push({ caller: callerText, assistant: closeText });
    return {
      responseText: closeText,
      nextState: cloneDialogueSnapshot(ctx),
      normalizedIntent: metadata.normalizedIntent,
      transcriptQuality: analysis.transcriptQuality,
      metadata
    };
  }

  const permissionFirst =
    intake.contactPermissionRequested &&
    intake.contactPermissionGranted === null &&
    intake.waitingFor === "permission";
  const awaitingSoftIntakeInput = isIntakeActive(intake);
  const awaitingProductInput = isProductFlowActive(product);
  const businessFallbackEligible = isBusinessFallbackEligible(intake, product);
  const businessFallbackMatch = Boolean(matchBusinessFallbackFromText(callerText));
  const usable =
    permissionFirst ||
    analysis.transcriptQuality === "clear" ||
    awaitingSoftIntakeInput ||
    awaitingProductInput ||
    isPostCompletionBusinessFallbackEligible(intake) ||
    (businessFallbackEligible && businessFallbackMatch) ||
    (isBusinessFallbackClosingContext(intake) && (isClearCloseSignal(callerText) || isGoodbye(callerText)));

  if (!usable) {
    if (!assistantState.clarificationAsked) {
      assistantState.clarificationAsked = true;
      const clarificationText = clarificationForQuality(analysis.transcriptQuality);
      const currentIntake = intakeMetadata(intake);
      const currentProduct = productMetadata(product);
      const metadata = buildQaTurnMetadata({
        text: clarificationText,
        analysis,
        metadata: {
          normalizedIntent: analysis.normalizedIntent,
          product_intake_product: currentProduct.productIntakeProduct ?? null,
          product_intake_stage: currentProduct.productIntakeStage ?? "idle",
          handoff_choice: currentProduct.handoffChoice ?? "none",
          soft_intake_state: currentIntake.softIntakeState ?? "not_started",
          product_flow_state: currentProduct.productFlowState ?? "not_started",
          business_fallback_intent: "none",
          business_fallback_source: "none",
          business_fallback_guidance: "none",
          business_fallback_next_step: "none",
          final_response_template: "clarification",
          used_template_response: true,
          used_llm_response: false,
          permission_context_match: intake.permissionDetectionSource || "none"
        },
        closingReason: null,
        clearCloseDetected: false
      });
      assistantState.history.push({ caller: callerText, assistant: clarificationText });
      return {
        responseText: clarificationText,
        nextState: cloneDialogueSnapshot(ctx),
        normalizedIntent: analysis.normalizedIntent,
        transcriptQuality: analysis.transcriptQuality,
        metadata
      };
    }

    const currentIntake = intakeMetadata(intake);
    const currentProduct = productMetadata(product);
    const metadata = buildQaTurnMetadata({
      text: "",
      analysis,
      metadata: {
        normalizedIntent: analysis.normalizedIntent,
        product_intake_product: currentProduct.productIntakeProduct ?? null,
        product_intake_stage: currentProduct.productIntakeStage ?? "idle",
        handoff_choice: currentProduct.handoffChoice ?? "none",
        soft_intake_state: currentIntake.softIntakeState ?? "not_started",
        product_flow_state: currentProduct.productFlowState ?? "not_started",
        business_fallback_intent: "none",
        business_fallback_source: "none",
        business_fallback_guidance: "none",
        business_fallback_next_step: "none",
        final_response_template: "unusable_input",
        used_template_response: false,
        used_llm_response: false,
        permission_context_match: intake.permissionDetectionSource || "none"
      },
      finishReason: "unusable_input"
    });
    return {
      responseText: "",
      nextState: cloneDialogueSnapshot(ctx),
      normalizedIntent: analysis.normalizedIntent,
      transcriptQuality: analysis.transcriptQuality,
      metadata
    };
  }

  const result = await createAssistantResponse(
    config,
    ctx,
    turnIndexNum,
    callerText,
    assistantState.history,
    timings,
    analysis
  );
  assistantState.history.push({ caller: callerText, assistant: result.text });
  const metadata = buildQaTurnMetadata({
    text: result.text,
    analysis,
    metadata: result.metadata
  });
  return {
    responseText: result.text,
    nextState: cloneDialogueSnapshot(ctx),
    normalizedIntent: metadata.normalizedIntent,
    transcriptQuality: analysis.transcriptQuality,
    metadata
  };
}

export function startOneTurnAssistant(config, ctx, socket, playback) {
  if (!config.assistant?.enabled) return;
  if (ctx.assistantTurn?.started) return;

  const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) {
    void persist.onTurnFailed(
      config,
      ctx,
      new Error("OPENAI_API_KEY is required when VOICE_ASSISTANT_ENABLED=true"),
      {
        phase: "config",
        turnIndex: 1
      }
    );
    return;
  }

  const state = turnState(ctx);
  state.started = true;
  state.completed = false;
  state.history = [];
  state.clarificationAsked = false;
  state.unknownIntentCount = 0;
  state.intake = createIntakeState();
  state.product = createProductState();

  void runAssistantConversation(config, ctx, socket, playback).catch((err) => {
    void persist.onTurnFailed(config, ctx, new Error(makeSafeError(err)), {
      phase: "conversation",
      turnIndex: state.currentTurnIndex || 1
    });
  });
}
