import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import {
  beginInterruptFollowupWaitOnBargeIn,
  processInterruptFollowupAfterStt,
  clearInterruptFollowupWait,
} from "../src/v4/interrupt-followup-wait.js";
import {
  splitInterruptMarkerAndContinuation,
  resolveSingleStopDetected,
} from "../src/v4/interrupt-marker-split.js";
import {
  resetInterruptFollowupForNewBargeIn,
  finalizeInterruptFollowupAfterContinuation,
  clearStaleInterruptionRecovery,
} from "../src/v4/interrupt-followup-cycle.js";
import { resolveClosedDomainIntent } from "../src/v4/closed-domain-intent.js";
import {
  resolveInterruptionRecovery,
  captureInterruptedAssistantState,
} from "../src/v4/interruption-context.js";
import { setSelectedProduct, createCallSessionMemory } from "../src/v4/call-session-memory.js";
import {
  validateQualityEventInput,
  buildInterruptFollowupStartedEvent,
  buildInterruptFollowupWaitingEvent,
  TIMING_TELEMETRY_PAYLOAD_KEYS,
} from "../src/v4/quality-events.js";

function makeRuntime(overrides = {}) {
  const config = loadConfig();
  const agentConfig = loadAgentConfig(config);
  const memory = setSelectedProduct(
    createCallSessionMemory({ bridgeCallId: "r-test" }),
    "voice_agent",
  );
  return {
    waitingForInterruptionFollowup: false,
    runtimeContext: {
      agentConfig,
      memory,
      stateMachine: { state: "listening" },
    },
    qualityEventsBuffer: [],
    ...overrides,
  };
}

function eventPayloads(buffer) {
  return buffer.map((e) => e.payload);
}

test("10R: isolated Stopp sets single_stop_detected on started and waiting", () => {
  const config = loadConfig();
  const runtime = makeRuntime();
  const ctx = { bridgeCallId: "r1", callSessionId: randomUUID() };
  const at = Date.now();

  beginInterruptFollowupWaitOnBargeIn(runtime, config, ctx, at);
  assert.equal(runtime.interruptFollowup.singleStopDetected, true);

  const started = runtime.qualityEventsBuffer.find(
    (e) => e.eventType === "interrupt_followup_started",
  );
  assert.equal(started.payload.single_stop_detected, true);

  const result = processInterruptFollowupAfterStt(config, ctx, runtime, "Stopp", at + 50);
  assert.equal(result.defer, true);
  assert.equal(result.single_stop_detected, true);

  const waiting = runtime.qualityEventsBuffer.find(
    (e) => e.eventType === "interrupt_followup_waiting",
  );
  assert.equal(waiting.payload.single_stop_detected, true);
});

test("10R: repeated isolated Stopp across cycles resets wait state", () => {
  const config = loadConfig();
  const runtime = makeRuntime();
  const ctx = { bridgeCallId: "r2", callSessionId: randomUUID() };

  for (let i = 0; i < 3; i++) {
    beginInterruptFollowupWaitOnBargeIn(runtime, config, ctx, Date.now());
    const result = processInterruptFollowupAfterStt(config, ctx, runtime, "Stop");
    assert.equal(result.defer, true, `cycle ${i}`);
    assert.equal(result.single_stop_detected, true, `cycle ${i}`);
    finalizeInterruptFollowupAfterContinuation(runtime);
    clearInterruptFollowupWait(runtime);
    assert.equal(runtime.waitingForInterruptionFollowup, false);
  }
});

test("10R: combined utterances split deterministically", () => {
  const cases = [
    ["Stopp. Was kostet das?", "Was kostet das?"],
    ["Stopp, ich meine Smart Website.", "ich meine Smart Website"],
    ["Stop. Wie funktioniert das?", "Wie funktioniert das?"],
  ];
  for (const [input, expectCont] of cases) {
    const split = splitInterruptMarkerAndContinuation(input);
    assert.equal(split.marker_only, false, input);
    assert.match(split.continuation, new RegExp(expectCont.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), input);
    assert.equal(resolveSingleStopDetected(input, split), true, input);
  }
});

test("10R: Stopp pricing answers without second stop", () => {
  const config = loadConfig();
  const runtime = makeRuntime();
  const result = processInterruptFollowupAfterStt(
    config,
    { bridgeCallId: "r3" },
    { ...runtime, waitingForInterruptionFollowup: true, interruptFollowup: {} },
    "Stopp. Was kostet das?",
  );
  assert.equal(result.defer, false);
  assert.equal(result.transcript, "Was kostet das?");

  const agent = runtime.runtimeContext.agentConfig;
  const memory = setSelectedProduct(runtime.runtimeContext.memory, "voice_agent");
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory,
    stateMachine: { state: "listening" },
    transcript: result.transcript,
    ragGate: { allowed: false },
  });
  assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
});

