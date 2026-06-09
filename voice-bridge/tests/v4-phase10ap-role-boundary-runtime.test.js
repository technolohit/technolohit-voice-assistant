import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import {
  resolveBehaviorPolicy,
  HARDCODED_BEHAVIOR_DEFAULTS,
  getOutOfScopeRedirect,
  getTechnicalEscalationResponse,
  getCallbackLeadCaptureResponse,
} from "../src/v4/behavior-policy.js";
import {
  isOutOfScopeGeneralQuestion,
  isTechnicalEscalationQuestion,
  isCallbackLeadCaptureRequest,
} from "../src/v4/role-boundary-intent.js";
import { detectTranscriptIntent } from "../src/v4/transcript-intent.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { shouldUseRagForTurn } from "../src/v4/rag-orchestrator.js";
import {
  runPlaybookEvalSuite,
  loadDefaultPlaybookEvalSuite,
  formatEvalSuiteSnapshot,
  runEvalScenario,
} from "../src/v4/playbook-eval-scenarios.js";
import { loadTenantPlaybook } from "../src/v4/playbook-loader.js";

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const finish = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result?.then) return result.finally(finish);
    finish();
    return result;
  } catch (err) {
    finish();
    throw err;
  }
}

function basePlanArgs(transcript, overrides = {}) {
  const config = loadConfig();
  const agentConfig = loadAgentConfig(config);
  const policy = resolveBehaviorPolicy({ config });
  return {
    agentConfig,
    memory: { current_state: "listening" },
    stateMachine: { state: "listening" },
    transcript,
    behaviorPolicy: policy,
    ragGate: { allowed: false },
    ...overrides,
  };
}

test("10AP: out-of-scope general question returns redirect without RAG or lead", () => {
  const transcript = "Wer hat die Relativitätstheorie entwickelt?";
  const config = loadConfig();
  const agent = loadAgentConfig(config);
  assert.equal(isOutOfScopeGeneralQuestion(transcript, agent), true);
  assert.equal(detectTranscriptIntent(transcript, {}, agent), "out_of_scope");

  const plan = buildResponsePlan(basePlanArgs(transcript));
  assert.equal(plan.response_type, RESPONSE_TYPES.ROLE_BOUNDARY_REDIRECT);
  assert.equal(plan.plan_reason, "out_of_scope_redirect");
  assert.equal(plan.rag_allowed, false);
  assert.equal(plan.lead_transition_allowed, false);
  assert.match(plan.text, /keine verlässliche Beratung/i);
  assert.doesNotMatch(plan.text, /einstein|relativit[aä]t/i);

  const ragGate = shouldUseRagForTurn({
    intent: "out_of_scope",
    transcript,
    memory: {},
  });
  assert.equal(ragGate.allowed, false);
});

test("10AP: technical feasibility question returns escalation without overpromise", () => {
  const transcript =
    "Können Sie LokalKI mit unserem SAP-System über eine eigene Middleware verbinden?";
  const config = loadConfig();
  const agent = loadAgentConfig(config);
  assert.equal(isTechnicalEscalationQuestion(transcript, agent), true);
  assert.equal(detectTranscriptIntent(transcript, {}, agent), "technical_escalation");

  const plan = buildResponsePlan(basePlanArgs(transcript));
  assert.equal(plan.response_type, RESPONSE_TYPES.TECHNICAL_ESCALATION);
  assert.equal(plan.plan_reason, "technical_escalation");
  assert.match(plan.text, /nicht falsch beantworten/i);
  assert.equal(plan.lead_transition_allowed, false);
  assert.doesNotMatch(plan.text, /\b(garantiert|problemlos|100\s*%)\b/i);
});

