/**
 * Phase 10C — non-live eval harness: Agent Behavior Decision vs actual v4 planner.
 *
 * Compares resolveAgentBehaviorDecision() output to planner/orchestrator results.
 * Does not change runtime behavior; mismatches are documented for Phase 10D.
 */

import { loadConfig } from "../config.js";
import { loadAgentConfig } from "./agent-config.js";
import { loadTenantPlaybook, DEFAULT_PLAYBOOK_FILENAME } from "./playbook-loader.js";
import { resolveAgentBehaviorDecision, BEHAVIOR_PRIORITIES } from "./agent-behavior-decision.js";
import { resolveCallbackFlowState } from "./callback-flow-policy.js";
import { isContactFormHandoffRuntimeEnabled } from "./contact-form-handoff-policy.js";
import {
  applyMemoryPatch,
  RESPONSE_TYPES,
  detectTranscriptIntent,
} from "./response-planner.js";
import {
  createDialogueOrchestrator,
  startTurn,
  acceptUserTranscript,
  decideNextAction,
} from "./dialogue-orchestrator.js";
import { createRuntimeContext } from "./runtime-context.js";
import { createQualityEventSink } from "./quality-event-sink.js";
import {
  createCallSessionMemory,
  setSelectedProduct,
} from "./call-session-memory.js";
import { V4_STATES } from "./state-machine.js";

export const DECISION_EVAL_PENDING_STATUS = "pending";
export const DECISION_EVAL_PENDING_REASON = "no_runtime_consumer_for_decision_alignment";

/** Planner response types that satisfy a callback_flow decision. */
export const CALLBACK_FLOW_ACTUAL_RESPONSE_TYPES = new Set([
  RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE,
  RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION,
  RESPONSE_TYPES.REQUEST_PHONE_ONCE,
  RESPONSE_TYPES.CALLBACK_FINALIZED,
  RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW,
  RESPONSE_TYPES.CALLBACK_REASSURANCE,
  RESPONSE_TYPES.CALLBACK_PERMISSION_DENIED,
  RESPONSE_TYPES.EMAIL_GUIDANCE,
]);

/**
 * Synthetic decision-vs-planner scenarios (privacy-safe ids/categories only in snapshots).
 * `setupTurns` replays prior transcript turns before evaluating `caller`.
 */
export const DECISION_EVAL_SCENARIOS = [
  {
    id: "closing_after_product_answer",
    category: "closing",
    caller: "Danke, das reicht erstmal.",
    buildMemory: (base) => ({
      ...setSelectedProduct(base, "smart_website"),
      current_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
    }),
    expected_decision_priority: BEHAVIOR_PRIORITIES.CLOSING,
  },
  {
    id: "callback_request_after_product_answer",
    category: "callback",
    setupTurns: ["Was ist Smart Website, was macht sie und was kostet sie?"],
    caller: "Bitte rufen Sie mich zurück.",
    expected_decision_priority: BEHAVIOR_PRIORITIES.CALLBACK_FLOW,
  },
  {
    id: "callback_permission_continuation",
    category: "callback",
    caller: "Ja.",
    buildMemory: (base) => ({
      ...setSelectedProduct(base, "smart_website"),
      contact_preference: "phone",
      contact_flow_pending: true,
      current_state: V4_STATES.COLLECTING_CALLBACK_PERMISSION,
      callback_flow_state: "callback_permission_pending",
    }),
    callerPhoneNormalized: "+4915112345678",
    expected_decision_priority: BEHAVIOR_PRIORITIES.CALLBACK_FLOW,
  },
  {
    id: "callback_attention_reassurance",
    category: "callback",
    caller: "Hallo?",
    buildMemory: (base) => ({
      ...base,
      selected_product_id: "smart_website",
      callback_permission: "granted",
      contact_preference: "phone",
      callback_flow_state: "callback_finalized",
      current_state: V4_STATES.LISTENING,
    }),
    expected_decision_priority: BEHAVIOR_PRIORITIES.CALLBACK_FLOW,
  },
  {
    id: "out_of_scope_general_question",
    category: "out_of_scope",
    caller: "Wer hat die Relativitätstheorie entwickelt?",
    expected_decision_priority: BEHAVIOR_PRIORITIES.ROLE_BOUNDARY,
  },
  {
    id: "technical_escalation",
    category: "technical_escalation",
    caller: "Können Sie LokalKI mit unserem SAP-System über eine eigene Middleware verbinden?",
    expected_decision_priority: BEHAVIOR_PRIORITIES.ROLE_BOUNDARY,
  },
  {
    id: "explicit_product_question",
    category: "product_question",
    caller: "Was ist Smart Website?",
    buildMemory: (base) => setSelectedProduct(base, "smart_website"),
    expected_decision_priority: BEHAVIOR_PRIORITIES.EXPLICIT_PRODUCT_QUESTION,
  },
  {
    id: "product_context_continuation",
    category: "product_continuation",
    caller: "Und was kostet sie nochmal?",
    buildMemory: (base) => ({
      ...setSelectedProduct(base, "smart_website"),
      current_state: V4_STATES.LISTENING,
      product_answered: true,
    }),
    forcedIntent: "scoped_product_qa",
    expected_decision_priority: BEHAVIOR_PRIORITIES.PRODUCT_CONTEXT_CONTINUATION,
  },
  {
    id: "questionnaire_eligible_after_product_answer",
    category: "questionnaire",
    caller: "Was ist Smart Website?",
    questionnaireRuntime: true,
    behaviorDecisionEnabled: true,
    expected_decision_priority: BEHAVIOR_PRIORITIES.EXPLICIT_PRODUCT_QUESTION,
  },
  {
    id: "fallback_unclear",
    category: "fallback",
    caller: "blub gnarf zwirbel",
    forcedIntent: "unclear",
    expected_decision_priority: BEHAVIOR_PRIORITIES.FALLBACK,
  },
  {
    id: "contact_form_handoff",
    category: "contact_form_handoff",
    caller: "Ich gebe Ihnen meine Website und E-Mail durch.",
    contactFormHandoffEnabled: true,
    expected_decision_priority: BEHAVIOR_PRIORITIES.CONTACT_FORM_HANDOFF,
  },
  {
    id: "no_email_capture_by_voice",
    category: "voice_capture_restriction",
    caller: "Soll ich Ihnen meine E-Mail-Adresse durchgeben?",
    contactFormHandoffEnabled: true,
    expected_decision_priority: BEHAVIOR_PRIORITIES.CONTACT_FORM_HANDOFF,
  },
  {
    id: "no_website_url_capture_by_voice",
    category: "voice_capture_restriction",
    caller: "Ich kann Ihnen die Website-Adresse am Telefon vorlesen.",
    contactFormHandoffEnabled: true,
    expected_decision_priority: BEHAVIOR_PRIORITIES.CONTACT_FORM_HANDOFF,
  },
];

