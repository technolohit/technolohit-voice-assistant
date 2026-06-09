/**
 * Phase 10AN — guarded v4 behavior policy resolver (playbook runtime increment 1).
 *
 * Scope: only the safest repeated behavior — closing phrases, closing response,
 * fallback clarification response, out-of-scope redirect, technical escalation
 * response. Everything else (lead capture, pricing, products, RAG, state
 * machine) stays code/agent_config driven.
 *
 * Guarantees:
 * - Opt-in and default-off: with VOICE_V4_PLAYBOOK_RUNTIME_ENABLED unset/false
 *   the resolver returns the hardcoded Phase 10AK values and never touches the
 *   playbook file.
 * - Fail closed: missing/invalid/not-approved/not-runtime-active playbooks fall
 *   back to the hardcoded defaults; calls never crash on playbook problems.
 * - Draft playbooks are rejected unless the explicit draft override
 *   (VOICE_V4_PLAYBOOK_ALLOW_DRAFT or an explicit allowDraft argument) is set.
 * - Policy objects carry only behavior wording and safe metadata (source,
 *   reason, playbook_version) — no transcripts, phone numbers, emails, secrets.
 */

import { normalizeText } from "./redaction.js";
import { CLOSING_RESPONSE_TEXT, isClosingIntent } from "./closing-intent.js";
import { loadTenantPlaybookFromPath, resolvePlaybookPath } from "./playbook-loader.js";

/** Hardcoded Phase 10AK / blueprint contract values (runtime defaults). */
export const HARDCODED_BEHAVIOR_DEFAULTS = Object.freeze({
  closing_response: CLOSING_RESPONSE_TEXT,
  fallback_clarification_response:
    "Entschuldigung, das habe ich nicht ganz verstanden. Können Sie das bitte kurz wiederholen?",
  out_of_scope_redirect:
    "Dazu kann ich Ihnen als TechnoloHit Assistent keine verlässliche Beratung geben. Ich helfe Ihnen aber gerne bei Fragen zu unseren KI-Lösungen, Smart Website, AI Voice Agent oder LokalKI.",
  technical_escalation_response:
    "Das möchte ich Ihnen nicht falsch beantworten. Ich kann Ihre Frage aber gerne aufnehmen, damit unser Team das prüft und sich gezielt bei Ihnen zurückmeldet.",
  callback_lead_capture_response:
    "Ich kann die Anfrage gerne aufnehmen, damit sich unser Team das anschaut und sich bei Ihnen zurückmeldet. Möchten Sie telefonisch oder per E-Mail starten?"
});

function hardcodedPolicy(reason) {
  return {
    source: "hardcoded_default",
    reason,
    playbook_version: null,
    closing_phrases: null,
    ...HARDCODED_BEHAVIOR_DEFAULTS
  };
}

/**
 * A playbook may drive runtime behavior only when it is published, approved
 * for runtime, and has an active runtime binding — or when the explicit draft
 * override is set (tests/canary only). Draft playbooks are never silently
 * treated as production-active.
 */
export function isPlaybookRuntimeEligible(playbook, { allowDraft = false } = {}) {
  if (!playbook || typeof playbook !== "object") {
    return { ok: false, reason: "playbook_missing" };
  }
  if (playbook.status === "draft") {
    if (!allowDraft) return { ok: false, reason: "draft_playbook_not_allowed" };
    return { ok: true, reason: "draft_override" };
  }
  if (playbook.status !== "published") {
    return { ok: false, reason: "playbook_status_not_runtime_eligible" };
  }
  if (playbook.approval?.approved_for_runtime !== true) {
    return { ok: false, reason: "playbook_not_approved_for_runtime" };
  }
  if (playbook.runtime_binding?.active !== true) {
    return { ok: false, reason: "playbook_runtime_binding_inactive" };
  }
  return { ok: true, reason: "published_approved_active" };
}

