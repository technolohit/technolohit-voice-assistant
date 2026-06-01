import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig, getProductById, matchProductAlias, getForbiddenClaims } from "../src/v4/agent-config.js";
import {
  createCallSessionMemory,
  updateMemoryFromUserTurn,
  updateMemoryFromIntent,
  attachInterruptionContext,
  clearInterruptionContext,
  summarizeMemoryForPrompt,
  serializeMemoryForPersistence,
  setSelectedProduct,
  markLeadReady
} from "../src/v4/call-session-memory.js";
import {
  V4_STATES,
  canTransition,
  transitionState,
  validateStateTransition,
  nextStateForIntent,
  nextStateForMemory,
  stateToQualityEvent
} from "../src/v4/state-machine.js";
import {
  resolveRuntimeRoute,
  shouldUseV4Runtime,
  createRuntimeContext,
  routeIncomingCallToRuntime
} from "../src/v4/runtime-router.js";
import {
  buildQualityEventInput,
  buildBargeInDetectedEvent,
  buildRagRetrievalStartedEvent,
  validateQualityEventInput
} from "../src/v4/quality-events.js";
import {
  validateCallbackReadyLead,
  validatePhoneForCallback,
  ragAnswerMustNotCreateLead
} from "../src/v4/lead-validator.js";
import {
  buildRagRetrievePayload,
  resolveRagScope,
  V4_RAG_HOST_LOCAL_BASE_URL,
  isLeadValidationDelegatedToRag
} from "../src/v4/rag-scope.js";

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("default config keeps v3 runtime active", () => {
  withEnv({ VOICE_RUNTIME_VERSION: undefined, VOICE_V4_REALTIME_ENABLED: undefined }, () => {
    const config = loadConfig();
    assert.equal(resolveRuntimeRoute(config).runtime, "v3");
    assert.equal(shouldUseV4Runtime(config), false);
    assert.equal(routeIncomingCallToRuntime(config).handler, "v3");
  });
});

test("v4 realtime flag alone does not activate production v4 handler", () => {
  withEnv({ VOICE_RUNTIME_VERSION: "v4", VOICE_V4_REALTIME_ENABLED: "true" }, () => {
    const config = loadConfig();
    const route = resolveRuntimeRoute(config);
    assert.equal(route.runtime, "v4");
    assert.equal(route.active, false);
    assert.equal(route.stub, true);
    assert.equal(shouldUseV4Runtime(config), false);
    assert.equal(routeIncomingCallToRuntime(config).handler, "v3");
  });
});

test("createRuntimeContext initializes memory and state machine", () => {
  withEnv({ VOICE_AGENT_CONFIG_PATH: undefined }, () => {
    const config = loadConfig();
    const ctx = createRuntimeContext(config, { bridgeCallId: "bridge-123" });
    assert.equal(ctx.memory.bridge_call_id, "bridge-123");
    assert.equal(ctx.stateMachine.state, V4_STATES.GREETING);
    assert.equal(ctx.agentConfig.ok, true);
    assert.equal(ctx.qualityEventSeed.eventType, "call_started");
  });
});

test("memory update from user turn redacts phone-like utterances", () => {
  let memory = createCallSessionMemory({ bridgeCallId: "b1" });
  memory = updateMemoryFromUserTurn(memory, "Meine Nummer ist 0171 5551234");
  assert.match(memory.last_user_utterance, /\[phone_redacted\]/);
  assert.doesNotMatch(memory.last_user_utterance, /5551234/);
  const serialized = serializeMemoryForPersistence(memory);
  assert.doesNotMatch(JSON.stringify(serialized), /5551234/);
});

test("interruption context is represented in memory and cleared", () => {
  let memory = createCallSessionMemory({ bridgeCallId: "b2" });
  memory = attachInterruptionContext(memory, {
    interruptedProductId: "voice_agent",
    assistantText: "Digitale Rezeption erklärt..."
  });
  assert.equal(memory.current_state, "interrupted");
  assert.equal(memory.interruption_context.interrupted_product_id, "voice_agent");
  memory = clearInterruptionContext(memory);
  assert.equal(memory.interruption_context, null);
});

test("memory intent update sets product and customer type", () => {
  let memory = createCallSessionMemory({ bridgeCallId: "b3" });
  memory = updateMemoryFromIntent(memory, {
    normalized_intent: "product_selection_smart_website"
  });
  assert.equal(memory.selected_product_id, "smart_website");
  memory = updateMemoryFromIntent(memory, {
    normalized_intent: "sales_customer_type_new_prospect"
  });
  assert.equal(memory.customer_type, "new_prospect");
});

test("summarizeMemoryForPrompt excludes raw utterances with phones", () => {
  const memory = updateMemoryFromUserTurn(
    createCallSessionMemory({ bridgeCallId: "b4" }),
    "Ruf mich an 01715551234"
  );
  const summary = summarizeMemoryForPrompt(memory);
  assert.equal("last_user_utterance" in summary, false);
});

test("state machine rejects lead_ready without policy", () => {
  const validation = validateStateTransition(V4_STATES.VALIDATING_CONTACT, V4_STATES.LEAD_READY, {
    leadPolicy: { allowed: false, reason: "no_phone" }
  });
  assert.equal(validation.ok, false);
});

test("state machine rejects product Q&A transition that creates lead", () => {
  const validation = validateStateTransition(V4_STATES.THINKING, V4_STATES.ANSWERING_PRODUCT_QUESTION, {
    createsLead: true
  });
  assert.equal(validation.ok, false);
});

