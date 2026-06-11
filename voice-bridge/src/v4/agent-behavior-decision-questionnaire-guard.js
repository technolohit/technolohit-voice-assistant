/**
 * Phase 10D — opt-in questionnaire attachment guard from Agent Behavior Decision.
 *
 * When VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED=true on an active v4 path,
 * blocks questionnaire runtime attachment when decision metadata says
 * questionnaire_allowed=false. Does not affect planner response_type/text/next_state.
 */

import {
  resolveAgentBehaviorDecision,
  isAgentBehaviorDecisionRuntimeEnabled,
} from "./agent-behavior-decision.js";
import { resolveCallbackFlowState } from "./callback-flow-policy.js";
import { loadTenantPlaybook, DEFAULT_PLAYBOOK_FILENAME } from "./playbook-loader.js";

let cachedDefaultPlaybook = undefined;

export function resetAgentBehaviorDecisionQuestionnaireGuardCache() {
  cachedDefaultPlaybook = undefined;
}

function loadDefaultPlaybookForGuard() {
  if (cachedDefaultPlaybook !== undefined) return cachedDefaultPlaybook;
  const loaded = loadTenantPlaybook(DEFAULT_PLAYBOOK_FILENAME);
  cachedDefaultPlaybook = loaded.ok ? loaded.playbook : null;
  return cachedDefaultPlaybook;
}

function mapRoleBoundaryIntent(intent = "") {
  if (intent === "out_of_scope" || intent === "technical_escalation") return intent;
  return null;
}

/**
 * Pre-attachment guard: resolves decision with questionnaireEligible=false so
 * explicit product / continuation priorities are evaluated before questionnaire.
 */
export function evaluateBehaviorDecisionQuestionnaireGuard({
  config = null,
  v4PathActive = false,
  transcript = "",
  memory = {},
  state = null,
  intent = "unclear",
  plan = null,
  playbook = undefined,
} = {}) {
  if (!isAgentBehaviorDecisionRuntimeEnabled(config) || !v4PathActive) {
    return { allowed: true, guardActive: false };
  }

  try {
    const resolvedPlaybook =
      playbook === undefined ? loadDefaultPlaybookForGuard() : playbook;
    const productId =
      memory?.selected_product_id ?? memory?.current_product_context ?? null;

    const decision = resolveAgentBehaviorDecision({
      transcript,
      memory,
      state,
      playbook: resolvedPlaybook,
      config,
      intent,
      productContext: productId ? { product_id: productId } : null,
      callbackFlowState: resolveCallbackFlowState(memory),
      roleBoundaryIntent: mapRoleBoundaryIntent(intent),
      closingIntent: intent === "closing",
      productAnswered: memory?.product_answered === true,
      pricingAnswered:
        memory?.pricing_answered === true || plan?.plan_reason === "product_pricing_fallback",
      questionnaireEligible: false,
    });

    if (!decision.questionnaire_allowed) {
      return {
        allowed: false,
        guardActive: true,
        decisionPriority: decision.priority ?? null,
        decisionReason: decision.reason ?? null,
      };
    }

    return { allowed: true, guardActive: true, decisionPriority: decision.priority ?? null };
  } catch {
    return { allowed: false, guardActive: true, decisionPriority: null, decisionReason: "resolver_error" };
  }
}
