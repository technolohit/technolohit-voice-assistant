/**
 * Phase 10AQ — deterministic playbook questionnaire / lead-intake generator (non-live).
 *
 * Produces ordered, phone-friendly project-context questions from playbook data.
 * NOT wired into production runtime or dialogue-orchestrator by default.
 */

import { normalizeText } from "./redaction.js";
import { validateCallbackReadyLead } from "./lead-validator.js";

export const MAX_PHONE_QUESTION_CHARS = 120;

export const QUESTIONNAIRE_CALLER_INTENTS = Object.freeze({
  PRODUCT_QUESTION_ANSWERED: "product_question_answered",
  PRICING_ANSWERED: "pricing_answered",
  CALLBACK_REQUEST: "callback_request",
  CLOSING: "closing",
  OUT_OF_SCOPE: "out_of_scope",
  TECHNICAL_ESCALATION: "technical_escalation",
});

export const QUESTIONNAIRE_BLOCK_REASONS = Object.freeze({
  CLOSING: "closing_blocks_intake",
  ROLE_BOUNDARY: "role_boundary_blocks_intake",
  ANSWER_FIRST: "answer_before_intake",
  NONE: null,
});

/** Hardcoded defaults when playbook has no questionnaire_policy (or runtime flag off). */
export const HARDCODED_QUESTIONNAIRE_DEFAULTS = Object.freeze({
  max_question_chars: MAX_PHONE_QUESTION_CHARS,
  soft_prefix: "Wenn Sie möchten: ",
  generic_project_context:
    "Worum geht es kurz bei Ihrem Projekt, damit unser Team gezielter antworten kann?",
  products: Object.freeze({
    smart_website:
      "Geht es um eine neue Website oder einen Relaunch, und welche Ziele haben Sie?",
    voice_agent: "Welche Anrufe oder Anliegen sollen telefonisch abgedeckt werden?",
    lokalki: "Geht es vor allem um interne Dokumente oder lokale Sichtbarkeit?",
  }),
  contact_preference: "Möchten Sie telefonisch oder per E-Mail starten?",
});

const PII_PROMPT_PATTERNS = [
  /\b(telefonnummer|handynummer|mobilnummer|e-?mail-?adresse|ihre nummer|ihre mail)\b/i,
  /\b(nennen sie mir|geben sie mir)\b.*\b(nummer|mail|e-?mail)\b/i,
];

const FORBIDDEN_QUESTION_PATTERNS = [
  /\b\d{2,}\s*(?:€|eur|euro)\b/i,
  /\b(sofort verbinden|jetzt weiterleiten|live transfer|direkt verbinden)\b/i,
  /\b(garantiert|auf jeden fall|100\s*%)\b/i,
];

const ROLE_BOUNDARY_INTENTS = new Set([
  QUESTIONNAIRE_CALLER_INTENTS.OUT_OF_SCOPE,
  QUESTIONNAIRE_CALLER_INTENTS.TECHNICAL_ESCALATION,
]);

const ANSWERED_INTENTS = new Set([
  QUESTIONNAIRE_CALLER_INTENTS.PRODUCT_QUESTION_ANSWERED,
  QUESTIONNAIRE_CALLER_INTENTS.PRICING_ANSWERED,
]);

function normalizeProductId(productId = "") {
  return normalizeText(productId).toLowerCase().replace(/\s+/g, "_");
}

function resolveQuestionnairePolicy(playbook = null) {
  const fromPlaybook = playbook?.questionnaire_policy;
  if (fromPlaybook && typeof fromPlaybook === "object") {
    return {
      source: "playbook",
      max_question_chars: fromPlaybook.max_question_chars ?? MAX_PHONE_QUESTION_CHARS,
      soft_prefix: fromPlaybook.soft_prefix ?? HARDCODED_QUESTIONNAIRE_DEFAULTS.soft_prefix,
      generic_project_context:
        fromPlaybook.generic_project_context_question ??
        HARDCODED_QUESTIONNAIRE_DEFAULTS.generic_project_context,
      products: {
        ...HARDCODED_QUESTIONNAIRE_DEFAULTS.products,
        ...(fromPlaybook.products ?? {}),
      },
      contact_preference:
        fromPlaybook.contact_preference_question ??
        HARDCODED_QUESTIONNAIRE_DEFAULTS.contact_preference,
      answer_before_intake: fromPlaybook.answer_before_intake !== false,
    };
  }
  return {
    source: "hardcoded_default",
    ...HARDCODED_QUESTIONNAIRE_DEFAULTS,
    answer_before_intake: true,
  };
}

