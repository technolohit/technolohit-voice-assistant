/**
 * Shared v4 transcript intent + response sanitization (no planner/RAG coupling).
 */

import { normalizeText } from "./redaction.js";
import { matchProductAlias } from "./agent-config.js";
import { isGenericScopedProductQuestion } from "./product-context-persistence.js";
import { CLOSING_RESPONSE_TEXT } from "./closing-intent.js";
import { isClosingIntentForPolicy } from "./behavior-policy.js";
import {
  isOutOfScopeGeneralQuestion,
  isTechnicalEscalationQuestion,
  isCallbackLeadCaptureRequest,
} from "./role-boundary-intent.js";
import {
  isCallbackFlowActive,
  isCallbackFlowAttentionPhrase,
  isCallbackPermissionPendingStage,
  isPhoneNumberPendingStage,
  isPostDecisionCallbackStage,
} from "./callback-flow-policy.js";
import {
  evaluateSpokenPhoneCapture,
  isPhoneCaptureRefusal,
} from "./spoken-phone-capture.js";
import {
  isPhoneCaptureLocked,
  resolvePhoneCaptureTranscriptIntent,
} from "./phone-capture-policy.js";
import { detectContactFormHandoffIntent } from "./contact-form-handoff-intent.js";
import { isCompanyGeneralQuestion } from "./company-general-intent.js";

const NO_RUECKRUF = /\b(rückruf|rueckruf|ruckruf|zurückrufen|zurueckrufen|zuruckrufen)\b/i;

export function sanitizeResponseText(text) {
  const base = normalizeText(text);
  if (!base) return "";
  if (NO_RUECKRUF.test(base)) {
    return base
      .replace(/\beinen?\s+(?:r[üu]ckruf|rueckruf|ruckruf)\b/gi, "eine Kontaktaufnahme")
      .replace(/\b(?:r[üu]ckruf|rueckruf|ruckruf)\b/gi, "Kontaktaufnahme")
      .replace(/\b(?:zur[üu]ckrufen|zurueckrufen|zuruckrufen)\b/gi, "Kontakt aufnehmen");
  }
  return base;
}

const INTERRUPTION_FOLLOW_UP_PATTERNS = [
  /\b(stopp|stop)\b.*\b(kurze frage|noch eine frage)\b/i,
  /\b(kurze frage|noch eine frage|darf ich kurz fragen)\b/i,
  /\bich habe noch eine frage\b/i,
  /\bich habe eine frage\b/i
];

const TOPIC_REPAIR =
  /\b(warte|moment|nein)[,.]?\s*(ich )?(meine|meinte)|\b(stopp|stop)[,.]?\s*(ich )?(meine|meinte)\b/i;

const TOPIC_RESET_EXPLICIT =
  /\b(neues thema|anderes produkt|falsch|nicht das|vergiss das)\b/i;

const DEFINITE_GOODBYE =
  /\b(auf wiederh[oö]ren|auf wiedersehen|wiederh[oö]ren|wiedersehen|bis dann|nein danke|danke[, ]+das war alles|das war alles|das war'?s|das wars|keine frage mehr|tsch[uü]ss|tschuess|sch[oö]nen tag)\b/i;

// Phase 10AT: callback permission continuation. "Ja", "ja gerne", "okay",
// "einverstanden" after the permission question must grant permission instead
// of falling back to scoped product QA; a refusal must end the callback flow.
const CALLBACK_PERMISSION_AFFIRMATIVE =
  /\b(ja|okay|ok|einverstanden|gerne|in ordnung|klar)\b/i;
const CALLBACK_PERMISSION_REFUSAL =
  /\b(nein|lieber nicht|bitte nicht|kein anruf|keinen anruf|nicht anrufen|keinen r[üu]ckruf)\b/i;
const PRODUCT_QUESTION_HINT =
  /\b(was ist|was sind|was macht|was bedeutet|wie funktioniert|preis|kosten|was kostet|wie viel|tarif|geb[uü]hr)\b/i;

/** True while a callback/contact permission answer is still expected. */
export function isCallbackPermissionPending(memory = {}) {
  if (memory?.current_state === "collecting_callback_permission" && !memory?.callback_permission) {
    return true;
  }
  return isCallbackPermissionPendingStage(memory);
}

export function isInterruptionFollowUpPhrase(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  return INTERRUPTION_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(lower));
}

export function isTopicRepairPhrase(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  return TOPIC_REPAIR.test(lower);
}

export function isExplicitTopicResetPhrase(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  return TOPIC_RESET_EXPLICIT.test(lower);
}

export function isDefiniteCallerGoodbye(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  if (DEFINITE_GOODBYE.test(lower)) return true;
  if (/^danke[.!]?$/.test(lower.trim())) return true;
  return false;
}

export function getWarmGoodbyeResponseText() {
  return CLOSING_RESPONSE_TEXT;
}

