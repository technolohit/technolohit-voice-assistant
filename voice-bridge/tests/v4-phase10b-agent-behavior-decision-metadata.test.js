/**
 * Phase 10B — Agent Behavior Decision metadata plumbing tests.
 * Observability only; must not change response plan behavior.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { loadTenantPlaybook } from "../src/v4/playbook-loader.js";
import { BEHAVIOR_PRIORITIES } from "../src/v4/agent-behavior-decision.js";
import {
  behaviorDecisionQualityPayload,
  buildAgentBehaviorDecisionMetadata,
  isAgentBehaviorDecisionEnabled,
  resetAgentBehaviorDecisionPlaybookCache,
} from "../src/v4/agent-behavior-decision-runtime.js";
import { CALLBACK_FLOW_STATES } from "../src/v4/callback-flow-policy.js";
import { RESPONSE_TYPES } from "../src/v4/response-planner.js";
import {
  createDialogueOrchestrator,
  startTurn,
  acceptUserTranscript,
  decideNextAction,
  commitAssistantPlanWithoutPlayback,
} from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { createQualityEventSink } from "../src/v4/quality-event-sink.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const finish = () => {
    resetAgentBehaviorDecisionPlaybookCache();
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

function decisionOnConfig() {
  const base = loadConfig();
  return {
    ...base,
    v4: { ...base.v4, agentBehaviorDecisionEnabled: true },
  };
}

async function runOrchestratorTurn({
  config,
  transcript,
  v4PathActive = true,
  memory = null,
} = {}) {
  const events = [];
  const resolvedConfig = config ?? decisionOnConfig();
  const orchestrator = createDialogueOrchestrator({
    config: resolvedConfig,
    runtimeContext: createRuntimeContext(resolvedConfig, { bridgeCallId: "qa-10b" }),
    memory:
      memory ??
      setSelectedProduct(createCallSessionMemory({ bridgeCallId: "qa-10b" }), "smart_website"),
    stateMachine: { state: "listening" },
    agentConfig: loadAgentConfig(resolvedConfig),
    qualitySink: createQualityEventSink({ v4PathActive }),
    v4PathActive,
  });
  const originalBuffer = orchestrator.qualitySink.bufferQualityEvent.bind(orchestrator.qualitySink);
  orchestrator.qualitySink.bufferQualityEvent = (event) => {
    events.push(event);
    return originalBuffer(event);
  };

  startTurn(orchestrator);
  acceptUserTranscript(orchestrator, transcript);
  const action = await decideNextAction(orchestrator, { transcript });
  commitAssistantPlanWithoutPlayback(orchestrator);

  return { action, events, orchestrator };
}

test("10B: agent behavior decision flag defaults off", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.v4.agentBehaviorDecisionEnabled, false);
    assert.equal(isAgentBehaviorDecisionEnabled(config), false);
  });
});

test("10B: flag off => no behavior_decision metadata on response_plan_created", async () => {
  await withEnv({ VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED: "false" }, async () => {
    const { events } = await runOrchestratorTurn({
      config: loadConfig(),
      transcript: "Was ist Smart Website?",
    });
    const planEvent = events.find((entry) => entry.eventType === "response_plan_created");
    assert.ok(planEvent);
    assert.equal(planEvent.payload.behavior_decision_enabled, undefined);
    assert.equal(planEvent.payload.behavior_decision_priority, undefined);
  });
});

test("10B: flag on => decision metadata attached to response_plan_created", async () => {
  await withEnv({ VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED: "true" }, async () => {
    const config = decisionOnConfig();
    const { events } = await runOrchestratorTurn({
      config,
      transcript: "Was ist Smart Website?",
    });
    const planEvent = events.find((entry) => entry.eventType === "response_plan_created");
    assert.ok(planEvent);
    assert.equal(planEvent.payload.behavior_decision_enabled, true);
    assert.equal(planEvent.payload.behavior_decision_ok, true);
    assert.equal(planEvent.payload.behavior_decision_priority, BEHAVIOR_PRIORITIES.EXPLICIT_PRODUCT_QUESTION);
    assert.equal(planEvent.payload.behavior_decision_playbook_valid, false);
    assert.equal(planEvent.payload.behavior_decision_playbook_version, null);
  });
});

test("10B: metadata does not change response text, type, or next action", async () => {
  await withEnv({ VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED: "true" }, async () => {
    const config = decisionOnConfig();
    const off = await runOrchestratorTurn({
      config: { ...loadConfig(), v4: { ...loadConfig().v4, agentBehaviorDecisionEnabled: false } },
      transcript: "Was ist Smart Website?",
    });
    const on = await runOrchestratorTurn({ config, transcript: "Was ist Smart Website?" });

    assert.equal(on.action.plan.response_type, off.action.plan.response_type);
    assert.equal(on.action.plan.text, off.action.plan.text);
    assert.equal(on.action.plan.next_state, off.action.plan.next_state);
    assert.equal(on.action.plan.plan_reason, off.action.plan.plan_reason);
  });
});

test("10B: closing turn metadata shows closing priority", async () => {
  await withEnv({ VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED: "true" }, async () => {
    const { events } = await runOrchestratorTurn({
      config: decisionOnConfig(),
      transcript: "Danke, das reicht erstmal.",
      memory: setSelectedProduct(createCallSessionMemory({ bridgeCallId: "qa-10b" }), "smart_website"),
    });
    const planEvent = events.find((entry) => entry.eventType === "response_plan_created");
    assert.equal(planEvent.payload.behavior_decision_priority, BEHAVIOR_PRIORITIES.CLOSING);
    assert.equal(planEvent.payload.behavior_decision_rag_allowed, false);
    assert.equal(planEvent.payload.behavior_decision_questionnaire_allowed, false);
    assert.equal(planEvent.payload.behavior_decision_response_type, RESPONSE_TYPES.CLOSING);
  });
});

test("10B: callback-flow metadata suppresses rag/questionnaire in metadata only", async () => {
  const metadata = buildAgentBehaviorDecisionMetadata({
    config: decisionOnConfig(),
    v4PathActive: true,
    transcript: "Ja.",
    memory: {
      callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING,
      selected_product_id: "smart_website",
    },
    intent: "callback_permission_granted",
    plan: {
      response_type: RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION,
      plan_reason: "callback_permission_granted",
    },
  });
  assert.equal(metadata.behavior_decision_priority, BEHAVIOR_PRIORITIES.CALLBACK_FLOW);
  assert.equal(metadata.behavior_decision_rag_allowed, false);
  assert.equal(metadata.behavior_decision_questionnaire_allowed, false);
});

test("10B: invalid playbook metadata fail-closed without throw", () => {
  const metadata = buildAgentBehaviorDecisionMetadata({
    config: decisionOnConfig(),
    v4PathActive: true,
    transcript: "Was ist Smart Website?",
    memory: { selected_product_id: "smart_website" },
    intent: "product_question",
    playbook: { playbook_version: "broken", products: [] },
  });
  assert.equal(metadata.behavior_decision_ok, true);
  assert.equal(metadata.behavior_decision_playbook_valid, false);
  assert.equal(metadata.behavior_decision_rag_allowed, false);
  assert.equal(metadata.behavior_decision_questionnaire_allowed, false);
  assert.match(metadata.behavior_decision_reason, /playbook_validation_failed/);
});

test("10B: missing playbook metadata fail-closed without throw", () => {
  const metadata = buildAgentBehaviorDecisionMetadata({
    config: decisionOnConfig(),
    v4PathActive: true,
    intent: "product_question",
    playbook: null,
  });
  assert.equal(metadata.behavior_decision_playbook_valid, false);
  assert.equal(metadata.behavior_decision_rag_allowed, false);
  assert.equal(metadata.behavior_decision_questionnaire_allowed, false);
});

test("10B: valid playbook + product_question allows rag_allowed in metadata", () => {
  const playbook = loadTenantPlaybook().playbook;
  const metadata = buildAgentBehaviorDecisionMetadata({
    config: decisionOnConfig(),
    v4PathActive: true,
    intent: "product_question",
    memory: { selected_product_id: "smart_website" },
    playbook,
  });
  assert.equal(metadata.behavior_decision_playbook_valid, true);
  assert.equal(metadata.behavior_decision_rag_allowed, true);
});

test("10B: resolver failure => safe failure metadata, no throw", () => {
  const metadata = buildAgentBehaviorDecisionMetadata({
    config: decisionOnConfig(),
    v4PathActive: true,
    intent: "product_question",
    resolveFn: () => {
      throw new Error("simulated resolver failure");
    },
  });
  assert.equal(metadata.behavior_decision_ok, false);
  assert.equal(metadata.behavior_decision_failure_reason, "resolver_error");
  assert.equal(metadata.behavior_decision_rag_allowed, false);
  assert.equal(metadata.behavior_decision_questionnaire_allowed, false);
});

test("10B: privacy — no transcript, phone, or email in metadata payload", async () => {
  await withEnv({ VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED: "true" }, async () => {
    const transcript = "Rufen Sie mich unter +491701234567 an oder mailen Sie test@example.com";
    const { events } = await runOrchestratorTurn({
      config: decisionOnConfig(),
      transcript,
      memory: {
        ...createCallSessionMemory({ bridgeCallId: "qa-10b" }),
        phone: "+491701234567",
        email: "test@example.com",
      },
    });
    const serialized = JSON.stringify(events.map((entry) => entry.payload));
    assert.equal(serialized.includes("+491701234567"), false);
    assert.equal(serialized.includes("test@example.com"), false);
    assert.equal(serialized.includes("Rufen Sie mich"), false);
  });
});

test("10B: v4 inactive => no metadata even when flag on", () => {
  const payload = behaviorDecisionQualityPayload({
    config: decisionOnConfig(),
    v4PathActive: false,
    intent: "product_question",
  });
  assert.deepEqual(payload, {});
});

test("10B: v3 default route unchanged", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.v4.runtimeVersion, "v3");
    assert.equal(config.v4.agentBehaviorDecisionEnabled, false);
    assert.equal(config.v4.playbookRuntimeEnabled, false);
    assert.equal(config.v4.questionnaireRuntimeEnabled, false);
  });
});
