/**
 * Phase 12H — missing-caller-ID callback phone capture handoff fix.
 *
 * Reproduces Phase 12G live failure: numeric German mobile STT must parse
 * before privacy redaction; successful capture must hand off to permission and
 * callback_finalized; failure must not report callback_permission_missing.
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
  closeCall,
} from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { createQualityEventSink } from "../src/v4/quality-event-sink.js";
import {
  createCallSessionMemory,
  serializeMemoryForPersistence,
  setSelectedProduct,
} from "../src/v4/call-session-memory.js";
import { RESPONSE_TYPES } from "../src/v4/response-planner.js";
import {
  evaluateSpokenPhoneCapture,
  parseSpokenPhoneCandidate,
} from "../src/v4/spoken-phone-capture.js";
import {
  CALLBACK_FLOW_STATES,
  resolveCallbackFlowState,
} from "../src/v4/callback-flow-policy.js";
import { runLiveDialogueOnCallerTranscript } from "../src/v4/live-dialogue-endpoint.js";
import { createLiveCanaryRuntime } from "../src/v4/canary-runtime-loop.js";
import { redactPhoneLikeText } from "../src/v4/redaction.js";
import { finalizeV4PostCallHandoff } from "../src/v4/post-call-bridge.js";
import { notificationPayload } from "../src/post-call-notify.js";
import {
  assertNoKnownSpokenPhoneInPayload,
  assertNoRawPhoneInPayload,
} from "../src/v4/privacy-sanitize.js";
import { V4_STATES } from "../src/v4/state-machine.js";

const LIVE_NUMERIC_PHONE = "Meine Nummer ist 01511 2345678.";
const CAPTURED_PHONE = "015112345678";
const SPOKEN_PHONE =
  "null eins fuenf eins eins zwei drei vier fuenf sechs sieben acht";

const GERMAN_MOBILE_VARIANTS = [
  "01511 2345678",
  "0151 12345678",
  "0 1 5 1 1 2 3 4 5 6 7 8",
  SPOKEN_PHONE,
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
    ...setSelectedProduct(createCallSessionMemory({ bridgeCallId: "12h" }), "smart_website"),
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
    runtimeContext: createRuntimeContext(config, { bridgeCallId: "12h" }),
    memory: memory ?? callbackMemory(),
    stateMachine: { state: memory?.current_state ?? V4_STATES.COLLECTING_CONTACT_PREFERENCE },
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

test("12H: live numeric transcript parses before redaction would strip it", () => {
  assert.equal(parseSpokenPhoneCandidate(LIVE_NUMERIC_PHONE), CAPTURED_PHONE);
  assert.equal(evaluateSpokenPhoneCapture(LIVE_NUMERIC_PHONE).ok, true);
  assert.equal(evaluateSpokenPhoneCapture(redactPhoneLikeText(LIVE_NUMERIC_PHONE)).ok, false);
});

test("12H: German mobile variants normalize and validate", () => {
  for (const variant of GERMAN_MOBILE_VARIANTS) {
    const capture = evaluateSpokenPhoneCapture(variant);
    assert.equal(capture.ok, true, variant);
    assert.equal(capture.normalized_phone, CAPTURED_PHONE, variant);
  }
});

test("12H: exact live transcript captures from collecting_phone_number", async () => {
  await withEnv(canaryEnv(), async () => {
    const memory = callbackMemory(V4_STATES.COLLECTING_PHONE_NUMBER, {
      contact_preference: "phone",
      phone_capture_attempted: true,
      callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
    });
    const orchestrator = createOrchestrator({ memory, callerPhoneNormalized: null });
    const action = await runTurn(orchestrator, LIVE_NUMERIC_PHONE);

    assert.equal(action.intent, "phone_number_candidate");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION);
    assert.equal(action.plan.plan_reason, "phone_number_captured");
    assert.equal(orchestrator.callerPhoneNormalized, CAPTURED_PHONE);
    assert.equal(action.plan.captured_phone_normalized, undefined);
    assert.equal(orchestrator.lastPlan.captured_phone_normalized, undefined);
  });
});

test("12H: full sequence request_phone_once -> capture -> Ja -> callback_finalized", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createOrchestrator({ callerPhoneNormalized: null });

    const preference = await runTurn(orchestrator, "Ich hätte gern einen Rückruf.");
    assert.notEqual(preference.plan.response_type, RESPONSE_TYPES.CLOSING);

    const phonePref = await runTurn(orchestrator, "Telefonisch bitte.");
    assert.equal(phonePref.plan.response_type, RESPONSE_TYPES.REQUEST_PHONE_ONCE);
    assert.equal(
      resolveCallbackFlowState(orchestrator.memory),
      CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING
    );

    const capture = await runTurn(orchestrator, LIVE_NUMERIC_PHONE);
    assert.equal(capture.plan.response_type, RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION);
    assert.equal(orchestrator.callerPhoneNormalized, CAPTURED_PHONE);

    const finalized = await runTurn(orchestrator, "Ja.");
    assert.equal(finalized.plan.response_type, RESPONSE_TYPES.CALLBACK_FINALIZED);
    assert.equal(orchestrator.memory.callback_permission, "granted");

    closeCall(orchestrator);
    assert.equal(orchestrator.leadCandidate.callback_ready, true);
    assert.equal(orchestrator.leadCandidate.next_action, "team_callback");
  });
});

test("12H: live dialogue endpoint preserves raw STT for phone capture", async () => {
  await withEnv(
    canaryEnv({
      VOICE_V4_STT_PROVIDER: "mock",
    }),
    async () => {
      const config = loadConfig();
      const ctx = {
        bridgeCallId: "12h-live-phone",
        callSessionId: "00000000-0000-0000-0000-0000000012h0",
      };
      const runtime = createLiveCanaryRuntime(config, ctx, { allowMockStt: true });
      assert.equal(runtime.ok, true);
      ctx.v4LiveRuntime = runtime;

      runtime.runtimeContext.memory = callbackMemory(V4_STATES.COLLECTING_PHONE_NUMBER, {
        contact_preference: "phone",
        phone_capture_attempted: true,
        callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
      });
      runtime.runtimeContext.stateMachine.state = V4_STATES.COLLECTING_PHONE_NUMBER;

      const candidate = {
        ok: true,
        transcript: LIVE_NUMERIC_PHONE,
        endpointIndex: 1,
        dialogueProcessed: false,
      };

      const dialogue = await runLiveDialogueOnCallerTranscript(config, ctx, runtime, candidate);
      assert.equal(dialogue.ok, true);
      assert.equal(dialogue.intent, "phone_number_candidate");
      assert.equal(dialogue.plan.response_type, RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION);
      assert.equal(runtime.orchestrator.callerPhoneNormalized, CAPTURED_PHONE);
      assert.equal(runtime.orchestrator.memory.last_user_utterance, "[phone_redacted]");
    }
  );
});

test("12H: privacy — public plan and lastPlan exclude captured_phone_normalized", async () => {
  await withEnv(canaryEnv(), async () => {
    const memory = callbackMemory(V4_STATES.COLLECTING_PHONE_NUMBER, {
      contact_preference: "phone",
      phone_capture_attempted: true,
      callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
    });
    const orchestrator = createOrchestrator({ memory, callerPhoneNormalized: null });
    const action = await runTurn(orchestrator, LIVE_NUMERIC_PHONE);

    assert.equal(action.plan.captured_phone_normalized, undefined);
    assert.equal(orchestrator.lastPlan.captured_phone_normalized, undefined);
    assert.doesNotMatch(JSON.stringify(action.plan), /015112345678|01511 2345678/);
    assert.doesNotMatch(JSON.stringify(orchestrator.lastPlan), /015112345678|01511 2345678/);
  });
});

test("12H: privacy — memory, quality, summary, notification contain no raw phone", async () => {
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
      runtimeContext: createRuntimeContext(config, { bridgeCallId: "12h-privacy" }),
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

    await runTurn(orchestrator, LIVE_NUMERIC_PHONE);
    await runTurn(orchestrator, "Ja.");
    closeCall(orchestrator);

    const serialized = serializeMemoryForPersistence(orchestrator.memory);
    assert.equal(assertNoRawPhoneInPayload(serialized), true);
    assert.doesNotMatch(JSON.stringify(serialized), /015112345678|01511 2345678/);

    const handoff = finalizeV4PostCallHandoff(orchestrator, {
      callerPhoneNormalized: orchestrator.callerPhoneNormalized,
    });
    assert.equal(handoff.privacy_ok, true);
    assert.equal(assertNoRawPhoneInPayload(handoff.summaryMetadata), true);
    assert.equal(assertNoRawPhoneInPayload(handoff.leadInputs), true);

    const payload = notificationPayload(
      { callSessionId: "sess-12h", bridgeCallId: "12h-privacy", externalCallId: "ext-12h" },
      {
        summaryId: "sum-12h",
        summaryText: "Callback flow completed.",
        metadata: handoff.summaryMetadata,
      },
      { action: "skipped", reason: "guard_not_met", leadId: "" }
    );
    assert.equal(assertNoRawPhoneInPayload(payload), true);
    assert.equal(assertNoKnownSpokenPhoneInPayload(payload, [LIVE_NUMERIC_PHONE, SPOKEN_PHONE]), true);

    for (const event of events) {
      assert.equal(assertNoRawPhoneInPayload(event), true, event.eventType);
      assert.doesNotMatch(JSON.stringify(event), /015112345678|01511 2345678/);
    }
  });
});

test("12H: failure path yields callback_manual_review without callback_permission_missing", async () => {
  await withEnv(canaryEnv(), async () => {
    const memory = callbackMemory(V4_STATES.COLLECTING_PHONE_NUMBER, {
      contact_preference: "phone",
      phone_capture_attempted: true,
      callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
    });
    const orchestrator = createOrchestrator({ memory, callerPhoneNormalized: null });
    const action = await runTurn(orchestrator, "null eins zwei");

    assert.equal(action.plan.response_type, RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW);
    assert.equal(action.plan.plan_reason, "phone_capture_failed");
    assert.equal(
      resolveCallbackFlowState(orchestrator.memory),
      CALLBACK_FLOW_STATES.CALLBACK_MANUAL_REVIEW
    );

    closeCall(orchestrator);
    assert.equal(orchestrator.leadCandidate.callback_ready, false);
    assert.notEqual(orchestrator.leadCandidate.validation.reason, "callback_permission_missing");
    assert.equal(orchestrator.leadCandidate.validation.reason, "phone_capture_failed");
    assert.equal(orchestrator.leadCandidate.next_action, "manual_followup");
  });
});
