/**
 * Phase 10E — deterministic voice-capture restriction / contact-form handoff intents.
 */

import { normalizeText } from "./redaction.js";
import { isCallbackLeadCaptureRequest } from "./role-boundary-intent.js";

export const CONTACT_FORM_HANDOFF_INTENTS = Object.freeze({
  EMAIL_OFFER_BY_VOICE: "email_offer_by_voice",
  WEBSITE_URL_OFFER_BY_VOICE: "website_url_offer_by_voice",
  COMPANY_NAME_OFFER_BY_VOICE: "company_name_offer_by_voice",
  CONTACT_FORM_HANDOFF_NEEDED: "contact_form_handoff_needed",
});

const EMAIL_OFFER_PATTERNS = [
  /\bsoll ich\b.*\b(e-?mail|email)\b.*\b(durchgeben|vorlesen|mitteilen|nennen|adresse)\b/i,
  /\b(e-?mail|email)[\s-]*(adresse)?\b.*\b(durchgeben|vorlesen|mitteilen|nennen)\b/i,
  /\b(durchgeben|vorlesen|mitteilen|nennen)\b.*\b(e-?mail|email)[\s-]*(adresse)?\b/i,
  /\bmeine\s+(e-?mail|email)[\s-]*(adresse)?\b/i,
];

const WEBSITE_OFFER_PATTERNS = [
  /\b(website|webseite|domain|url)[\s-]*(adresse)?\b.*\b(vorlesen|durchgeben|mitteilen|nennen)\b/i,
  /\b(vorlesen|durchgeben|mitteilen|nennen)\b.*\b(website|webseite|domain|url)\b/i,
  /\bwebsite[\s-]*adresse\b/i,
];

const COMPANY_NAME_OFFER_PATTERNS = [
  /\bfirmen\s*name\b.*\b(durchgeben|nennen|mitteilen|vorlesen)\b/i,
  /\b(unternehmen|firma)\s+hei[sß]t\b/i,
  /\bfirmennamen\b/i,
];

const COMPLEX_DETAILS_OFFER_PATTERNS = [
  /\b(keywords?|schl[uü]sselw[oö]rter|wettbewerber|projekt\s*details?)\b.*\b(durch|durchgeben)\b/i,
  /\b(durchgeben|durch)\b.*\b(keywords?|schl[uü]sselw[oö]rter|wettbewerber|details?|infos?)\b/i,
  /\b(gebe|geben)\s+ihnen\b.*\b(website|e-?mail|email)\b/i,
  /\b(website|webseite)\s+und\s+(e-?mail|email|weitere)\b/i,
  /\b(lange|ausf[uü]hrliche|detaillierte|weitere)\s+(projekt|details?|infos?)\b/i,
  /\bdirekt\s+durchgeben\b/i,
  /\bwebsite\b.*\b(durchgeben|durch)\b/i,
];

function matchesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

export function isEmailOfferByVoice(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  return matchesAny(EMAIL_OFFER_PATTERNS, lower);
}

export function isWebsiteUrlOfferByVoice(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  return matchesAny(WEBSITE_OFFER_PATTERNS, lower);
}

export function isCompanyNameOfferByVoice(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  return matchesAny(COMPANY_NAME_OFFER_PATTERNS, lower);
}

export function isContactFormHandoffNeeded(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return false;
  return matchesAny(COMPLEX_DETAILS_OFFER_PATTERNS, lower);
}

/**
 * Returns a contact-form handoff intent or null. Never matches explicit callback requests.
 */
export function detectContactFormHandoffIntent(transcript = "") {
  const lower = normalizeText(transcript).toLowerCase();
  if (!lower) return null;
  if (isCallbackLeadCaptureRequest(transcript)) return null;

  if (isEmailOfferByVoice(transcript)) {
    return CONTACT_FORM_HANDOFF_INTENTS.EMAIL_OFFER_BY_VOICE;
  }
  if (isWebsiteUrlOfferByVoice(transcript)) {
    return CONTACT_FORM_HANDOFF_INTENTS.WEBSITE_URL_OFFER_BY_VOICE;
  }
  if (isCompanyNameOfferByVoice(transcript)) {
    return CONTACT_FORM_HANDOFF_INTENTS.COMPANY_NAME_OFFER_BY_VOICE;
  }
  if (isContactFormHandoffNeeded(transcript)) {
    return CONTACT_FORM_HANDOFF_INTENTS.CONTACT_FORM_HANDOFF_NEEDED;
  }
  return null;
}

export function isContactFormHandoffIntent(intent = "") {
  return Object.values(CONTACT_FORM_HANDOFF_INTENTS).includes(intent);
}
