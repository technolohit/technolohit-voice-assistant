/**
 * Phase 10AO — non-live eval scenario runner from tenant playbook eval_scenarios.
 *
 * Loads scenarios from the structured playbook, runs implemented categories through
 * the existing v4 planner/orchestrator harness (no STT/TTS/RAG/network), and
 * returns privacy-safe results keyed by playbook_version.
 *
 * Out-of-scope redirect, technical escalation, and callback lead-capture paths are
 * runtime-consumed in Phase 10AP (planner/orchestrator harness, no live network).
 * Questionnaire/lead-intake generation is non-live in Phase 10AQ (generator module only).
 */

import { loadConfig } from "../config.js";
import { loadAgentConfig } from "./agent-config.js";
import {
  resolveBehaviorPolicy,
  getOutOfScopeRedirect,
  getTechnicalEscalationResponse,
  getFallbackClarificationResponse,
} from "./behavior-policy.js";
import { loadTenantPlaybook, DEFAULT_PLAYBOOK_FILENAME } from "./playbook-loader.js";
import { resolveClosedDomainIntent } from "./closed-domain-intent.js";
import {
  buildResponsePlan,
  RESPONSE_TYPES,
  detectTranscriptIntent,
} from "./response-planner.js";
import {
  createDialogueOrchestrator,
  startTurn,
  acceptUserTranscript,
  decideNextAction,
  handleInterruption,
} from "./dialogue-orchestrator.js";
import { createRuntimeContext } from "./runtime-context.js";
import { createQualityEventSink } from "./quality-event-sink.js";
import { createCallSessionMemory, setSelectedProduct } from "./call-session-memory.js";
import { COMBINED_LIVE_TTS_CHAR_LIMIT } from "./playbook-short-answer.js";
import {
  generatePlaybookQuestionnaire,
  assertQuestionnaireExpectations,
} from "./playbook-questionnaire-generator.js";
import { V4_STATES } from "./state-machine.js";

/** Categories with a live v4 planner/orchestrator consumer today. */
export const RUNTIME_IMPLEMENTED_EVAL_CATEGORIES = new Set([
  "closing",
  "interruption",
  "pricing",
  "product_question",
  "fallback",
  "out_of_scope",
  "technical_escalation",
  "callback",
  "questionnaire",
]);

/** Reserved for future categories without a runtime consumer yet. */
export const RUNTIME_PENDING_EVAL_CATEGORIES = new Set([]);

export const REQUIRED_EVAL_SCENARIO_CATEGORIES = [
  "closing",
  "fallback",
  "pricing",
  "product_question",
  "callback",
  "out_of_scope",
  "technical_escalation",
];

export const PENDING_SCENARIO_STATUS = "pending";
export const PENDING_SCENARIO_REASON = "documented_playbook_ready_runtime_consumer_pending";

export function loadPlaybookEvalScenarios(playbook) {
  const scenarios = Array.isArray(playbook?.eval_scenarios) ? playbook.eval_scenarios : [];
  return scenarios.filter((scenario) => {
    if (!scenario?.id || !scenario?.category) return false;
    if (scenario.category === "questionnaire") {
      return Boolean(scenario.caller_intent && scenario.expected);
    }
    return Boolean(scenario.caller);
  });
}

export function validatePlaybookEvalScenarios(playbook) {
  const errors = [];
  const scenarios = loadPlaybookEvalScenarios(playbook);
  if (scenarios.length === 0) {
    errors.push("eval_scenarios_empty");
    return { ok: false, errors, scenarios };
  }

  const categories = new Set(scenarios.map((scenario) => scenario.category));
  for (const category of REQUIRED_EVAL_SCENARIO_CATEGORIES) {
    if (!categories.has(category)) {
      errors.push(`missing_eval_category:${category}`);
    }
  }

  for (const scenario of scenarios) {
    if (!scenario.expected || typeof scenario.expected !== "object") {
      errors.push(`eval_scenario_missing_expected:${scenario.id}`);
    }
  }

  return { ok: errors.length === 0, errors, scenarios };
}