export function detectTranscriptIntent(
  transcript = "",
  memory = {},
  agentConfig = null,
  behaviorPolicy = null,
  contactFormHandoffEnabled = false,
  playbookProductContentEnabled = false
) {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return "empty";

  // Phase 10AK: closing / stop intent has highest priority (Conversation
  // Priority Contract #1) and overrides interrupt follow-up, product
  // continuation, lead capture, and fallback clarification.
  // Phase 10AN: an opt-in playbook policy may extend (never replace) the
  // hardcoded closing phrase set; with no policy this is identical to 10AK.
  if (isClosingIntentForPolicy(transcript, behaviorPolicy) || memory?.call_closing) {
    return "closing";
  }

  const collectingContactPreference =
    memory?.current_state === "collecting_contact_preference" ||
    memory?.current_state === "collecting_phone_number" ||
    memory?.current_state === "collecting_callback_permission" ||
    Boolean(memory?.contact_flow_pending) ||
    isCallbackFlowActive(memory);

  // Phase 10AU: once the callback/contact decision is made (finalized, manual
  // review, e-mail directed), attention/recovery phrases ("Hallo?", "Sind Sie
  // noch da?", bare "Ja."/"Okay.") and repeated callback requests stay inside
  // the flow as reassurance — never product continuation, never a flow restart.
  if (
    isPostDecisionCallbackStage(memory) &&
    !PRODUCT_QUESTION_HINT.test(lower) &&
    (isCallbackFlowAttentionPhrase(transcript) || isCallbackLeadCaptureRequest(transcript))
  ) {
    return "callback_flow_attention";
  }

  // Conversation Priority Contract #3 / Phase 10F: explicit callback/contact
  // requests beat role boundary, contact-form handoff, and company-general.
  if (!collectingContactPreference && isCallbackLeadCaptureRequest(transcript)) {
    return "callback_request";
  }

  // Phase 10AP: safety / role boundary (#3) before product Q&A and lead capture.
  if (isOutOfScopeGeneralQuestion(transcript, agentConfig)) {
    return "out_of_scope";
  }
  if (isTechnicalEscalationQuestion(transcript, agentConfig)) {
    return "technical_escalation";
  }

  if (contactFormHandoffEnabled) {
    const handoffIntent = detectContactFormHandoffIntent(transcript);
    if (handoffIntent) return handoffIntent;
  }

  // Phase 10F: during active callback/contact flow, company-general phrases
  // must not escape the flow (no product-style override for company-general).
  if (
    collectingContactPreference &&
    playbookProductContentEnabled &&
    isCompanyGeneralQuestion(transcript) &&
    !isCallbackLeadCaptureRequest(transcript)
  ) {
    return "callback_flow_attention";
  }

  // Phase 10F: company-general only on company-only turns (no callback request).
  if (
    playbookProductContentEnabled &&
    !collectingContactPreference &&
    !isCallbackLeadCaptureRequest(transcript) &&
    isCompanyGeneralQuestion(transcript)
  ) {
    return "company_general";
  }

  // Phase 12J: locked phone-capture sub-state outranks product QA, RAG,
  // interruption recovery, and fallback clarification until capture completes.
  if (isPhoneCaptureLocked(memory)) {
    if (contactFormHandoffEnabled) {
      const handoffIntent = detectContactFormHandoffIntent(transcript);
      if (handoffIntent) return handoffIntent;
    }
    return resolvePhoneCaptureTranscriptIntent(transcript, memory);
  }

  // Phase 10AT: while the callback permission question is open, a short
  // affirmative/refusal answers the permission question — it must not fall
  // through to scoped product QA. A new product question still wins so the
  // caller can change topic explicitly.
  if (
    isCallbackPermissionPending(memory) &&
    !PRODUCT_QUESTION_HINT.test(lower) &&
    !isTopicRepairPhrase(transcript)
  ) {
    if (
      CALLBACK_PERMISSION_REFUSAL.test(lower) &&
      !CALLBACK_PERMISSION_AFFIRMATIVE.test(lower)
    ) {
      return "callback_permission_denied";
    }
    if (CALLBACK_PERMISSION_AFFIRMATIVE.test(lower)) {
      return "callback_permission_granted";
    }
  }

  const inInterruption = Boolean(memory?.interruption_context);

  if (agentConfig && isTopicRepairPhrase(transcript)) {
    const product = matchProductAlias(agentConfig, transcript);
    if (product?.id) return "product_selection";
    return "topic_repair";
  }

  if (inInterruption || isInterruptionFollowUpPhrase(transcript)) {
    if (isInterruptionFollowUpPhrase(transcript)) return "interruption_followup";
    if (isTopicRepairPhrase(transcript)) return "topic_repair";
  }

  if (/\b(stopp|stop)\b/i.test(lower) && !isInterruptionFollowUpPhrase(transcript)) {
    return "interruption_recovery";
  }

  if (/\b(was ist|was sind|was macht|was bedeutet|erklar|erklaer|wie funktioniert|mehr uber|mehr ueber)\b/i.test(lower)) {
    return "product_question";
  }
  if (/\b(preis|kosten|was kostet|wie viel|pricing|tarif|gebühr|gebuehr)\b/i.test(lower)) {
    return "product_question";
  }
  if (/\b(termin|termine|buchung|kann das auch)\b/i.test(lower)) {
    return "product_question";
  }
  if (/\b(smart website|digitale rezeption|voice agent|lokalki|botinteg|aiseoq)\b/i.test(lower)) {
    return "product_selection";
  }
  // Closed-domain product aliases are authoritative even when STT inserts
  // punctuation or inflects the product phrase (for example Smart-Webseite).
  if (agentConfig && matchProductAlias(agentConfig, transcript)?.id) {
    return "product_selection";
  }
  if (/\b(neukunde|neu kunde|bestandskunde|eigene firma|unternehmen)\b/i.test(lower)) {
    return "sales_customer_type";
  }
  if (/\b(e-?mail|email|per mail)\b/i.test(lower)) return "contact_email";
  if (/\b(telefon|telefonisch|anruf|anrufen)\b/i.test(lower)) return "contact_phone";
  if (isCallbackLeadCaptureRequest(transcript)) return "callback_request";
  if (CALLBACK_PERMISSION_AFFIRMATIVE.test(lower) && memory?.contact_preference) {
    return "callback_permission_granted";
  }
  if (memory?.selected_product_id && isGenericScopedProductQuestion(transcript)) {
    return "product_question";
  }
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