function projectQuestionForProduct(productId, policy) {
  const normalized = normalizeProductId(productId);
  if (normalized && policy.products[normalized]) {
    return policy.products[normalized];
  }
  return policy.generic_project_context;
}

function buildQuestion({ id, order, fieldKey, text, asksPii = false, policy }) {
  const maxChars = policy.max_question_chars ?? MAX_PHONE_QUESTION_CHARS;
  const trimmed = normalizeText(text);
  return {
    id,
    order,
    field_key: fieldKey,
    text: trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed,
    asks_pii: asksPii,
    max_chars: maxChars,
  };
}

function questionViolations(text = "") {
  const failures = [];
  if (PII_PROMPT_PATTERNS.some((pattern) => pattern.test(text))) {
    failures.push("pii_prompt");
  }
  for (const pattern of FORBIDDEN_QUESTION_PATTERNS) {
    if (pattern.test(text)) failures.push("forbidden_wording");
  }
  return failures;
}

/**
 * Deterministic gate — when questionnaire generation is allowed.
 */
export function evaluateQuestionnaireRules({
  productId = null,
  callerIntent = "",
  productAnswered = false,
  pricingAnswered = false,
  callClosing = false,
  playbook = null,
} = {}) {
  const intent = normalizeText(callerIntent).toLowerCase();
  const policy = resolveQuestionnairePolicy(playbook);

  if (callClosing || intent === QUESTIONNAIRE_CALLER_INTENTS.CLOSING) {
    return { allowed: false, reason: QUESTIONNAIRE_BLOCK_REASONS.CLOSING, policy };
  }
  if (ROLE_BOUNDARY_INTENTS.has(intent)) {
    return { allowed: false, reason: QUESTIONNAIRE_BLOCK_REASONS.ROLE_BOUNDARY, policy };
  }

  if (intent === QUESTIONNAIRE_CALLER_INTENTS.CALLBACK_REQUEST) {
    return { allowed: true, reason: "callback_contact_preference", policy, mode: "contact_only" };
  }

  const answered =
    productAnswered ||
    pricingAnswered ||
    ANSWERED_INTENTS.has(intent);

  if (policy.answer_before_intake && !answered) {
    return { allowed: false, reason: QUESTIONNAIRE_BLOCK_REASONS.ANSWER_FIRST, policy };
  }

  if (!normalizeProductId(productId) && !answered) {
    return { allowed: false, reason: QUESTIONNAIRE_BLOCK_REASONS.ANSWER_FIRST, policy };
  }

  return { allowed: true, reason: "project_context_after_answer", policy, mode: "project_context" };
}

/**
 * Generate ordered phone-friendly questions (non-live; no side effects).
 */