export function isRuntimeImplementedEvalCategory(category) {
  return RUNTIME_IMPLEMENTED_EVAL_CATEGORIES.has(category);
}

export function buildEvalScenarioMemory(scenario) {
  const base = createCallSessionMemory({ bridgeCallId: `eval-${scenario.id}` });
  const context = String(scenario.context ?? "").toLowerCase();

  if (scenario.category === "closing" && context.includes("produkt")) {
    return {
      ...setSelectedProduct(base, "smart_website"),
      current_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
    };
  }

  if (scenario.category === "pricing" || scenario.category === "product_question") {
    return {
      ...setSelectedProduct(base, "smart_website"),
      current_state: V4_STATES.LISTENING,
    };
  }

  return { ...base, current_state: V4_STATES.LISTENING };
}

export function buildEvalScenarioStateMachine(scenario, memory = {}) {
  const state = memory.current_state ?? V4_STATES.LISTENING;
  if (scenario.category === "interruption") {
    return { state: V4_STATES.SPEAKING };
  }
  return { state };
}

function buildClosedDomainForScenario(scenario, agentConfig, memory) {
  if (
    scenario.category === "fallback" ||
    scenario.category === "out_of_scope" ||
    scenario.category === "technical_escalation" ||
    scenario.category === "callback"
  ) {
    return { is_low_confidence: false, matched_product: null };
  }
  return resolveClosedDomainIntent({
    agentConfig,
    transcript: scenario.caller,
    memory,
  });
}

function assertPlanExpectations(plan, expected = {}, meta = {}) {
  const failures = [];

  if (expected.response_type && plan.response_type !== expected.response_type) {
    failures.push(`response_type:${plan.response_type}!=${expected.response_type}`);
  }
  if (expected.plan_reason && plan.plan_reason !== expected.plan_reason) {
    failures.push(`plan_reason:${plan.plan_reason}!=${expected.plan_reason}`);
  }
  if (expected.response && plan.text !== expected.response) {
    failures.push("response_text_mismatch");
  }
  if (expected.response_contains && !new RegExp(expected.response_contains, "i").test(plan.text ?? "")) {
    failures.push(`response_missing:${expected.response_contains}`);
  }
  if (expected.no_collect_sales_context && plan.response_type === RESPONSE_TYPES.COLLECT_SALES_CONTEXT) {
    failures.push("unexpected_collect_sales_context");
  }
  if (expected.no_fallback_clarification && plan.response_type === RESPONSE_TYPES.FALLBACK_CLARIFICATION) {
    failures.push("unexpected_fallback_clarification");
  }
  if (expected.within_live_tts_limit && (plan.text?.length ?? 0) > COMBINED_LIVE_TTS_CHAR_LIMIT) {
    failures.push("exceeds_live_tts_limit");
  }
  if (expected.no_fixed_price && /\b\d{2,}\s*(?:€|eur|euro)\b/i.test(plan.text ?? "")) {
    failures.push("fixed_price_detected");
  }
  if (expected.no_rag && meta.ragRetrieverCalls > 0) {
    failures.push("rag_retriever_called");
  }
  if (expected.not_closing && plan.response_type === RESPONSE_TYPES.CLOSING) {
    failures.push("unexpected_closing");
  }
  if (expected.behavior === "barge_in_interruption_wait" && meta.recoveryAction !== "interruption_followup") {
    failures.push(`recovery_action:${meta.recoveryAction ?? "null"}`);
  }
  if (expected.behavior === "role_boundary_redirect") {
    if (plan.plan_reason !== "out_of_scope_redirect") {
      failures.push(`plan_reason:${plan.plan_reason ?? "null"}`);
    }
    if (plan.response_type !== RESPONSE_TYPES.ROLE_BOUNDARY_REDIRECT) {
      failures.push(`response_type:${plan.response_type}`);
    }
  }
  if (expected.behavior === "escalate_to_team") {
    if (plan.plan_reason !== "technical_escalation") {
      failures.push(`plan_reason:${plan.plan_reason ?? "null"}`);
    }
    if (plan.response_type !== RESPONSE_TYPES.TECHNICAL_ESCALATION) {
      failures.push(`response_type:${plan.response_type}`);
    }
  }
  if (expected.behavior === "lead_capture_appropriate") {
    const allowedTypes = new Set([
      RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE,
      RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION,
    ]);
    if (!allowedTypes.has(plan.response_type)) {
      failures.push(`response_type:${plan.response_type}`);
    }
    if (plan.lead_transition_allowed) {
      failures.push("premature_lead_transition");
    }
    if (/\b(sofort verbinden|jetzt weiterleiten|live transfer)\b/i.test(plan.text ?? "")) {
      failures.push("live_transfer_claim");
    }
  }
  if (expected.no_general_chatbot_answer && /\b(einstein|relativit[aä]t)\b/i.test(plan.text ?? "")) {
    failures.push("general_knowledge_answer");
  }
  if (expected.no_overpromise && /\b(garantiert|auf jeden fall|problemlos|100\s*%)\b/i.test(plan.text ?? "")) {
    failures.push("overpromise_detected");
  }
  if (expected.no_lead_capture && plan.response_type === RESPONSE_TYPES.COLLECT_SALES_CONTEXT) {
    failures.push("unexpected_lead_capture");
  }

  return failures;
}