function buildScenarioMemory(scenario, bridgeCallId) {
  const base = createCallSessionMemory({ bridgeCallId: `decision-eval-${scenario.id}` });
  if (typeof scenario.buildMemory === "function") {
    return scenario.buildMemory(base);
  }
  return { ...base, current_state: V4_STATES.LISTENING };
}

function mergeConfig(scenario, config) {
  const base = config ?? loadConfig();
  if (
    !scenario.questionnaireRuntime &&
    !scenario.behaviorDecisionEnabled &&
    !scenario.contactFormHandoffEnabled
  ) {
    return base;
  }
  const v4 = { ...base.v4 };
  if (scenario.questionnaireRuntime) {
    v4.questionnaireRuntimeEnabled = true;
  }
  if (scenario.behaviorDecisionEnabled) {
    v4.agentBehaviorDecisionEnabled = true;
  }
  if (scenario.contactFormHandoffEnabled) {
    v4.contactFormHandoffEnabled = true;
  }
  return { ...base, v4 };
}

export function responseTypesAligned(decisionType, actualType, decisionPriority) {
  if (!decisionType || !actualType) return false;
  if (decisionType === actualType) return true;
  if (decisionPriority === BEHAVIOR_PRIORITIES.CALLBACK_FLOW && CALLBACK_FLOW_ACTUAL_RESPONSE_TYPES.has(actualType)) {
    return true;
  }
  if (
    (decisionPriority === BEHAVIOR_PRIORITIES.EXPLICIT_PRODUCT_QUESTION ||
      decisionPriority === BEHAVIOR_PRIORITIES.PRODUCT_CONTEXT_CONTINUATION ||
      decisionPriority === BEHAVIOR_PRIORITIES.QUESTIONNAIRE) &&
    actualType === RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER
  ) {
    return true;
  }
  if (decisionPriority === BEHAVIOR_PRIORITIES.ROLE_BOUNDARY) {
    return (
      actualType === RESPONSE_TYPES.ROLE_BOUNDARY_REDIRECT ||
      actualType === RESPONSE_TYPES.TECHNICAL_ESCALATION
    );
  }
  if (
    decisionPriority === BEHAVIOR_PRIORITIES.CONTACT_FORM_HANDOFF &&
    actualType === RESPONSE_TYPES.CONTACT_FORM_HANDOFF
  ) {
    return true;
  }
  if (decisionPriority === BEHAVIOR_PRIORITIES.CLOSING && actualType === RESPONSE_TYPES.CLOSING) {
    return true;
  }
  if (
    decisionPriority === BEHAVIOR_PRIORITIES.FALLBACK &&
    actualType === RESPONSE_TYPES.FALLBACK_CLARIFICATION
  ) {
    return true;
  }
  return false;
}