test("10R: product switch clears stale voice_agent context for follow-up pricing", () => {
  const agent = loadAgentConfig(loadConfig());
  let memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "r4" }), "voice_agent");

  const recovery = resolveInterruptionRecovery({
    agentConfig: agent,
    memory,
    stateMachine: { state: "interrupted" },
    context: captureInterruptedAssistantState({
      memory,
      stateMachine: { state: "speaking" },
      playback: {},
    }),
    callerText: "Stopp, ich meine Smart Website",
  });
  assert.equal(recovery.memory.selected_product_id, "smart_website");

  memory = recovery.memory;
  const domain = resolveClosedDomainIntent({
    agentConfig: agent,
    transcript: "Was kostet das?",
    memory,
  });
  assert.equal(domain.matched_product, "smart_website");
  assert.equal(domain.is_low_confidence, false);

  const plan = buildResponsePlan({
    agentConfig: agent,
    memory,
    stateMachine: { state: "listening" },
    transcript: "Was kostet das?",
    closedDomain: domain,
    interruptionRecovery: {
      recoveryAction: "interruption_followup",
      memory,
      context: { interrupted_product_id: "smart_website" },
    },
    ragGate: { allowed: false },
  });
  assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
  assert.match(plan.text, /individuell|kalkuliert/i);
  assert.equal(plan.memory_patch?.selected_product_id ?? memory.selected_product_id, "smart_website");
});

test("10R: continuation clears wait state and marker pending flags", () => {
  const config = loadConfig();
  const runtime = makeRuntime({ waitingForInterruptionFollowup: true, interruptFollowup: {} });
  const ctx = { bridgeCallId: "r5" };

  processInterruptFollowupAfterStt(config, ctx, runtime, "Stopp");
  assert.equal(runtime.interruptFollowup.markerTranscript, "Stopp");

  processInterruptFollowupAfterStt(config, ctx, runtime, "Was kostet das?");
  assert.equal(runtime.waitingForInterruptionFollowup, false);
  assert.equal(runtime.interruptFollowup, null);
});

test("10R: marker-only Stopp does not plan immediate Gerne response", () => {
  const agent = loadAgentConfig(loadConfig());
  const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "r6" }), "voice_agent");
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory,
    stateMachine: { state: "listening" },
    transcript: "Stopp",
    interruptionRecovery: null,
  });
  assert.notEqual(plan.response_type, RESPONSE_TYPES.INTERRUPTION_RECOVERY);
});

test("10R: clearStaleInterruptionRecovery removes memory interruption_context", () => {
  const runtime = makeRuntime({
    pendingInterruptionRecovery: true,
    interruptionContext: { interrupted_product_id: "voice_agent" },
  });
  runtime.runtimeContext.memory = {
    ...runtime.runtimeContext.memory,
    interruption_context: { interrupted_product_id: "voice_agent" },
  };
  clearStaleInterruptionRecovery(runtime);
  assert.equal(runtime.pendingInterruptionRecovery, false);
  assert.equal(runtime.interruptionContext, null);
  assert.equal(runtime.runtimeContext.memory.interruption_context, null);
});

test("10R: privacy validation exempts timing telemetry keys", () => {
  const timingPayload = {};
  for (const key of TIMING_TELEMETRY_PAYLOAD_KEYS) {
    timingPayload[key] = 1735689600123;
  }
  assert.equal(
    validateQualityEventInput({
      eventType: "interrupt_followup_started",
      tenantId: "technolohit",
      agentId: "main_voice_sales",
      payload: timingPayload,
    }).ok,
    true,
  );

  assert.equal(
    validateQualityEventInput({
      eventType: "interrupt_followup_waiting",
      tenantId: "technolohit",
      agentId: "main_voice_sales",
      payload: { contact_note: "+491701234567" },
    }).ok,
    false,
  );
});

test("10R: resetInterruptFollowupForNewBargeIn clears prior wait", () => {
  const runtime = makeRuntime({
    waitingForInterruptionFollowup: true,
    interruptFollowup: { markerTranscript: "Stopp", singleStopDetected: true },
  });
  resetInterruptFollowupForNewBargeIn(runtime);
  assert.equal(runtime.waitingForInterruptionFollowup, false);
  assert.equal(runtime.interruptFollowup, null);
});

test("10R: v4 flags off — no followup processing without wait flag", () => {
  const config = loadConfig();
  const runtime = { waitingForInterruptionFollowup: false };
  const result = processInterruptFollowupAfterStt(config, {}, runtime, "Stopp");
  assert.equal(result.defer, false);
  assert.equal(result.single_stop_detected, undefined);
});