function runPendingScenarioDocumentationCheck(scenario, playbook, policy) {
  const failures = [];
  const expected = scenario.expected ?? {};

  if (scenario.category === "out_of_scope") {
    const redirect = getOutOfScopeRedirect(policy);
    if (expected.response_contains && !new RegExp(expected.response_contains, "i").test(redirect)) {
      failures.push("policy_out_of_scope_redirect_mismatch");
    }
    if (playbook.escalation_policy?.out_of_scope_redirect !== redirect) {
      failures.push("playbook_escalation_redirect_mismatch");
    }
  }

  if (scenario.category === "technical_escalation") {
    const escalation = getTechnicalEscalationResponse(policy);
    if (expected.response_contains && !new RegExp(expected.response_contains, "i").test(escalation)) {
      failures.push("policy_technical_escalation_mismatch");
    }
    if (playbook.escalation_policy?.uncertain_or_technical !== escalation) {
      failures.push("playbook_technical_escalation_mismatch");
    }
  }

  if (scenario.category === "callback") {
    const callbackPolicy = playbook.callback_policy ?? {};
    if (expected.requires_valid_phone && callbackPolicy.callback_requires_valid_phone !== true) {
      failures.push("callback_requires_valid_phone_not_documented");
    }
    if (expected.requires_permission && callbackPolicy.callback_requires_permission !== true) {
      failures.push("callback_requires_permission_not_documented");
    }
    if (expected.no_live_transfer_claim && callbackPolicy.no_live_transfer_claims !== true) {
      failures.push("no_live_transfer_claim_not_documented");
    }
  }

  return failures;
}

