import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import {
  isInterruptMarkerOnly,
  processInterruptFollowupAfterStt,
  resolveEffectiveInterruptTranscript
} from "../src/v4/interrupt-followup-wait.js";
import { resolveClosedDomainIntent } from "../src/v4/closed-domain-intent.js";
import {
  finalizeInterruptFollowupLatencyMetrics,
  beginInterruptFollowupLatency,
  markInterruptFollowupLatency
} from "../src/v4/interrupt-followup-latency.js";
import { validateQualityEventInput, buildInterruptFollowupLatencyMetricsEvent } from "../src/v4/quality-events.js";
import { setSelectedProduct, createCallSessionMemory } from "../src/v4/call-session-memory.js";
import { resolveInterruptionRecovery, captureInterruptedAssistantState } from "../src/v4/interruption-context.js";
import { getWarmGoodbyeResponseText } from "../src/v4/transcript-intent.js";

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(() => restoreEnv(previous));
    }
    restoreEnv(previous);
    return result;
  } catch (err) {
    restoreEnv(previous);
    throw err;
  }
}

test("10P: Stopp alone is marker-only", () => {
  assert.equal(isInterruptMarkerOnly("Stopp"), true);
  assert.equal(isInterruptMarkerOnly("Stop"), true);
  assert.equal(isInterruptMarkerOnly("Was kostet das?"), false);
});

test("10P: marker-only STT defers dialogue", () => {
  const config = loadConfig();
  const runtime = {
    waitingForInterruptionFollowup: true,
    interruptFollowup: { bargeInAt: Date.now() },
    runtimeContext: { agentConfig: loadAgentConfig(config) },
    qualityEventsBuffer: []
  };
  const result = processInterruptFollowupAfterStt(config, { bridgeCallId: "p1" }, runtime, "Stopp");
  assert.equal(result.defer, true);
  assert.equal(runtime.interruptFollowup.markerTranscript, "Stopp");
});

test("10P: Stopp then Was kostet das aggregates continuation", () => {
  const config = loadConfig();
  const runtime = {
    waitingForInterruptionFollowup: true,
    interruptFollowup: { markerTranscript: "Stopp", bargeInAt: Date.now() },
    runtimeContext: {
      agentConfig: loadAgentConfig(config),
      memory: setSelectedProduct(createCallSessionMemory({ bridgeCallId: "p2" }), "voice_agent"),
      stateMachine: { state: "listening" }
    },
    qualityEventsBuffer: []
  };
  const result = processInterruptFollowupAfterStt(
    config,
    { bridgeCallId: "p2" },
    runtime,
    "Was kostet das?"
  );
  assert.equal(result.defer, false);
  assert.equal(result.transcript, "Was kostet das?");
  assert.equal(runtime.waitingForInterruptionFollowup, false);
});

test("10P: effective transcript prefers continuation over marker", () => {
  assert.equal(resolveEffectiveInterruptTranscript("Stopp", "Was kostet das?"), "Was kostet das?");
});

test("10P: pricing follow-up after interruption uses playbook", () => {
  const agent = loadAgentConfig(loadConfig());
  const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "p3" }), "voice_agent");
  const ctx = captureInterruptedAssistantState({
    memory,
    stateMachine: { state: "speaking" },
    playback: { enabled: true, framesSent: 2 }
  });
  const recovery = resolveInterruptionRecovery({
    agentConfig: agent,
    memory,
    stateMachine: { state: "interrupted" },
    context: ctx,
    callerText: "Was kostet das?"
  });
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory: recovery.memory,
    stateMachine: recovery.stateMachine,
    transcript: "Was kostet das?",
    interruptionRecovery: recovery,
    ragGate: { allowed: false }
  });
  assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
  assert.match(plan.text, /individuell|kalkuliert/i);
});

test("10P: Stopp ich meine Smart Website switches product", () => {
  const agent = loadAgentConfig(loadConfig());
  const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "p4" }), "voice_agent");
  const recovery = resolveInterruptionRecovery({
    agentConfig: agent,
    memory,
    stateMachine: { state: "interrupted" },
    context: captureInterruptedAssistantState({
      memory,
      stateMachine: { state: "speaking" },
      playback: {}
    }),
    callerText: "Stopp, ich meine Smart Website"
  });
  assert.equal(recovery.recoveryAction, "product_switch");
  assert.equal(recovery.memory.selected_product_id, "smart_website");
});

test("10P: fuzzy product phrases map correctly", () => {
  const agent = loadAgentConfig(loadConfig());
  const d1 = resolveClosedDomainIntent({ agentConfig: agent, transcript: "KI Rezeption" });
  assert.equal(d1.matched_product, "voice_agent");
  const d2 = resolveClosedDomainIntent({ agentConfig: agent, transcript: "Telefonassistent" });
  assert.equal(d2.matched_product, "voice_agent");
  const d3 = resolveClosedDomainIntent({ agentConfig: agent, transcript: "Webseite" });
  assert.equal(d3.matched_product, "smart_website");
  const d4 = resolveClosedDomainIntent({ agentConfig: agent, transcript: "digital reception" });
  assert.equal(d4.matched_product, "voice_agent");
});

test("10P: low-confidence domain asks precise clarification", () => {
  const agent = loadAgentConfig(loadConfig());
  const domain = resolveClosedDomainIntent({
    agentConfig: agent,
    transcript: "irgendwas mit ki",
    memory: {}
  });
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory: {},
    stateMachine: { state: "listening" },
    transcript: "irgendwas mit ki",
    intent: "unclear",
    closedDomain: domain,
    ragGate: { allowed: false }
  });
  assert.doesNotMatch(plan.text, /nicht ganz verstanden/i);
  assert.match(plan.text, /Digitale Rezeption|Smart Website|Produkt/i);
});

test("10P: goodbye warm closing", () => {
  const plan = buildResponsePlan({
    agentConfig: loadAgentConfig(loadConfig()),
    memory: {},
    stateMachine: { state: "listening" },
    transcript: "Auf Wiederhören"
  });
  assert.equal(plan.text, getWarmGoodbyeResponseText());
});

test("10P: interrupt follow-up latency metrics validate", () => {
  const runtime = {};
  const base = Date.now();
  beginInterruptFollowupLatency(runtime, base);
  markInterruptFollowupLatency(runtime, "playback_cancelled", base + 50);
  markInterruptFollowupLatency(runtime, "followup_speech_start", base + 400);
  markInterruptFollowupLatency(runtime, "followup_stt_completed", base + 1200);
  markInterruptFollowupLatency(runtime, "followup_dialogue_plan", base + 1400);
  markInterruptFollowupLatency(runtime, "followup_playback_started", base + 1800);
  const metrics = finalizeInterruptFollowupLatencyMetrics(runtime);
  assert.ok(metrics.barge_in_detected_to_playback_cancelled_ms != null);
  assert.ok(metrics.followup_stt_completed_to_plan_ms != null);

  const event = buildInterruptFollowupLatencyMetricsEvent({
    config: loadConfig(),
    callSessionId: randomUUID(),
    payload: metrics
  });
  assert.equal(validateQualityEventInput(event).ok, true);
});

test("10P: timeout plan uses interruptFollowupTimeout flag", () => {
  const agent = loadAgentConfig(loadConfig());
  const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "p5" }), "voice_agent");
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory,
    stateMachine: { state: "listening" },
    transcript: "",
    interruptFollowupTimeout: true
  });
  assert.match(plan.text, /Gerne/i);
  assert.match(plan.text, /Digitale Rezeption/i);
});
