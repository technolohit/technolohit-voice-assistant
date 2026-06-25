/**
 * Phase 10G — caller-ID missing ask-phone-once flow.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import {
  createDialogueOrchestrator,
  startTurn,
  acceptUserTranscript,
  decideNextAction,
  commitAssistantPlanWithoutPlayback,
} from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { createQualityEventSink } from "../src/v4/quality-event-sink.js";
import {
  createCallSessionMemory,
  serializeMemoryForPersistence,
  setSelectedProduct,
  updateMemoryFromUserTurn,
} from "../src/v4/call-session-memory.js";
import {
  buildResponsePlan,
  applyMemoryPatch,
  RESPONSE_TYPES,
} from "../src/v4/response-planner.js";
import {
  evaluateSpokenPhoneCapture,
  parseSpokenPhoneCandidate,
} from "../src/v4/spoken-phone-capture.js";
import {
  CALLBACK_FLOW_STATES,
  resolveCallbackFlowState,
} from "../src/v4/callback-flow-policy.js";
import { shouldUseRagForTurn } from "../src/v4/rag-orchestrator.js";
import { buildLeadCandidateFromMemory } from "../src/v4/lead-candidate.js";
import {
  assertNoKnownSpokenPhoneInPayload,
  assertNoRawPhoneInPayload,
} from "../src/v4/privacy-sanitize.js";
import { finalizeV4PostCallHandoff } from "../src/v4/post-call-bridge.js";
import { notificationPayload } from "../src/post-call-notify.js";
import { V4_STATES } from "../src/v4/state-machine.js";

const VALID_CALLER_PHONE = "+4915112345678";
const CAPTURED_PHONE = "0171512345678";
const SPOKEN_PHONE =
  "null eins sieben eins fuenf eins zwei drei vier fuenf sechs sieben acht";

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

function canaryEnv(extra = {}) {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_RAG_ENABLED: "true",
    VOICE_RAG_SALES_ANSWERER_ENABLED: "true",
    ...extra,
  };
}

function callbackMemory(state = V4_STATES.COLLECTING_CONTACT_PREFERENCE, extra = {}) {
  return {
    ...setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10g" }), "smart_website"),
    current_product_context: "smart_website",
    contact_flow_pending: true,
    callback_flow_state: CALLBACK_FLOW_STATES.CONTACT_PREFERENCE_PENDING,
    current_state: state,
    ...extra,
  };
}

function createOrchestrator({ callerPhoneNormalized = null, memory = null } = {}) {
  const config = loadConfig();
  return createDialogueOrchestrator({
    config,
    runtimeContext: createRuntimeContext(config, { bridgeCallId: "10g" }),
    memory: memory ?? callbackMemory(),
    stateMachine: { state: V4_STATES.COLLECTING_CONTACT_PREFERENCE },
    agentConfig: loadAgentConfig(config),
    qualitySink: createQualityEventSink({ v4PathActive: true }),
    v4PathActive: true,
    callerPhoneNormalized,
  });
}

async function runTurn(orchestrator, transcript) {
  startTurn(orchestrator);
  acceptUserTranscript(orchestrator, transcript);
  const action = await decideNextAction(orchestrator, { transcript });
  commitAssistantPlanWithoutPlayback(orchestrator, action.plan?.text, action.plan);
  return action;
}

test("spoken-phone-capture parses digit and spoken German numbers", () => {
  assert.equal(parseSpokenPhoneCandidate("0171 512345678"), "0171512345678");
  const spoken = evaluateSpokenPhoneCapture(SPOKEN_PHONE);
  assert.equal(spoken.ok, true);
  assert.match(spoken.masked_phone, /\*\*\*\*/);
  assert.notEqual(spoken.masked_phone, spoken.normalized_phone);
});

test("valid caller ID -> permission directly without phone request", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createOrchestrator({ callerPhoneNormalized: VALID_CALLER_PHONE });
    const action = await runTurn(orchestrator, "Dankeschön, telefonisch bitte.");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION);
    assert.equal(action.plan.plan_reason, "contact_phone_preference");
    assert.notEqual(action.plan.response_type, RESPONSE_TYPES.REQUEST_PHONE_ONCE);
  });
});