export async function runEvalScenario({
  scenario,
  agentConfig,
  config = null,
  behaviorPolicy = null,
  playbook = null,
  useOrchestrator = false,
} = {}) {
  if (!scenario?.id) {
    return {
      id: null,
      category: scenario?.category ?? null,
      status: "fail",
      reason: "scenario_missing_id",
      caller_chars: 0,
    };
  }

  const callerChars = String(scenario.caller ?? "").length;
  const baseResult = {
    id: scenario.id,
    category: scenario.category,
    caller_chars: callerChars,
    runtime_mode: null,
  };

  if (RUNTIME_PENDING_EVAL_CATEGORIES.has(scenario.category)) {
    const docFailures = runPendingScenarioDocumentationCheck(
      scenario,
      playbook ?? {},
      behaviorPolicy ?? resolveBehaviorPolicy({ config: config ?? loadConfig() })
    );
    return {
      ...baseResult,
      status: docFailures.length ? "fail" : PENDING_SCENARIO_STATUS,
      reason: docFailures.length ? docFailures.join(";") : PENDING_SCENARIO_REASON,
      runtime_mode: "documentation_only",
    };
  }

  if (!RUNTIME_IMPLEMENTED_EVAL_CATEGORIES.has(scenario.category)) {
    return {
      ...baseResult,
      status: "fail",
      reason: `unsupported_eval_category:${scenario.category}`,
      runtime_mode: "unsupported",
    };
  }

  if (scenario.category === "questionnaire") {
    const questionnaire = generatePlaybookQuestionnaire({
      productId: scenario.product_id ?? null,
      callerIntent: scenario.caller_intent,
      playbook: playbook ?? null,
      productAnswered:
        scenario.caller_intent === "product_question_answered" ||
        scenario.caller_intent === "pricing_answered",
      pricingAnswered: scenario.caller_intent === "pricing_answered",
      callClosing: scenario.caller_intent === "closing",
      callerRequestedContact: scenario.caller_intent === "callback_request",
      memory: buildEvalScenarioMemory(scenario),
    });
    const failures = assertQuestionnaireExpectations(questionnaire, scenario.expected ?? {});
    return {
      ...baseResult,
      status: failures.length ? "fail" : "pass",
      reason: failures.length ? failures.join(";") : "questionnaire_pass",
      runtime_mode: "questionnaire_generator",
      response_type: questionnaire.blocked ? "questionnaire_blocked" : "questionnaire_ready",
      plan_reason: questionnaire.block_reason ?? questionnaire.mode ?? null,
      question_count: questionnaire.question_count ?? 0,
    };
  }

  const resolvedConfig = config ?? loadConfig();
  const resolvedAgent = agentConfig ?? loadAgentConfig(resolvedConfig);
  const resolvedPolicy = behaviorPolicy ?? resolveBehaviorPolicy({ config: resolvedConfig });
  const memory = buildEvalScenarioMemory(scenario);
  const stateMachine = buildEvalScenarioStateMachine(scenario, memory);
  const closedDomain = buildClosedDomainForScenario(scenario, resolvedAgent, memory);
  let ragRetrieverCalls = 0;

  if (scenario.category === "interruption") {
    const orchestrator = createDialogueOrchestrator({
      config: resolvedConfig,
      runtimeContext: createRuntimeContext(resolvedConfig, { bridgeCallId: memory.bridge_call_id }),
      memory,
      stateMachine,
      agentConfig: resolvedAgent,
      qualitySink: createQualityEventSink({ v4PathActive: true }),
      v4PathActive: true,
      behaviorPolicy: resolvedPolicy,
    });
    orchestrator.lastAssistantText = "Smart Website strukturiert Inhalte und Anfragen.";
    const interruption = await handleInterruption(orchestrator, { callerText: scenario.caller });
    const failures = assertPlanExpectations(interruption.plan, scenario.expected, {
      recoveryAction: interruption.recovery?.recoveryAction ?? null,
      ragRetrieverCalls: 0,
    });
    return {
      ...baseResult,
      status: failures.length ? "fail" : "pass",
      reason: failures.length ? failures.join(";") : "runtime_pass",
      runtime_mode: "interruption_handler",
      response_type: interruption.plan?.response_type ?? null,
      plan_reason: interruption.plan?.plan_reason ?? null,
    };
  }

  let plan;
  if (useOrchestrator && (scenario.category === "closing" || scenario.category === "out_of_scope")) {
    const orchestrator = createDialogueOrchestrator({
      config: resolvedConfig,
      runtimeContext: createRuntimeContext(resolvedConfig, { bridgeCallId: memory.bridge_call_id }),
      memory,
      stateMachine,
      agentConfig: resolvedAgent,
      adapters: {
        ragRetriever: async () => {
          ragRetrieverCalls += 1;
          return { ok: true, hit: false, hitCount: 0 };
        },
      },
      qualitySink: createQualityEventSink({ v4PathActive: true }),
      v4PathActive: true,
      behaviorPolicy: resolvedPolicy,
    });
    startTurn(orchestrator);
    acceptUserTranscript(orchestrator, scenario.caller);
    const action = await decideNextAction(orchestrator, { transcript: scenario.caller });
    plan = action.plan;
  } else {
    const intent =
      scenario.category === "fallback"
        ? "unclear"
        : detectTranscriptIntent(scenario.caller, memory, resolvedAgent, resolvedPolicy);
    plan = buildResponsePlan({
      agentConfig: resolvedAgent,
      memory,
      stateMachine,
      transcript: scenario.caller,
      intent,
      closedDomain,
      ragGate: { allowed: false },
      behaviorPolicy: resolvedPolicy,
    });

    if (scenario.category === "fallback") {
      const expectedText = getFallbackClarificationResponse(resolvedPolicy);
      if (plan.text !== expectedText) {
        return {
          ...baseResult,
          status: "fail",
          reason: "fallback_response_mismatch",
          runtime_mode: "planner",
          response_type: plan.response_type,
        };
      }
    }
  }

  const failures = assertPlanExpectations(plan, scenario.expected, { ragRetrieverCalls });
  return {
    ...baseResult,
    status: failures.length ? "fail" : "pass",
    reason: failures.length ? failures.join(";") : "runtime_pass",
    runtime_mode: useOrchestrator ? "orchestrator" : "planner",
    response_type: plan.response_type,
    plan_reason: plan.plan_reason ?? null,
    response_chars: plan.text?.length ?? 0,
  };
}