test("10AP: callback request enters safe lead-capture path without bypassing validator", () => {
  const transcript = "Können Sie mich zurückrufen lassen?";
  assert.equal(isCallbackLeadCaptureRequest(transcript), true);
  assert.equal(detectTranscriptIntent(transcript), "callback_request");

  const plan = buildResponsePlan(basePlanArgs(transcript));
  assert.equal(plan.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
  assert.equal(plan.plan_reason, "callback_request_intent");
  assert.equal(plan.lead_transition_allowed, false);
  assert.doesNotMatch(plan.text, /\b(sofort verbinden|jetzt weiterleiten|live transfer)\b/i);
});

test("10AP: explicit callback request with phone wording is not shadowed by contact preference", () => {
  const transcript = "Bitte rufen Sie mich telefonisch zurueck.";
  assert.equal(isCallbackLeadCaptureRequest(transcript), true);
  assert.equal(detectTranscriptIntent(transcript), "callback_request");

  const plan = buildResponsePlan(basePlanArgs(transcript));
  assert.equal(plan.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
  assert.equal(plan.plan_reason, "callback_request_intent");
  assert.equal(plan.lead_transition_allowed, false);

  assert.equal(
    detectTranscriptIntent("telefonisch", { current_state: "collecting_contact_preference" }),
    "contact_phone"
  );
});

test("10AP: callback request wins over known product context and scoped product QA", () => {
  const transcript = "Bitte rufen Sie mich telefonisch zurueck.";
  const memory = {
    current_state: "answering_product_question",
    selected_product_id: "smart_website",
    current_product_context: "smart_website",
  };

  assert.equal(detectTranscriptIntent(transcript, memory), "callback_request");

  const plan = buildResponsePlan(basePlanArgs(transcript, {
    memory,
    stateMachine: { state: "answering_product_question" },
    v4PathActive: true,
    ragGate: { allowed: true, used_rag: false },
  }));

  assert.equal(plan.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
  assert.equal(plan.plan_reason, "callback_request_intent");
  assert.equal(plan.rag_allowed, false);
  assert.equal(plan.lead_transition_allowed, false);
  assert.notEqual(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
});

test("10AP: callback request after interruption wins over interrupt scoped product QA", () => {
  const transcript = "Stopp. Bitte rufen Sie mich telefonisch zurueck.";
  const memory = {
    current_state: "answering_product_question",
    selected_product_id: "smart_website",
    current_product_context: "smart_website",
    interruption_context: {
      interrupted_product_id: "smart_website",
      cancellation_reason: "inbound_speech_detected",
    },
  };

  assert.equal(detectTranscriptIntent(transcript, memory), "callback_request");

  const plan = buildResponsePlan(basePlanArgs(transcript, {
    memory,
    stateMachine: { state: "answering_product_question" },
    interruptionRecovery: { recoveryAction: "product_question", context: memory.interruption_context },
    v4PathActive: true,
    ragGate: { allowed: true, used_rag: false },
  }));

  assert.equal(plan.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
  assert.equal(plan.plan_reason, "callback_request_intent");
  assert.equal(plan.rag_allowed, false);
});

test("10AP: closing overrides out-of-scope, technical escalation, and callback paths", () => {
  const agent = loadAgentConfig(loadConfig());
  const closing = "Danke, das reicht erstmal.";
  const scenarios = [
    { transcript: `${closing} Wer hat die Relativitätstheorie entwickelt?`, intent: "closing" },
    {
      transcript: `${closing} Können Sie LokalKI mit SAP verbinden?`,
      intent: "closing",
    },
    { transcript: `${closing} Können Sie mich zurückrufen lassen?`, intent: "closing" },
  ];
  for (const { transcript, intent } of scenarios) {
    assert.equal(detectTranscriptIntent(transcript, {}, agent), intent);
    const plan = buildResponsePlan(basePlanArgs(transcript));
    assert.equal(plan.response_type, RESPONSE_TYPES.CLOSING);
    assert.equal(plan.plan_reason, "closing_intent");
  }
});

test("10AP: playbook policy text applies only when runtime policy is opted in", () => {
  const injected = {
    ...loadTenantPlaybook().playbook,
    status: "published",
    runtime_binding: { active: true },
    approval: { approved_for_runtime: true },
    escalation_policy: {
      out_of_scope_redirect: "Custom out-of-scope redirect text.",
      uncertain_or_technical: "Custom technical escalation text.",
    },
    lead_capture_policy: {
      preferred_wording: "Custom callback lead capture wording.",
    },
  };
  const configOn = { v4: { playbookRuntimeEnabled: true } };
  const policy = resolveBehaviorPolicy({ config: configOn, playbook: injected });
  assert.equal(policy.source, "playbook");
  assert.equal(getOutOfScopeRedirect(policy), "Custom out-of-scope redirect text.");
  assert.equal(getTechnicalEscalationResponse(policy), "Custom technical escalation text.");
  assert.equal(getCallbackLeadCaptureResponse(policy), "Custom callback lead capture wording. Möchten Sie telefonisch oder per E-Mail starten?");

  const configOff = loadConfig();
  const defaultPolicy = resolveBehaviorPolicy({ config: configOff });
  assert.equal(defaultPolicy.source, "hardcoded_default");
  assert.equal(
    getOutOfScopeRedirect(defaultPolicy),
    HARDCODED_BEHAVIOR_DEFAULTS.out_of_scope_redirect
  );
});

test("10AP: default hardcoded behavior remains equivalent with playbook runtime flag off", () => {
  const config = loadConfig();
  assert.equal(config.v4.playbookRuntimeEnabled, false);
  const agent = loadAgentConfig(config);
  const policy = resolveBehaviorPolicy({ config });
  const transcript = "Wer hat die Relativitätstheorie entwickelt?";

  const withoutPolicy = buildResponsePlan({
    agentConfig: agent,
    memory: { current_state: "listening" },
    stateMachine: { state: "listening" },
    transcript,
  });
  const withPolicy = buildResponsePlan({
    agentConfig: agent,
    memory: { current_state: "listening" },
    stateMachine: { state: "listening" },
    transcript,
    behaviorPolicy: policy,
  });
  assert.deepEqual(withPolicy, withoutPolicy);
  assert.equal(withPolicy.text, HARDCODED_BEHAVIOR_DEFAULTS.out_of_scope_redirect);
});

test("10AP: eval snapshot contains no raw caller text or PII", async () => {
  const loaded = loadDefaultPlaybookEvalSuite();
  const suite = await runPlaybookEvalSuite({ playbook: loaded.playbook });
  const snapshot = JSON.parse(formatEvalSuiteSnapshot(suite));
  const serialized = JSON.stringify(snapshot);
  for (const scenario of loaded.playbook.eval_scenarios) {
    assert.equal(serialized.includes(scenario.caller), false, `leaked caller: ${scenario.id}`);
  }
  assert.equal(/\+\d{7,}/.test(serialized), false);
  assert.equal(/@\w+\.\w+/.test(serialized), false);
  assert.equal(serialized.includes("transcript"), false);
});

test("10AP: playbook eval suite passes all nine scenarios including role boundary categories", async () => {
  const loaded = loadDefaultPlaybookEvalSuite();
  const suite = await runPlaybookEvalSuite({ playbook: loaded.playbook });
  assert.equal(suite.ok, true, JSON.stringify(suite.results.filter((r) => r.status !== "pass")));
  assert.equal(suite.summary.fail, 0);
  assert.equal(suite.summary.pending, 0);
  assert.equal(suite.summary.pass, suite.summary.total);

  for (const id of ["out_of_scope_general_question", "technical_escalation", "callback_request"]) {
    const entry = suite.results.find((result) => result.id === id);
    assert.equal(entry.status, "pass", id);
    assert.notEqual(entry.runtime_mode, "documentation_only");
  }
});

test("10AP: v3 default route and production flags remain unchanged", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.v4.runtimeVersion, "v3");
    assert.equal(config.v4.playbookRuntimeEnabled, false);
    assert.equal(config.v4.playbookPath, "");
    assert.equal(config.v4.playbookAllowDraft, false);
    assert.equal(config.rag?.enabled ?? false, false);
  });
});

test("10AP: orchestrator path handles out-of-scope redirect", async () => {
  const loaded = loadDefaultPlaybookEvalSuite();
  const scenario = loaded.playbook.eval_scenarios.find((s) => s.id === "out_of_scope_general_question");
  const result = await runEvalScenario({
    scenario,
    playbook: loaded.playbook,
    useOrchestrator: true,
  });
  assert.equal(result.status, "pass");
  assert.equal(result.runtime_mode, "orchestrator");
});