test("missing caller ID -> request_phone_once", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createOrchestrator({ callerPhoneNormalized: null });
    const action = await runTurn(orchestrator, "Dankeschön, telefonisch bitte.");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.REQUEST_PHONE_ONCE);
    assert.equal(action.plan.plan_reason, "caller_id_missing_request_phone_once");
    assert.equal(orchestrator.memory.phone_capture_attempted, true);
    assert.equal(
      resolveCallbackFlowState(orchestrator.memory),
      CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING
    );
  });
});

test("valid spoken phone -> permission question", async () => {
  await withEnv(canaryEnv(), async () => {
    const memory = callbackMemory(V4_STATES.COLLECTING_PHONE_NUMBER, {
      contact_preference: "phone",
      phone_capture_attempted: true,
      callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
    });
    const orchestrator = createOrchestrator({ memory, callerPhoneNormalized: null });
    const action = await runTurn(orchestrator, SPOKEN_PHONE);
    assert.equal(action.intent, "phone_number_candidate");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION);
    assert.equal(orchestrator.memory.phone_present, true);
    assert.equal(action.plan.captured_phone_normalized, undefined);
    assert.equal(orchestrator.lastPlan.captured_phone_normalized, undefined);
    assert.equal(orchestrator.callerPhoneNormalized, CAPTURED_PHONE);
    assert.doesNotMatch(JSON.stringify(action.plan), /0171512345678/);
  });
});

test("short phone -> retry once then manual review", async () => {
  await withEnv(canaryEnv(), async () => {
    const memory = callbackMemory(V4_STATES.COLLECTING_PHONE_NUMBER, {
      contact_preference: "phone",
      phone_capture_attempted: true,
      callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
    });
    const orchestrator = createOrchestrator({ memory, callerPhoneNormalized: null });
    const action = await runTurn(orchestrator, "null eins zwei");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.REQUEST_PHONE_RETRY);
    assert.equal(action.plan.plan_reason, "phone_capture_partial_or_incomplete");
    assert.equal(
      resolveCallbackFlowState(orchestrator.memory),
      CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING
    );

    const failed = await runTurn(orchestrator, "null eins zwei");
    assert.equal(failed.plan.response_type, RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW);
    assert.equal(failed.plan.plan_reason, "phone_capture_failed_after_retry");

    const memoryAfterFail = callbackMemory(V4_STATES.COLLECTING_PHONE_NUMBER, {
      contact_preference: "phone",
      phone_capture_attempted: true,
      phone_capture_attempt_count: 1,
      callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
    });
    const recovery = createOrchestrator({ memory: memoryAfterFail, callerPhoneNormalized: null });
    const retry = await runTurn(recovery, "0171 512345678");
    assert.notEqual(retry.plan.response_type, RESPONSE_TYPES.REQUEST_PHONE_ONCE);
  });
});

test("permission without valid phone is not lead_ready", async () => {
  await withEnv(canaryEnv(), async () => {
    const memory = callbackMemory(V4_STATES.COLLECTING_CALLBACK_PERMISSION, {
      contact_preference: "phone",
      callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING,
    });
    const plan = buildResponsePlan({
      agentConfig: loadAgentConfig(loadConfig()),
      memory,
      stateMachine: { state: V4_STATES.COLLECTING_CALLBACK_PERMISSION },
      transcript: "Ja.",
      intent: "callback_permission_granted",
      config: loadConfig(),
      v4PathActive: true,
      callerPhoneNormalized: null,
      callerPhoneRaw: null,
    });
    assert.equal(plan.response_type, RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW);
    assert.equal(plan.lead_transition_allowed, false);
  });
});

test("phone without permission is not lead_ready", async () => {
  await withEnv(canaryEnv(), async () => {
    const memory = callbackMemory(V4_STATES.COLLECTING_PHONE_NUMBER, {
      contact_preference: "phone",
      phone_present: true,
      phone_capture_attempted: true,
      callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING,
    });
    const candidate = buildLeadCandidateFromMemory(memory, {
      callerPhoneNormalized: CAPTURED_PHONE,
    });
    assert.equal(candidate.callback_ready, false);
  });
});

