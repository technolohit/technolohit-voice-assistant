import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import {
  HARDCODED_BEHAVIOR_DEFAULTS,
  resolveBehaviorPolicy,
  isPlaybookRuntimeEligible,
  isClosingIntentForPolicy,
  getClosingPhrases,
  getClosingResponse,
  getFallbackClarificationResponse,
  getOutOfScopeRedirect,
  getTechnicalEscalationResponse,
} from "../src/v4/behavior-policy.js";
import { CLOSING_RESPONSE_TEXT, isClosingIntent } from "../src/v4/closing-intent.js";
import { detectTranscriptIntent, getWarmGoodbyeResponseText } from "../src/v4/transcript-intent.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import {
  createDialogueOrchestrator,
  startTurn,
  acceptUserTranscript,
  decideNextAction,
} from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { createQualityEventSink } from "../src/v4/quality-event-sink.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";
import { V4_STATES } from "../src/v4/state-machine.js";

const PHASE_10AK_CLOSING_PHRASES = [
  "Danke, das reicht erstmal.",
  "Passt so, danke.",
  "Danke, passt.",
  "Tschüss.",
  "Auf Wiederhören.",
  "Ich habe keine weiteren Fragen.",
  "Das war's.",
  "Stopp, danke, tschüss.",
];

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

function runtimeEligibleTestPlaybook(overrides = {}) {
  return {
    schema_version: "tenant-playbook-1",
    tenant_id: "technolohit",
    agent_id: "main_voice_sales",
    playbook_version: "test-playbook-10an",
    status: "published",
    runtime_binding: { active: true },
    approval: { approved_for_runtime: true },
    closing_policy: {
      phrases: [...PHASE_10AK_CLOSING_PHRASES, "Wir sind fertig für heute."],
      response: "Vielen Dank und bis bald. Auf Wiederhören.",
    },
    fallback_policy: {
      response: "Entschuldigung, können Sie das bitte noch einmal sagen?",
    },
    escalation_policy: {
      out_of_scope_redirect: "Dazu berate ich nicht, aber gerne zu TechnoloHit-Produkten.",
      uncertain_or_technical: "Das prüft unser Team und meldet sich bei Ihnen.",
    },
    ...overrides,
  };
}

test("10AN: default env returns hardcoded policy and existing closing response", () => {
  const config = loadConfig();
  assert.equal(config.v4.playbookRuntimeEnabled, false);
  assert.equal(config.v4.playbookAllowDraft, false);

  const policy = resolveBehaviorPolicy({ config });
  assert.equal(policy.source, "hardcoded_default");
  assert.equal(policy.reason, "playbook_runtime_disabled");
  assert.equal(getClosingResponse(policy), CLOSING_RESPONSE_TEXT);
  assert.equal(getClosingResponse(policy), getWarmGoodbyeResponseText());
  assert.equal(getClosingPhrases(policy), null);
  assert.equal(
    getFallbackClarificationResponse(policy),
    HARDCODED_BEHAVIOR_DEFAULTS.fallback_clarification_response
  );
  assert.equal(getOutOfScopeRedirect(policy), HARDCODED_BEHAVIOR_DEFAULTS.out_of_scope_redirect);
  assert.equal(
    getTechnicalEscalationResponse(policy),
    HARDCODED_BEHAVIOR_DEFAULTS.technical_escalation_response
  );
});

test("10AN: default env does not load playbook at runtime", () => {
  // Even with a deliberately broken playbook path, the disabled flag returns
  // hardcoded defaults before any filesystem access (reason proves the
  // resolver exited at the flag check, not at file loading).
  withEnv({ VOICE_V4_PLAYBOOK_PATH: "C:/definitely/missing/playbook.json" }, () => {
    const policy = resolveBehaviorPolicy({ config: loadConfig() });
    assert.equal(policy.source, "hardcoded_default");
    assert.equal(policy.reason, "playbook_runtime_disabled");
  });
});

test("10AN: missing playbook fails closed to hardcoded defaults", () => {
  withEnv(
    {
      VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true",
      VOICE_V4_PLAYBOOK_PATH: "C:/definitely/missing/playbook.json",
    },
    () => {
      const policy = resolveBehaviorPolicy({ config: loadConfig() });
      assert.equal(policy.source, "hardcoded_default");
      assert.equal(policy.reason, "playbook_not_found");
      assert.equal(getClosingResponse(policy), CLOSING_RESPONSE_TEXT);
    }
  );
});