export function resolveBehaviorPolicy({ config = null, playbook = null, allowDraft = null } = {}) {
  if (!config?.v4?.playbookRuntimeEnabled) {
    return hardcodedPolicy("playbook_runtime_disabled");
  }

  const draftAllowed =
    allowDraft ?? Boolean(config?.v4?.playbookAllowDraft);

  let candidate = playbook;
  if (!candidate) {
    const configuredPath = String(config?.v4?.playbookPath ?? "").trim();
    const loadResult = loadTenantPlaybookFromPath(
      configuredPath || resolvePlaybookPath()
    );
    if (!loadResult.ok) {
      return hardcodedPolicy(loadResult.error ?? "playbook_load_failed");
    }
    candidate = loadResult.playbook;
  }

  const eligibility = isPlaybookRuntimeEligible(candidate, { allowDraft: draftAllowed });
  if (!eligibility.ok) {
    return hardcodedPolicy(eligibility.reason);
  }

  const phrases = Array.isArray(candidate.closing_policy?.phrases)
    ? candidate.closing_policy.phrases.filter((phrase) => normalizeText(phrase))
    : [];

  return {
    source: "playbook",
    reason: eligibility.reason,
    playbook_version: candidate.playbook_version ?? null,
    closing_phrases: phrases.length ? phrases : null,
    closing_response:
      candidate.closing_policy?.response || HARDCODED_BEHAVIOR_DEFAULTS.closing_response,
    fallback_clarification_response:
      candidate.fallback_policy?.response ||
      HARDCODED_BEHAVIOR_DEFAULTS.fallback_clarification_response,
    out_of_scope_redirect:
      candidate.escalation_policy?.out_of_scope_redirect ||
      HARDCODED_BEHAVIOR_DEFAULTS.out_of_scope_redirect,
    technical_escalation_response:
      candidate.escalation_policy?.uncertain_or_technical ||
      HARDCODED_BEHAVIOR_DEFAULTS.technical_escalation_response,
    callback_lead_capture_response:
      candidate.lead_capture_policy?.preferred_wording
        ? `${candidate.lead_capture_policy.preferred_wording} Möchten Sie telefonisch oder per E-Mail starten?`
        : HARDCODED_BEHAVIOR_DEFAULTS.callback_lead_capture_response,
  };
}

export function getClosingPhrases(policy = null) {
  return policy?.closing_phrases ?? null;
}

export function getClosingResponse(policy = null) {
  return policy?.closing_response ?? HARDCODED_BEHAVIOR_DEFAULTS.closing_response;
}

export function getFallbackClarificationResponse(policy = null) {
  return (
    policy?.fallback_clarification_response ??
    HARDCODED_BEHAVIOR_DEFAULTS.fallback_clarification_response
  );
}

export function getOutOfScopeRedirect(policy = null) {
  return policy?.out_of_scope_redirect ?? HARDCODED_BEHAVIOR_DEFAULTS.out_of_scope_redirect;
}

export function getTechnicalEscalationResponse(policy = null) {
  return (
    policy?.technical_escalation_response ??
    HARDCODED_BEHAVIOR_DEFAULTS.technical_escalation_response
  );
}

export function getCallbackLeadCaptureResponse(policy = null) {
  return (
    policy?.callback_lead_capture_response ??
    HARDCODED_BEHAVIOR_DEFAULTS.callback_lead_capture_response
  );
}

function normalizeClosingPhrase(text = "") {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, "")
    .trim();
}

/**
 * Policy-aware closing detection. The hardcoded Phase 10AK detection always
 * applies; playbook phrases (when the policy is playbook-sourced) extend it
 * with exact normalized phrase matches. Bare "Stopp" is never in the playbook
 * phrase list, so barge-in/interruption behavior is unaffected.
 */
export function isClosingIntentForPolicy(transcript = "", policy = null) {
  if (isClosingIntent(transcript)) return true;
  const phrases = getClosingPhrases(policy);
  if (!phrases || policy?.source !== "playbook") return false;
  const normalized = normalizeClosingPhrase(transcript);
  if (!normalized) return false;
  return phrases.some((phrase) => normalizeClosingPhrase(phrase) === normalized);
}
