/**
 * Phase 10E — contact form handoff responses (playbook-aware, fail-closed fallback).
 */

import { loadTenantPlaybook, DEFAULT_PLAYBOOK_FILENAME } from "./playbook-loader.js";
import { CONTACT_FORM_HANDOFF_INTENTS } from "./contact-form-handoff-intent.js";

export const DEFAULT_CONTACT_FORM_HANDOFF_PHRASE =
  "Solche Details geben Sie am besten über unser Kontaktformular ein. Dort können Sie E-Mail, Website und weitere Infos sauber eintragen. Ich kann hier gern kurz aufnehmen, worum es grundsätzlich geht.";

let cachedPlaybook = undefined;

export function resetContactFormHandoffPlaybookCache() {
  cachedPlaybook = undefined;
}

function loadPlaybookForHandoff(playbook = undefined) {
  if (playbook !== undefined) return playbook;
  if (cachedPlaybook !== undefined) return cachedPlaybook;
  const loaded = loadTenantPlaybook(DEFAULT_PLAYBOOK_FILENAME);
  cachedPlaybook = loaded.ok ? loaded.playbook : null;
  return cachedPlaybook;
}

export function isContactFormHandoffRuntimeEnabled(config = null, v4PathActive = false) {
  return Boolean(v4PathActive && config?.v4?.contactFormHandoffEnabled);
}

function phraseFromPlaybook(playbook, intent) {
  const capture = playbook?.contact_capture_policy ?? {};
  if (intent === CONTACT_FORM_HANDOFF_INTENTS.EMAIL_OFFER_BY_VOICE) {
    return capture.email_redirect_phrase ?? capture.contact_form_handoff?.phrase ?? null;
  }
  if (
    intent === CONTACT_FORM_HANDOFF_INTENTS.WEBSITE_URL_OFFER_BY_VOICE ||
    intent === CONTACT_FORM_HANDOFF_INTENTS.COMPANY_NAME_OFFER_BY_VOICE
  ) {
    return capture.website_or_company_redirect_phrase ?? capture.contact_form_handoff?.phrase ?? null;
  }
  return capture.contact_form_handoff?.phrase ?? null;
}

export function getContactFormHandoffResponse({
  intent = CONTACT_FORM_HANDOFF_INTENTS.CONTACT_FORM_HANDOFF_NEEDED,
  playbook = undefined,
} = {}) {
  const resolvedPlaybook = loadPlaybookForHandoff(playbook);
  const fromPlaybook = phraseFromPlaybook(resolvedPlaybook, intent);
  if (typeof fromPlaybook === "string" && fromPlaybook.trim()) {
    return fromPlaybook.trim();
  }
  return DEFAULT_CONTACT_FORM_HANDOFF_PHRASE;
}
