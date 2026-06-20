/**
 * Phase 10G — caller-ID callback phrases from playbook or safe defaults.
 */

import { loadPlaybookForProductContent } from "./playbook-product-content.js";

export const DEFAULT_CALLER_ID_AVAILABLE_PHRASE =
  "Darf unser Team Sie unter Ihrer Nummer zurückmelden?";

export const DEFAULT_CALLER_ID_MISSING_PHRASE =
  "Unter welcher Telefonnummer kann unser Team Sie am besten erreichen?";

export const DEFAULT_PHONE_CAPTURE_FAILURE_PHRASE =
  "Vielen Dank. Für eine telefonische Rückmeldung ist es am besten, wenn Sie Ihre Anfrage über unser Kontaktformular auf www.technolohit.com senden. Unser Team prüft das dann gezielt.";

const DEFAULT_MAX_PHONE_ASKS = 1;

export function resolveCallerIdCallbackPhrases({
  config = null,
  behaviorPolicy = null,
  playbook = null,
} = {}) {
  const defaults = {
    availablePhrase: DEFAULT_CALLER_ID_AVAILABLE_PHRASE,
    missingPhrase: DEFAULT_CALLER_ID_MISSING_PHRASE,
    failurePhrase: DEFAULT_PHONE_CAPTURE_FAILURE_PHRASE,
    maxPhoneAsks: DEFAULT_MAX_PHONE_ASKS,
    source: "hardcoded_default",
  };

  const activePlaybook = loadPlaybookForProductContent({ config, behaviorPolicy, playbook });
  if (!activePlaybook) return defaults;

  const policy = activePlaybook.contact_capture_policy?.caller_id_policy ?? {};
  const handoff = activePlaybook.contact_capture_policy?.contact_form_handoff?.phrase ?? null;

  return {
    availablePhrase:
      (typeof policy.caller_id_available_phrase === "string" &&
        policy.caller_id_available_phrase.trim()) ||
      defaults.availablePhrase,
    missingPhrase:
      (typeof policy.caller_id_missing_phrase === "string" &&
        policy.caller_id_missing_phrase.trim()) ||
      defaults.missingPhrase,
    failurePhrase:
      (typeof handoff === "string" && handoff.trim()) ||
      (typeof activePlaybook.contact_capture_policy?.email_redirect_phrase === "string" &&
        activePlaybook.contact_capture_policy.email_redirect_phrase.trim()) ||
      defaults.failurePhrase,
    maxPhoneAsks: Number(policy.max_phone_asks) > 0 ? Number(policy.max_phone_asks) : DEFAULT_MAX_PHONE_ASKS,
    source: "playbook",
  };
}