test("speaking to interrupted transition is allowed", () => {
  assert.equal(canTransition(V4_STATES.SPEAKING, V4_STATES.INTERRUPTED), true);
  const machine = transitionState({ state: V4_STATES.SPEAKING, history: [] }, V4_STATES.INTERRUPTED, "barge_in");
  assert.equal(machine.state, V4_STATES.INTERRUPTED);
});

test("nextStateForIntent maps product question to answering_product_question", () => {
  assert.equal(nextStateForIntent(V4_STATES.LISTENING, "sales_product_explanation"), V4_STATES.ANSWERING_PRODUCT_QUESTION);
});

test("nextStateForMemory uses interruption and lead signals", () => {
  assert.equal(nextStateForMemory({ interruption_context: {} }), V4_STATES.INTERRUPTED);
  assert.equal(nextStateForMemory({ lead_ready: true }), V4_STATES.LEAD_READY);
});

test("stateToQualityEvent maps interrupted to barge_in_detected", () => {
  assert.equal(stateToQualityEvent(V4_STATES.INTERRUPTED), "barge_in_detected");
});

test("lead validator rejects callback without phone", () => {
  const memory = {
    contact_preference: "phone",
    callback_permission: "granted",
    phone_present: false
  };
  const result = validateCallbackReadyLead(memory, {});
  assert.equal(result.allowed, false);
});

test("lead validator rejects email-only callback path", () => {
  const result = validateCallbackReadyLead(
    { contact_preference: "email", callback_permission: "granted" },
    {}
  );
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "email_path_no_phone_callback");
});

test("lead validator rejects RAG as lead source", () => {
  const result = validateCallbackReadyLead(
    { contact_preference: "phone", callback_permission: "granted", phone_present: true },
    { source: "rag_sales_answerer" }
  );
  assert.equal(result.allowed, false);
});

test("lead validator allows valid caller ID with permission", () => {
  const result = validateCallbackReadyLead(
    { contact_preference: "phone", callback_permission: "granted" },
    {
      callerPhoneNormalized: "+491701234567",
      explicitUserPermission: true
    }
  );
  assert.equal(result.allowed, true);
});

test("lead validator rejects incomplete spoken phone", () => {
  const phone = validatePhoneForCallback({ spokenPhone: "0171 55" });
  assert.equal(phone.ok, false);
});

test("rag answer must not create lead", () => {
  assert.equal(ragAnswerMustNotCreateLead(true).createsLead, false);
});

test("RAG payload always includes tenant_id and agent_id", () => {
  withEnv({ VOICE_AGENT_CONFIG_PATH: undefined }, () => {
    const config = loadConfig();
    const agent = loadAgentConfig(config);
    const payload = buildRagRetrievePayload(
      config,
      { query: "Was ist Smart Website?", context: { source: "rag_sales_answerer" } },
      agent
    );
    assert.equal(payload.tenant_id, "technolohit");
    assert.equal(payload.agent_id, "main_voice_sales");
  });
});

test("RAG rejects lead validation delegation in context", () => {
  withEnv({ VOICE_AGENT_CONFIG_PATH: undefined }, () => {
    const config = loadConfig();
    assert.throws(
      () =>
        buildRagRetrievePayload(config, {
          query: "test",
          context: { source: "lead_validation" }
        }),
      /must not delegate/
    );
  });
});

test("isLeadValidationDelegatedToRag detects forbidden sources", () => {
  assert.equal(isLeadValidationDelegatedToRag({ source: "callback_permission" }), true);
  assert.equal(isLeadValidationDelegatedToRag({ source: "rag_sales_answerer" }), false);
});

test("documented host-local RAG base URL constant", () => {
  assert.equal(V4_RAG_HOST_LOCAL_BASE_URL, "http://127.0.0.1:8080");
  withEnv({ VOICE_RAG_API_URL: undefined }, () => {
    const scope = resolveRagScope(loadConfig());
    assert.equal(scope.tenant_id, "technolohit");
  });
});

test("quality event builders redact phone numbers in payload", () => {
  withEnv({ VOICE_AGENT_CONFIG_PATH: undefined }, () => {
    const config = loadConfig();
    const event = buildBargeInDetectedEvent({
      config,
      payload: { caller_phone: "+491701234567", turn_index: 2 }
    });
    assert.equal(event.payload.caller_phone, "[redacted]");
    const validation = validateQualityEventInput(event);
    assert.equal(validation.ok, true);
  });
});

test("agent config helpers resolve products and forbidden claims", () => {
  withEnv({ VOICE_AGENT_CONFIG_PATH: undefined }, () => {
    const agent = loadAgentConfig(loadConfig());
    assert.equal(getProductById(agent.config, "smart_website")?.display_name, "Smart Website");
    assert.equal(matchProductAlias(agent.config, "Smart Website")?.id, "smart_website");
    assert.ok(getForbiddenClaims(agent.config).length >= 1);
  });
});

test("markLeadReady in memory does not bypass validator", () => {
  const memory = markLeadReady(setSelectedProduct(createCallSessionMemory({ bridgeCallId: "b5" }), "voice_agent"), true);
  assert.equal(memory.lead_ready, true);
  const validation = validateCallbackReadyLead(memory, {});
  assert.equal(validation.allowed, false);
});