test("10AN: invalid playbook file fails closed to hardcoded defaults", () => {
  withEnv(
    {
      VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true",
      // Valid JSON but not a valid playbook (missing required fields).
      VOICE_V4_PLAYBOOK_PATH: "package.json",
    },
    () => {
      const policy = resolveBehaviorPolicy({ config: loadConfig() });
      assert.equal(policy.source, "hardcoded_default");
      assert.equal(policy.reason, "playbook_validation_failed");
      assert.equal(getClosingResponse(policy), CLOSING_RESPONSE_TEXT);
    }
  );
});

test("10AN: draft playbook is rejected without explicit draft override", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    // Default path resolves to the real Phase 10AM draft playbook.
    const policy = resolveBehaviorPolicy({ config: loadConfig() });
    assert.equal(policy.source, "hardcoded_default");
    assert.equal(policy.reason, "draft_playbook_not_allowed");
    assert.equal(getClosingResponse(policy), CLOSING_RESPONSE_TEXT);
  });
});

test("10AN: draft override loads the real draft playbook with equivalent closing behavior", () => {
  withEnv(
    {
      VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true",
      VOICE_V4_PLAYBOOK_ALLOW_DRAFT: "true",
    },
    () => {
      const policy = resolveBehaviorPolicy({ config: loadConfig() });
      assert.equal(policy.source, "playbook");
      assert.equal(policy.reason, "draft_override");
      // The draft playbook mirrors Phase 10AK — equivalence check.
      assert.equal(getClosingResponse(policy), CLOSING_RESPONSE_TEXT);
      for (const phrase of PHASE_10AK_CLOSING_PHRASES) {
        assert.equal(isClosingIntentForPolicy(phrase, policy), true, phrase);
      }
      assert.equal(isClosingIntentForPolicy("Stopp", policy), false);
    }
  );
});

test("10AN: runtime eligibility requires published + approved + active binding", () => {
  assert.equal(isPlaybookRuntimeEligible(null).ok, false);
  assert.equal(
    isPlaybookRuntimeEligible(runtimeEligibleTestPlaybook({ status: "draft" })).ok,
    false
  );
  assert.equal(
    isPlaybookRuntimeEligible(runtimeEligibleTestPlaybook({ status: "draft" }), { allowDraft: true }).ok,
    true
  );
  assert.equal(
    isPlaybookRuntimeEligible(
      runtimeEligibleTestPlaybook({ approval: { approved_for_runtime: false } })
    ).reason,
    "playbook_not_approved_for_runtime"
  );
  assert.equal(
    isPlaybookRuntimeEligible(
      runtimeEligibleTestPlaybook({ runtime_binding: { active: false } })
    ).reason,
    "playbook_runtime_binding_inactive"
  );
});

test("10AN: injected valid playbook closing phrase and response are used when opted in", async () => {
  await withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, async () => {
    const config = loadConfig();
    const policy = resolveBehaviorPolicy({ config, playbook: runtimeEligibleTestPlaybook() });
    assert.equal(policy.source, "playbook");
    assert.equal(policy.playbook_version, "test-playbook-10an");

    // Playbook-only phrase is recognized; built-in detection alone misses it.
    const customPhrase = "Wir sind fertig für heute.";
    assert.equal(isClosingIntent(customPhrase), false);
    assert.equal(isClosingIntentForPolicy(customPhrase, policy), true);
    assert.equal(detectTranscriptIntent(customPhrase, {}, null, policy), "closing");

    const events = [];
    let retrieverCalls = 0;
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: createRuntimeContext(config, { bridgeCallId: "10an-injected" }),
      memory: {
        ...setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10an-injected" }), "smart_website"),
        current_state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
      },
      stateMachine: { state: V4_STATES.ANSWERING_PRODUCT_QUESTION },
      agentConfig: loadAgentConfig(config),
      adapters: {
        ragRetriever: async () => {
          retrieverCalls += 1;
          return { ok: true, hit: false, hitCount: 0 };
        },
      },
      qualitySink: createQualityEventSink({ v4PathActive: true }),
      v4PathActive: true,
      behaviorPolicy: policy,
    });
    const originalBuffer = orchestrator.qualitySink.bufferQualityEvent.bind(orchestrator.qualitySink);
    orchestrator.qualitySink.bufferQualityEvent = (event) => {
      events.push(event);
      return originalBuffer(event);
    };

    startTurn(orchestrator);
    acceptUserTranscript(orchestrator, customPhrase);
    const action = await decideNextAction(orchestrator, { transcript: customPhrase });

    assert.equal(action.intent, "closing");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.CLOSING);
    assert.equal(action.plan.plan_reason, "closing_intent");
    assert.equal(action.plan.text, "Vielen Dank und bis bald. Auf Wiederhören.");
    assert.equal(retrieverCalls, 0, "closing must not call RAG even via playbook phrase");

    const serialized = JSON.stringify(events.map((event) => event.payload));
    assert.equal(serialized.includes(customPhrase), false, "no raw transcript in payloads");
    assert.equal(/\+\d{7,}/.test(serialized), false, "no phone-like data");
    assert.equal(/@\w+\.\w+/.test(serialized), false, "no email-like data");
  });
});

