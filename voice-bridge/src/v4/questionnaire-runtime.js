/**
 * Phase 10AR — opt-in v4 questionnaire runtime wiring after product/pricing answers.
 *
 * Default-off (`VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED=false`). When disabled the
 * planner plan is returned unchanged (no extra fields).
 */

import { normalizeText } from "./redaction.js";
import { COMBINED_LIVE_TTS_CHAR_LIMIT } from "./playbook-short-answer.js";
import { buildSafeTextPreview } from "./rag-quality-diagnostics.js";
import { resolveCurrentProductContext } from "./product-context-persistence.js";
import {
  generatePlaybookQuestionnaire,
  QUESTIONNAIRE_CALLER_INTENTS,
} from "./playbook-questionnaire-generator.js";
import { loadTenantPlaybook, DEFAULT_PLAYBOOK_FILENAME } from "./playbook-loader.js";
import { sanitizeResponseText } from "./transcript-intent.js";
import { isCallbackFlowActive } from "./callback-flow-policy.js";

const PRODUCT_QUESTION_ANSWER = "product_question_answer";

export const QUESTIONNAIRE_RUNTIME_BLOCK_REASONS = Object.freeze({
  RUNTIME_DISABLED: "questionnaire_runtime_disabled",
  V4_PATH_INACTIVE: "v4_path_inactive",
  NOT_PRODUCT_ANSWER: "not_product_answer",
  PLAN_REASON_NOT_ELIGIBLE: "plan_reason_not_eligible",
  ROLE_BOUNDARY_INTENT: "role_boundary_blocks_intake",
  CLOSING: "closing_blocks_intake",
  CALLBACK_FLOW: "callback_uses_contact_flow",
  RAG_FALLBACK_ONLY: "rag_fallback_only",
  NO_PRODUCT_CONTEXT: "no_product_context",
  DUPLICATE_RESPONSE: "duplicate_response_guard",
  GENERATOR_BLOCKED: "generator_blocked",
  GENERATOR_INVALID: "generator_invalid",
  LENGTH_LIMIT: "response_length_limit",
});

const ROLE_BOUNDARY_INTENTS = new Set([
  "out_of_scope",
  "technical_escalation",
  "closing",
]);

// Phase 10AT/10AU: the whole callback/contact continuation (preference,
// permission grant/refusal, manual review, attention recovery) uses the
// contact flow — never attach a questionnaire question to those turns.
const CALLBACK_INTENTS = new Set([
  "callback_request",
  "contact_phone",
  "contact_email",
  "callback_permission_granted",
  "callback_permission_denied",
  "callback_flow_attention",
]);

const ELIGIBLE_ANSWER_PLAN_REASONS = new Set([
  "combined_product_inquiry",
  "scoped_product_qa",
  "product_pricing_fallback",
]);

const INELIGIBLE_ANSWER_PLAN_REASONS = new Set([
  "product_selection_intro",
  "low_confidence_clarification",
  "explicit_sales_qualification",
  "product_switch_ack",
]);

const RAG_FALLBACK_BLOCK_REASONS = new Set([
  "rag_unsafe_or_empty",
  "rag_filter_rejected",
]);

let cachedDefaultPlaybook = null;

function loadDefaultPlaybookForQuestionnaire() {
  if (cachedDefaultPlaybook) return cachedDefaultPlaybook;
  const loaded = loadTenantPlaybook(DEFAULT_PLAYBOOK_FILENAME);
  cachedDefaultPlaybook = loaded.ok ? loaded.playbook : null;
  return cachedDefaultPlaybook;
}

export function isQuestionnaireRuntimeEnabled(config = null) {
  return Boolean(config?.v4?.questionnaireRuntimeEnabled);
}

function createQuestionnaireMeta(overrides = {}) {
  return {
    enabled: false,
    used: false,
    mode: null,
    question_count: 0,
    block_reason: null,
    product_id: null,
    follow_up_question: null,
    follow_up_preview: null,
    spoken_attached: false,
    ...overrides,
  };
}