test("closing during phone capture wins", async () => {
  await withEnv(canaryEnv(), async () => {
    const memory = callbackMemory(V4_STATES.COLLECTING_PHONE_NUMBER, {
      contact_preference: "phone",
      phone_capture_attempted: true,
      callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
    });
    const orchestrator = createOrchestrator({ memory, callerPhoneNormalized: null });
    const action = await runTurn(orchestrator, "Danke, das reicht erstmal.");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.CLOSING);
  });
});

test("RAG and questionnaire blocked during phone capture", async () => {
  await withEnv(canaryEnv(), async () => {
    const config = loadConfig();
    const memory = callbackMemory(V4_STATES.COLLECTING_PHONE_NUMBER, {
      contact_preference: "phone",
      phone_capture_attempted: true,
      callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
    });
    const ragGate = shouldUseRagForTurn({
      config,
      state: V4_STATES.COLLECTING_PHONE_NUMBER,
      intent: "phone_capture_failed",
      memory,
      transcript: "null eins zwei",
    });
    assert.equal(ragGate.allowed, false);

    const plan = buildResponsePlan({
      agentConfig: loadAgentConfig(config),
      memory,
      stateMachine: { state: V4_STATES.COLLECTING_PHONE_NUMBER },
      transcript: "null eins zwei",
      intent: "phone_capture_failed",
      config,
      v4PathActive: true,
      ragGate,
    });
    assert.equal(plan.questionnaire?.used ?? false, false);
  });
});

test("privacy: captured phone never appears in quality event payloads", async () => {
  await withEnv(canaryEnv(), async () => {
    const events = [];
    const config = loadConfig();
    const memory = callbackMemory(V4_STATES.COLLECTING_PHONE_NUMBER, {
      contact_preference: "phone",
      phone_capture_attempted: true,
      callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
    });
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: createRuntimeContext(config, { bridgeCallId: "10g-privacy" }),
      memory,
      stateMachine: { state: V4_STATES.COLLECTING_PHONE_NUMBER },
      agentConfig: loadAgentConfig(config),
      qualitySink: createQualityEventSink({ v4PathActive: true }),
      v4PathActive: true,
      callerPhoneNormalized: null,
    });
    const originalBuffer = orchestrator.qualitySink.bufferQualityEvent.bind(orchestrator.qualitySink);
    orchestrator.qualitySink.bufferQualityEvent = (event) => {
      events.push(event);
      return originalBuffer(event);
    };

    const action = await runTurn(orchestrator, "0171 512345678");
    for (const event of events) {
      assert.equal(assertNoRawPhoneInPayload(event), true, JSON.stringify(event?.type));
    }
    assert.equal(action.plan.captured_phone_normalized, undefined);
    assert.equal(orchestrator.lastPlan.captured_phone_normalized, undefined);
    assert.equal(orchestrator.callerPhoneNormalized, CAPTURED_PHONE);
    assert.doesNotMatch(JSON.stringify(action.plan), /0171512345678/);
  });
});

test("privacy: numeric phone capture redacts persisted user utterance and current turn", async () => {
  await withEnv(canaryEnv(), async () => {
    const memory = callbackMemory(V4_STATES.COLLECTING_PHONE_NUMBER, {
      contact_preference: "phone",
      phone_capture_attempted: true,
      callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
    });
    const orchestrator = createOrchestrator({ memory, callerPhoneNormalized: null });

    const action = await runTurn(orchestrator, "0171 512345678");

    assert.equal(orchestrator.memory.last_user_utterance, "[phone_redacted]");
    assert.equal(orchestrator.currentTurn.transcript, "[phone_redacted]");
    assert.equal(action.plan.captured_phone_normalized, undefined);
    assert.equal(orchestrator.lastPlan.captured_phone_normalized, undefined);
    assert.equal(orchestrator.callerPhoneNormalized, CAPTURED_PHONE);
    assert.doesNotMatch(JSON.stringify(action.plan), /0171512345678|512345678/);
    assert.doesNotMatch(JSON.stringify(serializeMemoryForPersistence(orchestrator.memory)), /0171512345678|512345678/);
  });
});