export async function runPlaybookEvalSuite({
  playbook,
  agentConfig = null,
  config = null,
  behaviorPolicy = null,
  useOrchestratorForClosing = true,
} = {}) {
  const validation = validatePlaybookEvalScenarios(playbook);
  if (!validation.ok) {
    return {
      playbook_version: playbook?.playbook_version ?? null,
      tenant_id: playbook?.tenant_id ?? null,
      agent_id: playbook?.agent_id ?? null,
      ok: false,
      validation_errors: validation.errors,
      summary: { total: 0, pass: 0, pending: 0, fail: validation.errors.length },
      results: [],
    };
  }

  const resolvedConfig = config ?? loadConfig();
  const resolvedAgent = agentConfig ?? loadAgentConfig(resolvedConfig);
  const resolvedPolicy = behaviorPolicy ?? resolveBehaviorPolicy({ config: resolvedConfig });
  const results = [];

  for (const scenario of validation.scenarios) {
    const result = await runEvalScenario({
      scenario,
      agentConfig: resolvedAgent,
      config: resolvedConfig,
      behaviorPolicy: resolvedPolicy,
      playbook,
      useOrchestrator:
        useOrchestratorForClosing &&
        (scenario.category === "closing" || scenario.category === "out_of_scope"),
    });
    results.push(result);
  }

  const summary = {
    total: results.length,
    pass: results.filter((entry) => entry.status === "pass").length,
    pending: results.filter((entry) => entry.status === PENDING_SCENARIO_STATUS).length,
    fail: results.filter((entry) => entry.status === "fail").length,
  };

  return {
    playbook_version: playbook.playbook_version,
    tenant_id: playbook.tenant_id,
    agent_id: playbook.agent_id,
    ok: summary.fail === 0,
    summary,
    results,
  };
}

export function loadDefaultPlaybookEvalSuite() {
  const loaded = loadTenantPlaybook(DEFAULT_PLAYBOOK_FILENAME);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error, errors: loaded.errors ?? null };
  }
  return { ok: true, playbook: loaded.playbook, path: loaded.path };
}

/** Privacy-safe JSON snapshot for regression storage (no caller text). */
export function formatEvalSuiteSnapshot(suiteResult) {
  return JSON.stringify({
    playbook_version: suiteResult.playbook_version,
    tenant_id: suiteResult.tenant_id,
    agent_id: suiteResult.agent_id,
    ok: suiteResult.ok,
    summary: suiteResult.summary,
    results: (suiteResult.results ?? []).map(({ id, category, status, reason, runtime_mode, response_type, plan_reason, caller_chars, response_chars, question_count }) => ({
      id,
      category,
      status,
      reason,
      runtime_mode,
      response_type,
      plan_reason,
      caller_chars,
      response_chars,
      question_count,
    })),
  });
}
