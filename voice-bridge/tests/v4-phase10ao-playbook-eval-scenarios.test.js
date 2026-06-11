import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import {
  resolveBehaviorPolicy,
  HARDCODED_BEHAVIOR_DEFAULTS,
  getClosingResponse,
} from "../src/v4/behavior-policy.js";
import { CLOSING_RESPONSE_TEXT } from "../src/v4/closing-intent.js";
import { loadTenantPlaybook } from "../src/v4/playbook-loader.js";
import {
  loadPlaybookEvalScenarios,
  validatePlaybookEvalScenarios,
  runPlaybookEvalSuite,
  runEvalScenario,
  loadDefaultPlaybookEvalSuite,
  formatEvalSuiteSnapshot,
  REQUIRED_EVAL_SCENARIO_CATEGORIES,
  RUNTIME_PENDING_EVAL_CATEGORIES,
} from "../src/v4/playbook-eval-scenarios.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";

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

test("10AO: playbook eval scenarios load and validate", () => {
  const loaded = loadTenantPlaybook();
  assert.equal(loaded.ok, true);
  const scenarios = loadPlaybookEvalScenarios(loaded.playbook);
  assert.ok(scenarios.length >= 9);
  const validation = validatePlaybookEvalScenarios(loaded.playbook);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  for (const category of REQUIRED_EVAL_SCENARIO_CATEGORIES) {
    assert.ok(
      scenarios.some((scenario) => scenario.category === category),
      `missing category ${category}`
    );
  }
});

test("10AO: implemented scenarios pass through planner/orchestrator harness", async () => {
  const loaded = loadDefaultPlaybookEvalSuite();
  assert.equal(loaded.ok, true);
  const suite = await runPlaybookEvalSuite({ playbook: loaded.playbook });
  assert.equal(suite.playbook_version, loaded.playbook.playbook_version);
  assert.equal(suite.ok, true);
  assert.equal(suite.summary.fail, 0);
  assert.ok(suite.summary.pass >= 9, "expected all core playbook eval scenarios to pass");

  const closing = suite.results.find((entry) => entry.id === "closing_after_product_answer");
  assert.equal(closing.status, "pass");
  assert.equal(closing.response_type, RESPONSE_TYPES.CLOSING);
  assert.equal(closing.plan_reason, "closing_intent");

  const pricing = suite.results.find((entry) => entry.id === "pricing_question_smart_website");
  assert.equal(pricing.status, "pass");
  assert.equal(pricing.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);

  const fallback = suite.results.find((entry) => entry.id === "fallback_clarification_unclear");
  assert.equal(fallback.status, "pass");
  assert.equal(fallback.response_type, RESPONSE_TYPES.FALLBACK_CLARIFICATION);
});