export function generatePlaybookQuestionnaire({
  productId = null,
  callerIntent = "",
  playbook = null,
  productAnswered = false,
  pricingAnswered = false,
  callClosing = false,
  callerRequestedContact = false,
  memory = {},
} = {}) {
  const gate = evaluateQuestionnaireRules({
    productId,
    callerIntent,
    productAnswered,
    pricingAnswered,
    callClosing,
    playbook,
  });
  const policy = gate.policy;
  const playbookVersion = playbook?.playbook_version ?? null;

  const base = {
    blocked: !gate.allowed,
    block_reason: gate.allowed ? null : gate.reason,
    source: policy.source,
    playbook_version: playbookVersion,
    mode: gate.mode ?? null,
    rules: {
      answer_before_intake: policy.answer_before_intake,
      no_lead_ready_without_validator: true,
      no_live_transfer_claim: true,
      no_exact_price_promise: true,
    },
    questions: [],
  };

  if (!gate.allowed) {
    return base;
  }

  const questions = [];

  if (gate.mode === "contact_only" || callerIntent === QUESTIONNAIRE_CALLER_INTENTS.CALLBACK_REQUEST) {
    const contactText = policy.contact_preference;
    questions.push(
      buildQuestion({
        id: "contact_preference",
        order: 1,
        fieldKey: "handoff_choice",
        text: contactText,
        asksPii: false,
        policy,
      })
    );
  } else {
    const projectText = `${policy.soft_prefix}${projectQuestionForProduct(productId, policy)}`;
    questions.push(
      buildQuestion({
        id: "project_context",
        order: 1,
        fieldKey: "use_case_summary",
        text: projectText,
        asksPii: false,
        policy,
      })
    );
  }

  const violations = [];
  for (const question of questions) {
    violations.push(...questionViolations(question.text).map((v) => `${question.id}:${v}`));
  }

  const callbackValidation = validateCallbackReadyLead(memory, { source: "questionnaire_generator" });
  const leadReadyAllowed = callbackValidation.allowed;

  return {
    ...base,
    questions,
    question_count: questions.length,
    violations,
    ok: violations.length === 0,
    lead_ready_allowed: leadReadyAllowed,
    caller_requested_contact: Boolean(callerRequestedContact),
  };
}

/** Privacy-safe snapshot for eval/regression (no transcript, phone, email). */
export function formatQuestionnaireEvalSnapshot(result = {}) {
  return JSON.stringify({
    playbook_version: result.playbook_version ?? null,
    source: result.source ?? null,
    blocked: Boolean(result.blocked),
    block_reason: result.block_reason ?? null,
    mode: result.mode ?? null,
    question_count: result.question_count ?? result.questions?.length ?? 0,
    ok: Boolean(result.ok),
    lead_ready_allowed: Boolean(result.lead_ready_allowed),
    questions: (result.questions ?? []).map(({ id, order, field_key, asks_pii, max_chars, text }) => ({
      id,
      order,
      field_key,
      asks_pii,
      max_chars,
      text_chars: text?.length ?? 0,
    })),
  });
}

export function assertQuestionnaireExpectations(result = {}, expected = {}) {
  const failures = [];

  if (expected.behavior === "blocked") {
    if (!result.blocked) failures.push("expected_blocked");
    if (expected.block_reason && result.block_reason !== expected.block_reason) {
      failures.push(`block_reason:${result.block_reason}`);
    }
    return failures;
  }

  if (result.blocked) {
    failures.push(`unexpected_block:${result.block_reason}`);
    return failures;
  }

  if (expected.behavior === "project_context_question" && result.mode !== "project_context") {
    failures.push(`mode:${result.mode}`);
  }
  if (expected.behavior === "contact_preference_only" && result.mode !== "contact_only") {
    failures.push(`mode:${result.mode}`);
  }
  if (expected.response_contains) {
    const combined = (result.questions ?? []).map((q) => q.text).join(" ");
    if (!new RegExp(expected.response_contains, "i").test(combined)) {
      failures.push(`response_missing:${expected.response_contains}`);
    }
  }
  if (expected.no_pii_prompt) {
    for (const question of result.questions ?? []) {
      if (question.asks_pii || questionViolations(question.text).includes("pii_prompt")) {
        failures.push("pii_prompt_detected");
      }
    }
  }
  if (expected.no_fixed_price) {
    for (const question of result.questions ?? []) {
      if (/\b\d{2,}\s*(?:€|eur|euro)\b/i.test(question.text ?? "")) {
        failures.push("fixed_price_in_question");
      }
    }
  }
  if (expected.no_lead_ready && result.lead_ready_allowed) {
    failures.push("premature_lead_ready");
  }
  if (expected.no_live_transfer_claim) {
    const combined = (result.questions ?? []).map((q) => q.text).join(" ");
    if (/\b(sofort verbinden|jetzt weiterleiten|live transfer)\b/i.test(combined)) {
      failures.push("live_transfer_claim");
    }
  }
  if (expected.question_count != null && (result.question_count ?? 0) !== expected.question_count) {
    failures.push(`question_count:${result.question_count}`);
  }

  return failures;
}
