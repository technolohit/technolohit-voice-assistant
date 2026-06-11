/**
 * Phase 10B — opt-in Agent Behavior Decision metadata plumbing (observability only).
 *
 * When enabled on an active v4 path, builds privacy-safe decision metadata for
 * quality events. Phase 10D adds an opt-in questionnaire attachment guard in
 * questionnaire-runtime.js when this flag is on; planner/RAG/callback behavior
 * is otherwise unchanged.
 */

import { loadTenantPlaybook, DEFAULT_PLAYBOOK_FILENAME } from "./playbook-loader.js";
import {
  resolveAgentBehaviorDecision,
  isAgentBehaviorDecisionRuntimeEnabled,
} from "./agent-behavior-decision.js";
import { resolveCallbackFlowState } from "./callback-flow-policy.js";
import { RESPONSE_TYPES } from "./response-planner.js";

let cachedDefaultPlaybook = undefined;

export function resetAgentBehaviorDecisionPlaybookCache() {
  cachedDefaultPlaybook = undefined;
}

function loadDefaultPlaybookForDecision() {
  if (cachedDefaultPlaybook !== undefined) return cachedDefaultPlaybook;
  const loaded = loadTenantPlaybook(DEFAULT_PLAYBOOK_FILENAME);
  cachedDefaultPlaybook = loaded.ok ? loaded.playbook : null;
  return cachedDefaultPlaybook;
}

export function isAgentBehaviorDecisionEnabled(config = null) {
  return isAgentBehaviorDecisionRuntimeEnabled(config);
}

function failurePayload(failureReason, extra = {}) {
  return {
    behavior_decision_enabled: true,
    behavior_decision_ok: false,
    behavior_decision_failure_reason: failureReason,
    behavior_decision_playbook_valid: false,
    behavior_decision_rag_allowed: false,
    behavior_decision_questionnaire_allowed: false,
    ...extra,
  };
}

function successPayload(decision) {
  return {
    behavior_decision_enabled: true,
    behavior_decision_ok: true,
    behavior_decision_priority: decision.priority ?? null,
    behavior_decision_response_type: decision.response_type ?? null,
    behavior_decision_product_id: decision.product_id ?? null,
    behavior_decision_playbook_version: decision.playbook_version ?? null,
    behavior_decision_playbook_valid: Boolean(decision.playbook_valid),
    behavior_decision_rag_allowed: Boolean(decision.rag_allowed),
    behavior_decision_questionnaire_allowed: Boolean(decision.questionnaire_allowed),
    behavior_decision_lead_tier: decision.lead_tier ?? null,
    behavior_decision_next_action: decision.next_action ?? null,
    behavior_decision_reason: decision.reason ?? null,
    behavior_decision_suppressed_intents: Array.isArray(decision.suppressed_intents)
      ? decision.suppressed_intents
      : [],
    behavior_decision_source: decision.source ?? "agent_behavior_decision",
  };
}

function mapRoleBoundaryIntent(intent = "") {
  if (intent === "out_of_scope" || intent === "technical_escalation") return intent;
  return null;
}

function deriveDecisionInputs({
  memory = {},
  intent = "unclear",
  plan = null,
} = {}) {
  const productId =
    memory?.selected_product_id ?? memory?.current_product_context ?? null;
  const productAnswered =
    plan?.response_type === RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER ||
    memory?.product_answered === true;
  const pricingAnswered =
    plan?.plan_reason === "product_pricing_fallback" || memory?.pricing_answered === true;
  const questionnaireEligible = plan?.questionnaire?.used === true;

  return {
    productContext: productId ? { product_id: productId } : null,
    callbackFlowState: resolveCallbackFlowState(memory),
    roleBoundaryIntent: mapRoleBoundaryIntent(intent),
    closingIntent: intent === "closing",
    productAnswered,
    pricingAnswered,
    questionnaireEligible,
  };
}

/**
 * Build privacy-safe decision metadata. Returns null when disabled or v4 inactive.
 * Never throws — failures return safe failure metadata.
 */
export function buildAgentBehaviorDecisionMetadata({
  config = null,
  v4PathActive = false,
  transcript = "",
  memory = {},
  state = null,
  intent = "unclear",
  plan = null,
  playbook = undefined,
  resolveFn = resolveAgentBehaviorDecision,
} = {}) {
  if (!isAgentBehaviorDecisionEnabled(config) || !v4PathActive) {
    return null;
  }

  try {
    const resolvedPlaybook =
      playbook === undefined ? loadDefaultPlaybookForDecision() : playbook;
    const derived = deriveDecisionInputs({ memory, intent, plan });
    const decision = resolveFn({
      transcript,
      memory,
      state,
      playbook: resolvedPlaybook,
      config,
      intent,
      productContext: derived.productContext,
      callbackFlowState: derived.callbackFlowState,
      roleBoundaryIntent: derived.roleBoundaryIntent,
      closingIntent: derived.closingIntent,
      productAnswered: derived.productAnswered,
      pricingAnswered: derived.pricingAnswered,
      questionnaireEligible: derived.questionnaireEligible,
    });
    return successPayload(decision);
  } catch {
    return failurePayload("resolver_error");
  }
}

/** Flat quality-event fields for response_plan_created (empty when disabled). */
export function behaviorDecisionQualityPayload({
  config = null,
  v4PathActive = false,
  transcript = "",
  memory = {},
  state = null,
  intent = "unclear",
  plan = null,
  playbook = undefined,
  resolveFn = resolveAgentBehaviorDecision,
} = {}) {
  const metadata = buildAgentBehaviorDecisionMetadata({
    config,
    v4PathActive,
    transcript,
    memory,
    state,
    intent,
    plan,
    playbook,
    resolveFn,
  });
  return metadata ?? {};
}