test("10AN: playbook closing response is NOT used without opt-in flag", () => {
  // Injected playbook object but flag off -> hardcoded.
  const config = loadConfig();
  assert.equal(config.v4.playbookRuntimeEnabled, false);
  const policy = resolveBehaviorPolicy({ config, playbook: runtimeEligibleTestPlaybook() });
  assert.equal(policy.source, "hardcoded_default");
  assert.equal(policy.reason, "playbook_runtime_disabled");
  assert.equal(getClosingResponse(policy), CLOSING_RESPONSE_TEXT);
  assert.equal(isClosingIntentForPolicy("Wir sind fertig für heute.", policy), false);
});

test("10AN: existing 10AK closing phrases still close with and without policy", () => {
  const playbookPolicy = resolveBehaviorPolicy({
    config: { v4: { playbookRuntimeEnabled: true } },
    playbook: runtimeEligibleTestPlaybook(),
  });
  for (const phrase of PHASE_10AK_CLOSING_PHRASES) {
    assert.equal(detectTranscriptIntent(phrase, {}, null), "closing", `no policy: ${phrase}`);
    assert.equal(detectTranscriptIntent(phrase, {}, null, playbookPolicy), "closing", `policy: ${phrase}`);
  }
  // Bare "Stopp" stays barge-in/interruption behavior in both modes.
  assert.equal(detectTranscriptIntent("Stopp", {}, null), "interruption_recovery");
  assert.equal(detectTranscriptIntent("Stopp", {}, null, playbookPolicy), "interruption_recovery");
  assert.equal(detectTranscriptIntent("Stopp, danke, tschüss.", {}, null, playbookPolicy), "closing");
});

test("10AN: closing plan with default env is byte-identical to 10AK behavior", () => {
  const agent = loadAgentConfig(loadConfig());
  const withoutPolicy = buildResponsePlan({
    agentConfig: agent,
    memory: { selected_product_id: "smart_website", current_state: "listening" },
    stateMachine: { state: "listening" },
    transcript: "Danke, das reicht erstmal.",
  });
  const withHardcodedPolicy = buildResponsePlan({
    agentConfig: agent,
    memory: { selected_product_id: "smart_website", current_state: "listening" },
    stateMachine: { state: "listening" },
    transcript: "Danke, das reicht erstmal.",
    behaviorPolicy: resolveBehaviorPolicy({ config: loadConfig() }),
  });
  assert.equal(withoutPolicy.response_type, RESPONSE_TYPES.CLOSING);
  assert.equal(withoutPolicy.text, CLOSING_RESPONSE_TEXT);
  assert.deepEqual(withHardcodedPolicy, withoutPolicy);
});

test("10AN: fallback clarification default remains unchanged when flag off", () => {
  const agent = loadAgentConfig(loadConfig());
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory: {},
    stateMachine: { state: "listening" },
    transcript: "blub gnarf zwirbel",
    intent: "unclear",
    closedDomain: { is_low_confidence: false, matched_product: null },
    behaviorPolicy: resolveBehaviorPolicy({ config: loadConfig() }),
  });
  assert.equal(plan.response_type, RESPONSE_TYPES.FALLBACK_CLARIFICATION);
  assert.equal(plan.text, HARDCODED_BEHAVIOR_DEFAULTS.fallback_clarification_response);
});

test("10AN: playbook fallback clarification is used only when opted in", () => {
  const agent = loadAgentConfig(loadConfig());
  const policy = resolveBehaviorPolicy({
    config: { v4: { playbookRuntimeEnabled: true } },
    playbook: runtimeEligibleTestPlaybook(),
  });
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory: {},
    stateMachine: { state: "listening" },
    transcript: "blub gnarf zwirbel",
    intent: "unclear",
    closedDomain: { is_low_confidence: false, matched_product: null },
    behaviorPolicy: policy,
  });
  assert.equal(plan.response_type, RESPONSE_TYPES.FALLBACK_CLARIFICATION);
  assert.equal(plan.text, "Entschuldigung, können Sie das bitte noch einmal sagen?");
});

test("10AN: v3 default route remains unchanged", () => {
  const config = loadConfig();
  assert.equal(config.v4.runtimeVersion, "v3");
  assert.equal(config.v4.playbookRuntimeEnabled, false);
  assert.equal(config.v4.playbookPath, "");
  assert.equal(config.v4.playbookAllowDraft, false);
  assert.equal(config.rag?.enabled ?? false, false);
});