export function compareDecisionToActual(decision, actual = {}, scenario = {}) {
  const failures = [];
  const plan = actual.plan ?? {};
  const decisionType = decision?.response_type ?? null;
  const actualType = plan.response_type ?? null;
  const decisionPriority = decision?.priority ?? null;

  if (scenario.expected_decision_priority && decisionPriority !== scenario.expected_decision_priority) {
    failures.push(`decision_priority:${decisionPriority}!=${scenario.expected_decision_priority}`);
  }

  if (!responseTypesAligned(decisionType, actualType, decisionPriority)) {
    failures.push(`response_type:${decisionType}!=${actualType}`);
  }

  const actualRagUsed = Boolean(actual.ragResult?.used_rag);
  const actualQuestionnaireUsed = Boolean(plan.questionnaire?.used);

  if (decision?.rag_allowed === false && actualRagUsed) {
    failures.push("rag_used_when_decision_disallows");
  }
  if (decision?.questionnaire_allowed === false && actualQuestionnaireUsed) {
    failures.push("questionnaire_used_when_decision_disallows");
  }

  return failures;
}

async function runSetupTurns(orchestrator, setupTurns = []) {
  let lastAction = null;
  for (const transcript of setupTurns) {
    startTurn(orchestrator);
    acceptUserTranscript(orchestrator, transcript);
    lastAction = await decideNextAction(orchestrator, { transcript });
    orchestrator.memory = applyMemoryPatch(orchestrator.memory, lastAction.plan?.memory_patch ?? {});
    orchestrator.memory = {
      ...orchestrator.memory,
      current_state: V4_STATES.SPEAKING,
    };
    orchestrator.stateMachine = {
      state: lastAction.plan?.next_state ?? V4_STATES.LISTENING,
    };
    orchestrator.lastAssistantText = lastAction.plan?.text ?? orchestrator.lastAssistantText;
  }
  return lastAction;
}

export async function runDecisionEvalScenario({
  scenario,
  playbook = null,
  config = null,
  agentConfig = null,
} = {}) {
  const baseResult = {
    scenario_id: scenario?.id ?? null,
    category: scenario?.category ?? null,
    caller_chars: String(scenario?.caller ?? "").length,
    playbook_version: playbook?.playbook_version ?? null,
    status: "fail",
    failures: [],
  };

  if (!scenario?.id) {
    return { ...baseResult, failures: ["scenario_missing_id"] };
  }

  if (scenario.pending) {
    return {
      ...baseResult,
      status: DECISION_EVAL_PENDING_STATUS,
      failures: [],
      reason: scenario.pending_reason ?? DECISION_EVAL_PENDING_REASON,
    };
  }

  const resolvedConfig = mergeConfig(scenario, config);
  const resolvedAgent = agentConfig ?? loadAgentConfig(resolvedConfig);
  const resolvedPlaybook =
    playbook ??
    (loadTenantPlaybook(DEFAULT_PLAYBOOK_FILENAME).ok
      ? loadTenantPlaybook(DEFAULT_PLAYBOOK_FILENAME).playbook
      : null);

  const memory = buildScenarioMemory(scenario, scenario.id);
  const orchestrator = createDialogueOrchestrator({
    config: resolvedConfig,
    runtimeContext: createRuntimeContext(resolvedConfig, {
      bridgeCallId: `decision-eval-${scenario.id}`,
    }),
    memory,
    stateMachine: { state: memory.current_state ?? V4_STATES.LISTENING },
    agentConfig: resolvedAgent,
    adapters: {
      ragRetriever: async () => ({ ok: true, hit: false, hitCount: 0 }),
    },
    qualitySink: createQualityEventSink({ v4PathActive: true }),
    v4PathActive: true,
    callerPhoneNormalized: scenario.callerPhoneNormalized ?? null,
  });

  if (Array.isArray(scenario.setupTurns) && scenario.setupTurns.length > 0) {
    await runSetupTurns(orchestrator, scenario.setupTurns);
  }

  startTurn(orchestrator);
  acceptUserTranscript(orchestrator, scenario.caller);
  const action = await decideNextAction(orchestrator, { transcript: scenario.caller });
  const contactFormHandoffEnabled = isContactFormHandoffRuntimeEnabled(
    resolvedConfig,
    true
  );
  const intent =
    scenario.forcedIntent ??
    action.intent ??
    orchestrator.lastResolvedIntent ??
    detectTranscriptIntent(
      scenario.caller,
      orchestrator.memory,
      resolvedAgent,
      null,
      contactFormHandoffEnabled
    );

  const decision = resolveAgentBehaviorDecision({
    transcript: scenario.caller,
    memory: orchestrator.memory,
    state: orchestrator.stateMachine?.state ?? memory.current_state,
    playbook: resolvedPlaybook,
    config: resolvedConfig,
    intent,
    productContext: {
      product_id:
        orchestrator.memory?.selected_product_id ??
        orchestrator.memory?.current_product_context ??
        null,
    },
    callbackFlowState: resolveCallbackFlowState(orchestrator.memory),
    roleBoundaryIntent:
      intent === "out_of_scope" || intent === "technical_escalation" ? intent : null,
    closingIntent: intent === "closing",
    productAnswered: orchestrator.memory?.product_answered === true,
    pricingAnswered: orchestrator.memory?.pricing_answered === true,
    questionnaireEligible: Boolean(action.plan?.questionnaire?.used),
  });

  const failures = compareDecisionToActual(
    decision,
    {
      plan: action.plan,
      ragResult: action.ragResult,
      ragGate: action.ragGate,
      intent,
      next_state: action.plan?.next_state ?? null,
      plan_reason: action.plan?.plan_reason ?? null,
    },
    scenario
  );

  return {
    scenario_id: scenario.id,
    category: scenario.category,
    caller_chars: String(scenario.caller ?? "").length,
    playbook_version: decision.playbook_version ?? resolvedPlaybook?.playbook_version ?? null,
    decision_priority: decision.priority ?? null,
    decision_response_type: decision.response_type ?? null,
    decision_rag_allowed: Boolean(decision.rag_allowed),
    decision_questionnaire_allowed: Boolean(decision.questionnaire_allowed),
    decision_lead_tier: decision.lead_tier ?? null,
    decision_next_action: decision.next_action ?? null,
    decision_reason: decision.reason ?? null,
    decision_suppressed_intents: decision.suppressed_intents ?? [],
    actual_response_type: action.plan?.response_type ?? null,
    actual_plan_reason: action.plan?.plan_reason ?? null,
    actual_rag_allowed: Boolean(action.plan?.rag_allowed),
    actual_rag_used: Boolean(action.ragResult?.used_rag),
    actual_rag_fallback_used: Boolean(action.plan?.rag_fallback_used),
    actual_questionnaire_used: Boolean(action.plan?.questionnaire?.used),
    actual_next_state: action.plan?.next_state ?? null,
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    known_mismatch: scenario.known_mismatch ?? null,
  };
}