test("10AO: role boundary scenarios pass through planner/orchestrator harness (Phase 10AP)", async () => {
  const loaded = loadDefaultPlaybookEvalSuite();
  const suite = await runPlaybookEvalSuite({ playbook: loaded.playbook });
  // Phase 9: documentation-only categories may report pending; runtime-implemented
  // categories (incl. all role-boundary scenarios) must never be pending.
  for (const entry of suite.results.filter((result) => result.status === "pending")) {
    assert.ok(
      RUNTIME_PENDING_EVAL_CATEGORIES.has(entry.category),
      `unexpected pending category: ${entry.category}`
    );
  }
  for (const id of ["out_of_scope_general_question", "technical_escalation", "callback_request"]) {
    const entry = suite.results.find((result) => result.id === id);
    assert.ok(entry, id);
    assert.equal(entry.status, "pass", id);
    assert.notEqual(entry.runtime_mode, "documentation_only");
  }
  const outOfScope = suite.results.find((entry) => entry.id === "out_of_scope_general_question");
  assert.equal(outOfScope.response_type, RESPONSE_TYPES.ROLE_BOUNDARY_REDIRECT);
  const technical = suite.results.find((entry) => entry.id === "technical_escalation");
  assert.equal(technical.response_type, RESPONSE_TYPES.TECHNICAL_ESCALATION);
  const callback = suite.results.find((entry) => entry.id === "callback_request");
  assert.equal(callback.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
});

test("10AO: eval snapshot is keyed by playbook_version and contains no raw caller text", async () => {
  const loaded = loadDefaultPlaybookEvalSuite();
  const suite = await runPlaybookEvalSuite({ playbook: loaded.playbook });
  const snapshot = JSON.parse(formatEvalSuiteSnapshot(suite));
  assert.equal(snapshot.playbook_version, loaded.playbook.playbook_version);
  assert.equal(snapshot.tenant_id, "technolohit");
  assert.equal(snapshot.agent_id, "main_voice_sales");
  assert.ok(snapshot.summary.total >= 9);

  const serialized = JSON.stringify(snapshot);
  for (const scenario of loaded.playbook.eval_scenarios) {
    assert.equal(serialized.includes(scenario.caller), false, `leaked caller: ${scenario.id}`);
  }
  assert.equal(/\+\d{7,}/.test(serialized), false);
  assert.equal(/@\w+\.\w+/.test(serialized), false);
  assert.equal(serialized.includes("transcript"), false);
});

test("10AO: draft playbook remains rejected for runtime without explicit override", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const policy = resolveBehaviorPolicy({ config: loadConfig() });
    assert.equal(policy.source, "hardcoded_default");
    assert.equal(policy.reason, "draft_playbook_not_allowed");
  });
});

test("10AO: default behavior remains equivalent to hardcoded 10AK/10AN behavior", () => {
  const config = loadConfig();
  assert.equal(config.v4.playbookRuntimeEnabled, false);
  const policy = resolveBehaviorPolicy({ config });
  assert.equal(getClosingResponse(policy), CLOSING_RESPONSE_TEXT);

  const agent = loadAgentConfig(config);
  const withoutPolicy = buildResponsePlan({
    agentConfig: agent,
    memory: { selected_product_id: "smart_website", current_state: "listening" },
    stateMachine: { state: "listening" },
    transcript: "Danke, das reicht erstmal.",
  });
  const withPolicy = buildResponsePlan({
    agentConfig: agent,
    memory: { selected_product_id: "smart_website", current_state: "listening" },
    stateMachine: { state: "listening" },
    transcript: "Danke, das reicht erstmal.",
    behaviorPolicy: policy,
  });
  assert.deepEqual(withPolicy, withoutPolicy);
  assert.equal(
    withPolicy.text,
    HARDCODED_BEHAVIOR_DEFAULTS.closing_response
  );
});

test("10AO: v3 default route remains unchanged", () => {
  const config = loadConfig();
  assert.equal(config.v4.runtimeVersion, "v3");
  assert.equal(config.v4.playbookRuntimeEnabled, false);
  assert.equal(config.v4.playbookPath, "");
  assert.equal(config.v4.playbookAllowDraft, false);
  assert.equal(config.rag?.enabled ?? false, false);
});

test("10AO: injected playbook closing phrase is recognized only when opted in", async () => {
  const injected = {
    ...loadTenantPlaybook().playbook,
    status: "published",
    runtime_binding: { active: true },
    approval: { approved_for_runtime: true },
    closing_policy: {
      phrases: ["Wir sind fertig für heute."],
      response: "Bis bald und vielen Dank.",
    },
  };
  const configOn = { v4: { playbookRuntimeEnabled: true } };
  const policy = resolveBehaviorPolicy({ config: configOn, playbook: injected });
  assert.equal(policy.source, "playbook");

  const result = await runEvalScenario({
    scenario: {
      id: "custom_closing",
      category: "closing",
      caller: "Wir sind fertig für heute.",
      expected: { response_type: "closing", response: "Bis bald und vielen Dank." },
    },
    config: configOn,
    behaviorPolicy: policy,
    playbook: injected,
    useOrchestrator: true,
  });
  assert.equal(result.status, "pass");
  assert.equal(result.response_type, RESPONSE_TYPES.CLOSING);
});