test("privacy: spoken digit phone capture redacts memory, snapshots, metadata, notification, and events", async () => {
  await withEnv(canaryEnv({ VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED: "true" }), async () => {
    const events = [];
    const config = loadConfig();
    const memory = callbackMemory(V4_STATES.COLLECTING_PHONE_NUMBER, {
      contact_preference: "phone",
      phone_capture_attempted: true,
      callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
    });
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: createRuntimeContext(config, { bridgeCallId: "10g-spoken-privacy" }),
      memory,
      stateMachine: { state: V4_STATES.COLLECTING_PHONE_NUMBER },
      agentConfig: loadAgentConfig(config),
      qualitySink: createQualityEventSink({ v4PathActive: true }),
      v4PathActive: true,
      callerPhoneNormalized: null,
    });
    const originalBuffer = orchestrator.qualitySink.bufferQualityEvent.bind(orchestrator.qualitySink);
    orchestrator.qualitySink.bufferQualityEvent = (event) => {
      events.push(event);
      return originalBuffer(event);
    };

    const action = await runTurn(orchestrator, SPOKEN_PHONE);

    assert.equal(orchestrator.memory.last_user_utterance, "[phone_redacted]");
    assert.equal(orchestrator.currentTurn.transcript, "[phone_redacted]");
    assert.equal(action.plan.captured_phone_normalized, undefined);
    assert.equal(orchestrator.lastPlan.captured_phone_normalized, undefined);
    assert.equal(orchestrator.callerPhoneNormalized, CAPTURED_PHONE);
    assert.doesNotMatch(JSON.stringify(action.plan), /0171512345678|fuenf eins zwei drei vier fuenf sechs/);

    const serialized = serializeMemoryForPersistence(orchestrator.memory);
    assert.equal(assertNoKnownSpokenPhoneInPayload(serialized, [SPOKEN_PHONE]), true);
    assert.equal(assertNoRawPhoneInPayload(serialized), true);
    assert.doesNotMatch(JSON.stringify(serialized), /0171512345678|fuenf eins zwei drei vier fuenf sechs/);

    const handoff = finalizeV4PostCallHandoff(orchestrator, {
      callerPhoneNormalized: orchestrator.callerPhoneNormalized,
    });
    assert.equal(handoff.privacy_ok, true);
    assert.equal(assertNoKnownSpokenPhoneInPayload(handoff.summaryMetadata, [SPOKEN_PHONE]), true);
    assert.equal(assertNoKnownSpokenPhoneInPayload(handoff.leadInputs, [SPOKEN_PHONE]), true);
    assert.equal(assertNoRawPhoneInPayload(handoff.summaryMetadata), true);

    const payload = notificationPayload(
      { callSessionId: "sess-10g", bridgeCallId: "10g-spoken-privacy", externalCallId: "ext-10g" },
      {
        summaryId: "sum-10g",
        summaryText: "Callback flow completed.",
        metadata: handoff.summaryMetadata,
      },
      { action: "skipped", reason: "guard_not_met", leadId: "" }
    );
    assert.equal(assertNoKnownSpokenPhoneInPayload(payload, [SPOKEN_PHONE]), true);
    assert.equal(assertNoRawPhoneInPayload(payload), true);

    for (const event of events) {
      assert.equal(assertNoKnownSpokenPhoneInPayload(event, [SPOKEN_PHONE]), true, event.eventType);
      assert.equal(assertNoRawPhoneInPayload(event), true, event.eventType);
    }

    const decisionEvent = events.find((event) => event.eventType === "response_plan_created");
    assert.ok(decisionEvent);
    assert.equal(assertNoKnownSpokenPhoneInPayload(decisionEvent.payload, [SPOKEN_PHONE]), true);
  });
});

test("privacy: phone-capture redaction is context-aware and candidate-only", () => {
  const phonePending = callbackMemory(V4_STATES.COLLECTING_PHONE_NUMBER, {
    contact_preference: "phone",
    phone_capture_attempted: true,
    callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
  });
  const normal = updateMemoryFromUserTurn(
    createCallSessionMemory({ bridgeCallId: "normal" }),
    "eins zwei Schritte bitte"
  );
  assert.equal(normal.last_user_utterance, "eins zwei Schritte bitte");

  const noCandidate = updateMemoryFromUserTurn(phonePending, "Was kostet eins zwei Smart Website?");
  assert.equal(noCandidate.last_user_utterance, "Was kostet eins zwei Smart Website?");

  const productWithCandidate = updateMemoryFromUserTurn(
    phonePending,
    "Was kostet Smart Website 0171 512345678?"
  );
  assert.equal(productWithCandidate.last_user_utterance, "[phone_redacted]");
});