export async function runDecisionEvalSuite({
  scenarios = DECISION_EVAL_SCENARIOS,
  playbook = null,
  config = null,
  agentConfig = null,
} = {}) {
  const loaded =
    playbook ??
    (loadTenantPlaybook(DEFAULT_PLAYBOOK_FILENAME).ok
      ? loadTenantPlaybook(DEFAULT_PLAYBOOK_FILENAME).playbook
      : null);

  const results = [];
  for (const scenario of scenarios) {
    results.push(
      await runDecisionEvalScenario({
        scenario,
        playbook: loaded,
        config,
        agentConfig,
      })
    );
  }

  const summary = {
    total: results.length,
    pass: results.filter((entry) => entry.status === "pass").length,
    fail: results.filter((entry) => entry.status === "fail").length,
    pending: results.filter((entry) => entry.status === DECISION_EVAL_PENDING_STATUS).length,
  };

  return {
    playbook_version: loaded?.playbook_version ?? null,
    ok: summary.fail === 0,
    summary,
    results,
  };
}

/** Privacy-safe JSON snapshot (no caller text). */
export function formatDecisionEvalSnapshot(suiteResult = {}) {
  return JSON.stringify({
    playbook_version: suiteResult.playbook_version ?? null,
    ok: suiteResult.ok ?? false,
    summary: suiteResult.summary ?? { total: 0, pass: 0, fail: 0, pending: 0 },
    results: (suiteResult.results ?? []).map(
      ({
        scenario_id,
        category,
        caller_chars,
        decision_priority,
        decision_response_type,
        actual_response_type,
        decision_rag_allowed,
        actual_rag_used,
        decision_questionnaire_allowed,
        actual_questionnaire_used,
        status,
        failures,
        known_mismatch,
      }) => ({
        scenario_id,
        category,
        caller_chars,
        decision_priority,
        decision_response_type,
        actual_response_type,
        decision_rag_allowed,
        actual_rag_used,
        decision_questionnaire_allowed,
        actual_questionnaire_used,
        status,
        failures,
        known_mismatch,
      })
    ),
  });
}

export function summarizeDecisionEvalMismatches(suiteResult = {}) {
  return (suiteResult.results ?? [])
    .filter((entry) => entry.status === "fail")
    .map((entry) => ({
      scenario_id: entry.scenario_id,
      failures: entry.failures,
      decision_response_type: entry.decision_response_type,
      actual_response_type: entry.actual_response_type,
    }));
}