function resolveSpokenCharLimit(plan = {}) {
  const fromPlan = Number(plan.max_spoken_chars);
  if (Number.isFinite(fromPlan) && fromPlan > 0) return fromPlan;
  return COMBINED_LIVE_TTS_CHAR_LIMIT;
}

function isPricingAnswerTurn(plan = {}, transcript = "") {
  if (plan.plan_reason === "product_pricing_fallback") return true;
  return /\b(preis|kosten|was kostet|wie viel|pricing|tarif)\b/i.test(transcript ?? "");
}

function isEligibleProductPricingAnswer(plan = {}, resolvedIntent = "") {
  if (plan.response_type !== PRODUCT_QUESTION_ANSWER) return false;
  if (INELIGIBLE_ANSWER_PLAN_REASONS.has(plan.plan_reason)) return false;
  if (ELIGIBLE_ANSWER_PLAN_REASONS.has(plan.plan_reason)) return true;
  if (!plan.plan_reason && resolvedIntent === "product_question") return true;
  return false;
}

export function evaluateQuestionnaireRuntimeEligibility({
  config = null,
  v4PathActive = false,
  plan = null,
  resolvedIntent = "",
  memory = {},
  transcript = "",
  ragResult = null,
  ragGate = null,
  lastAssistantText = null,
} = {}) {
  const enabled = isQuestionnaireRuntimeEnabled(config);
  if (!enabled) {
    return { allowed: false, reason: QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.RUNTIME_DISABLED, enabled: false };
  }
  if (!v4PathActive) {
    return { allowed: false, reason: QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.V4_PATH_INACTIVE, enabled: true };
  }
  if (ROLE_BOUNDARY_INTENTS.has(resolvedIntent) || memory?.call_closing) {
    return {
      allowed: false,
      reason: QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.ROLE_BOUNDARY_INTENT,
      enabled: true,
    };
  }
  // Phase 10AU Golden Conversation Contract: once the callback/contact flow
  // has started, no questionnaire question may attach — including on later
  // explicit product-question turns.
  if (CALLBACK_INTENTS.has(resolvedIntent) || isCallbackFlowActive(memory)) {
    return {
      allowed: false,
      reason: QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.CALLBACK_FLOW,
      enabled: true,
    };
  }
  if (!isEligibleProductPricingAnswer(plan, resolvedIntent)) {
    const reason = plan?.response_type !== PRODUCT_QUESTION_ANSWER
      ? QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.NOT_PRODUCT_ANSWER
      : QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.PLAN_REASON_NOT_ELIGIBLE;
    return { allowed: false, reason, enabled: true };
  }
  const fallbackReason = String(ragResult?.fallback_reason ?? "").trim();
  if (RAG_FALLBACK_BLOCK_REASONS.has(fallbackReason)) {
    return {
      allowed: false,
      reason: QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.RAG_FALLBACK_ONLY,
      enabled: true,
    };
  }
  if (ragGate?.allowed && !ragResult?.used_rag && plan.plan_reason === "scoped_product_qa" && !plan.text) {
    return {
      allowed: false,
      reason: QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.RAG_FALLBACK_ONLY,
      enabled: true,
    };
  }
  const productId =
    resolveCurrentProductContext(memory) ??
    plan?.memory_patch?.selected_product_id ??
    plan?.memory_patch?.product_interest ??
    null;
  if (!productId) {
    return {
      allowed: false,
      reason: QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.NO_PRODUCT_CONTEXT,
      enabled: true,
    };
  }
  const answerText = normalizeText(plan?.text ?? "");
  const previousText = normalizeText(lastAssistantText ?? "");
  if (previousText && answerText && answerText === previousText) {
    return {
      allowed: false,
      reason: QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.DUPLICATE_RESPONSE,
      enabled: true,
    };
  }
  return { allowed: true, reason: null, enabled: true, productId };
}

/**
 * Attach at most one soft follow-up question after a product/pricing answer.
 * When runtime is disabled, returns the plan unchanged (no new fields).
 */
export function applyQuestionnaireRuntimeToPlan(plan, options = {}) {
  const {
    config = null,
    v4PathActive = false,
    resolvedIntent = "",
    memory = {},
    transcript = "",
    ragResult = null,
    ragGate = null,
    lastAssistantText = null,
    playbook = null,
  } = options;

  if (!isQuestionnaireRuntimeEnabled(config)) {
    return plan;
  }

  const eligibility = evaluateQuestionnaireRuntimeEligibility({
    config,
    v4PathActive,
    plan,
    resolvedIntent,
    memory,
    transcript,
    ragResult,
    ragGate,
    lastAssistantText,
  });

  const productId =
    eligibility.productId ??
    resolveCurrentProductContext(memory) ??
    plan?.memory_patch?.selected_product_id ??
    null;

  const baseMeta = createQuestionnaireMeta({
    enabled: true,
    product_id: productId,
    block_reason: eligibility.reason,
  });

  if (!eligibility.allowed) {
    return {
      ...plan,
      questionnaire: baseMeta,
    };
  }

  const resolvedPlaybook = playbook ?? loadDefaultPlaybookForQuestionnaire();
  const pricingAnswered = isPricingAnswerTurn(plan, transcript);
  const generated = generatePlaybookQuestionnaire({
    productId,
    callerIntent: pricingAnswered
      ? QUESTIONNAIRE_CALLER_INTENTS.PRICING_ANSWERED
      : QUESTIONNAIRE_CALLER_INTENTS.PRODUCT_QUESTION_ANSWERED,
    playbook: resolvedPlaybook,
    productAnswered: true,
    pricingAnswered,
    memory,
  });

  if (generated.blocked) {
    return {
      ...plan,
      questionnaire: createQuestionnaireMeta({
        enabled: true,
        used: false,
        mode: generated.mode,
        block_reason: generated.block_reason ?? QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.GENERATOR_BLOCKED,
        product_id: productId,
      }),
    };
  }

  if (!generated.ok || !generated.questions?.length) {
    return {
      ...plan,
      questionnaire: createQuestionnaireMeta({
        enabled: true,
        used: false,
        block_reason: QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.GENERATOR_INVALID,
        product_id: productId,
      }),
    };
  }

  const followUp = generated.questions[0];
  const charLimit = resolveSpokenCharLimit(plan);
  const answerText = sanitizeResponseText(plan.text ?? "");
  const combined = sanitizeResponseText(`${answerText} ${followUp.text}`.trim());
  const canAttach = combined.length <= charLimit;

  const questionnaire = createQuestionnaireMeta({
    enabled: true,
    used: true,
    mode: generated.mode ?? "project_context",
    question_count: 1,
    block_reason: canAttach ? null : QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.LENGTH_LIMIT,
    product_id: productId,
    follow_up_question: followUp.text,
    follow_up_preview: buildSafeTextPreview(followUp.text, 80),
    spoken_attached: canAttach,
  });

  return {
    ...plan,
    text: canAttach ? combined : answerText,
    follow_up_question: followUp.text,
    questionnaire,
    lead_transition_allowed: false,
  };
}

export function questionnaireQualityPayload(plan = null) {
  const questionnaire = plan?.questionnaire;
  if (!questionnaire) return {};
  return {
    questionnaire_enabled: Boolean(questionnaire.enabled),
    questionnaire_used: Boolean(questionnaire.used),
    questionnaire_mode: questionnaire.mode ?? null,
    questionnaire_question_count: questionnaire.question_count ?? 0,
    questionnaire_block_reason: questionnaire.block_reason ?? null,
    questionnaire_product_id: questionnaire.product_id ?? null,
    questionnaire_follow_up_preview: questionnaire.follow_up_preview ?? null,
    questionnaire_spoken_attached: Boolean(questionnaire.spoken_attached),
  };
}

/** Test helper — reset cached playbook between tests. */
export function resetQuestionnaireRuntimePlaybookCache() {
  cachedDefaultPlaybook = null;
}
