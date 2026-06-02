import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import {
  beginInterruptFollowupWaitOnBargeIn,
  processInterruptFollowupAfterStt,
  shouldRunInterruptFollowupTimeout,
  bufferInterruptFollowupTimeoutEvent,
  buildInterruptFollowupQualityPayload,
} from "../src/v4/interrupt-followup-wait.js";
import {
  splitInterruptMarkerAndContinuation,
  isHardStopMarkerText,
} from "../src/v4/interrupt-marker-split.js";
import {
  finalizeInterruptFollowupLatencyMetrics,
  beginInterruptFollowupLatency,
  markInterruptFollowupLatency,
} from "../src/v4/interrupt-followup-latency.js";
import {
  validateQualityEventInput,
  buildInterruptFollowupStartedEvent,
  buildInterruptFollowupWaitingEvent,
  buildInterruptFollowupContinuationReceivedEvent,
  buildInterruptFollowupTimeoutEvent,
  buildInterruptFollowupLatencyMetricsEvent,
} from "../src/v4/quality-events.js";
import { resolveInterruptionRecovery, captureInterruptedAssistantState } from "../src/v4/interruption-context.js";
import { setSelectedProduct, createCallSessionMemory } from "../src/v4/call-session-memory.js";
import { resetUtteranceBuffer } from "../src/v4/live-stt-endpoint.js";

function makeRuntime(overrides = {}) {
  const config = loadConfig();
  const agentConfig = loadAgentConfig(config);
  const memory = setSelectedProduct(
    createCallSessionMemory({ bridgeCallId: "q-test" }),
    "voice_agent",
  );
  return {
    waitingForInterruptionFollowup: true,
    interruptFollowup: { bargeInAt: Date.now() },
    runtimeContext: {
      agentConfig,
      memory,
      stateMachine: { state: "waiting_for_interruption_followup" },
    },
    qualityEventsBuffer: [],
    utterance: { capturing: false, frames: [], streamId: null, startedAt: null },
    sttAdapter: { provider: "mock", startSttStream: () => ({ ok: true, streamId: "s1" }) },
    ...overrides,
  };
}

function eventTypes(buffer) {
  return buffer.map((e) => e.eventType);
}

test("10Q: splitInterruptMarkerAndContinuation handles marker-only and combined", () => {
  const s1 = splitInterruptMarkerAndContinuation("Stopp");
  assert.equal(s1.marker_only, true);
  assert.equal(s1.single_stop_detected, true);

  const s2 = splitInterruptMarkerAndContinuation("Stop");
  assert.equal(s2.marker_only, true);
  assert.equal(s2.single_stop_detected, true);

  const s3 = splitInterruptMarkerAndContinuation("Stopp. Was kostet das?");
  assert.equal(s3.marker_only, false);
  assert.equal(s3.continuation, "Was kostet das?");
  assert.equal(s3.single_stop_detected, true);

  const s4 = splitInterruptMarkerAndContinuation("Stopp, ich meine Smart Website");
  assert.match(s4.continuation, /Smart Website/i);
  assert.equal(s4.single_stop_detected, true);

  const s5 = splitInterruptMarkerAndContinuation("Stop, wie funktioniert das?");
  assert.match(s5.continuation, /funktioniert/i);
});

test("10Q: hard stop markers recognized", () => {
  for (const phrase of [
    "Stopp",
    "Stop",
    "Halt",
    "Moment",
    "Warte",
    "Stopp bitte",
    "Stop bitte",
    "Stopp, stopp",
    "Stop, ich habe eine Frage",
  ]) {
    assert.equal(isHardStopMarkerText(phrase), true, phrase);
  }
});

test("10Q: Stopp alone defers dialogue and sets single_stop_detected", () => {
  const config = loadConfig();
  const runtime = makeRuntime();
  const result = processInterruptFollowupAfterStt(
    config,
    { bridgeCallId: "q1", callSessionId: randomUUID() },
    runtime,
    "Stopp",
  );
  assert.equal(result.defer, true);
  assert.equal(result.single_stop_detected, true);
  assert.equal(runtime.interruptFollowup.singleStopDetected, true);
  assert.equal(runtime.interruptFollowup.markerOnly, true);
  assert.ok(runtime.interruptFollowup.waitWindowStartedMs);
});

test("10Q: Stop alone same as Stopp", () => {
  const config = loadConfig();
  const runtime = makeRuntime();
  const result = processInterruptFollowupAfterStt(
    config,
    { bridgeCallId: "q1b" },
    runtime,
    "Stop",
  );
  assert.equal(result.defer, true);
  assert.equal(result.single_stop_detected, true);
});

test("10Q: Stopp. Was kostet das? splits and answers pricing without second stop", () => {
  const config = loadConfig();
  const runtime = makeRuntime();
  const result = processInterruptFollowupAfterStt(
    config,
    { bridgeCallId: "q2" },
    runtime,
    "Stopp. Was kostet das?",
  );
  assert.equal(result.defer, false);
  assert.equal(result.transcript, "Was kostet das?");
  assert.equal(runtime.waitingForInterruptionFollowup, false);

  const agent = runtime.runtimeContext.agentConfig;
  const recovery = resolveInterruptionRecovery({
    agentConfig: agent,
    memory: runtime.runtimeContext.memory,
    stateMachine: { state: "interrupted" },
    context: captureInterruptedAssistantState({
      memory: runtime.runtimeContext.memory,
      stateMachine: { state: "speaking" },
      playback: {},
    }),
    callerText: result.transcript,
  });
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory: recovery.memory,
    stateMachine: recovery.stateMachine,
    transcript: result.transcript,
    interruptionRecovery: recovery,
    ragGate: { allowed: false },
  });
  assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
  assert.match(plan.text, /individuell|kalkuliert/i);
});

test("10Q: Stopp ich meine Smart Website splits and switches product", () => {
  const config = loadConfig();
  const runtime = makeRuntime();
  const result = processInterruptFollowupAfterStt(
    config,
    { bridgeCallId: "q3" },
    runtime,
    "Stopp, ich meine Smart Website",
  );
  assert.equal(result.defer, false);
  assert.match(result.transcript, /Smart Website/i);

  const agent = runtime.runtimeContext.agentConfig;
  const recovery = resolveInterruptionRecovery({
    agentConfig: agent,
    memory: runtime.runtimeContext.memory,
    stateMachine: { state: "interrupted" },
    context: captureInterruptedAssistantState({
      memory: runtime.runtimeContext.memory,
      stateMachine: { state: "speaking" },
      playback: {},
    }),
    callerText: result.transcript,
  });
  assert.equal(recovery.recoveryAction, "product_switch");
  assert.equal(recovery.memory.selected_product_id, "smart_website");
});

test("10Q: marker-only then continuation preserves product context", () => {
  const config = loadConfig();
  const runtime = makeRuntime();
  const ctx = { bridgeCallId: "q4", callSessionId: randomUUID() };

  const first = processInterruptFollowupAfterStt(config, ctx, runtime, "Stopp");
  assert.equal(first.defer, true);
  assert.equal(runtime.runtimeContext.memory.selected_product_id, "voice_agent");

  const second = processInterruptFollowupAfterStt(
    config,
    ctx,
    runtime,
    "Was kostet das?",
  );
  assert.equal(second.defer, false);
  assert.equal(second.transcript, "Was kostet das?");
  assert.equal(runtime.runtimeContext.memory.selected_product_id, "voice_agent");
});

test("10Q: marker-only timeout emits timeout event; clarification only via timeout flag", () => {
  const config = loadConfig();
  const runtime = makeRuntime();
  const ctx = { bridgeCallId: "q5", callSessionId: randomUUID() };
  const at = Date.now();

  beginInterruptFollowupWaitOnBargeIn(runtime, config, ctx, at);
  processInterruptFollowupAfterStt(config, ctx, runtime, "Stopp", at + 100);
  runtime.interruptFollowup.waitUntilMs = at - 1;

  assert.equal(shouldRunInterruptFollowupTimeout(runtime), true);

  bufferInterruptFollowupTimeoutEvent(config, ctx, runtime);
  assert.ok(
    eventTypes(runtime.qualityEventsBuffer).includes("interrupt_followup_timeout"),
  );

  const agent = runtime.runtimeContext.agentConfig;
  const memory = runtime.runtimeContext.memory;
  const markerPlan = buildResponsePlan({
    agentConfig: agent,
    memory,
    stateMachine: { state: "listening" },
    transcript: "Stopp",
  });
  assert.notEqual(markerPlan.response_type, RESPONSE_TYPES.ACKNOWLEDGEMENT);

  const timeoutPlan = buildResponsePlan({
    agentConfig: agent,
    memory,
    stateMachine: { state: "listening" },
    transcript: "",
    interruptFollowupTimeout: true,
  });
  assert.match(timeoutPlan.text, /Gerne/i);
});

test("10Q: no immediate TTS after marker-only — defer blocks dialogue path", () => {
  const config = loadConfig();
  const runtime = makeRuntime();
  const result = processInterruptFollowupAfterStt(
    config,
    { bridgeCallId: "q6" },
    runtime,
    "Stopp",
  );
  assert.equal(result.defer, true);
  assert.equal(result.reason, "marker_only_waiting");
});

test("10Q: quality events validate without raw transcript", () => {
  const config = loadConfig();
  const callSessionId = randomUUID();
  const runtime = makeRuntime();
  const ctx = { bridgeCallId: randomUUID(), callSessionId };
  const at = Date.now();

  beginInterruptFollowupWaitOnBargeIn(runtime, config, ctx, at);
  processInterruptFollowupAfterStt(config, ctx, runtime, "Stopp", at + 50);
  processInterruptFollowupAfterStt(
    config,
    ctx,
    runtime,
    "Was kostet das?",
    at + 800,
  );
  bufferInterruptFollowupTimeoutEvent(config, ctx, runtime);

  const payloads = runtime.qualityEventsBuffer.map((e) => e.payload);
  for (const payload of payloads) {
    assert.equal(payload.transcript, undefined);
    assert.equal(payload.assistant_text, undefined);
    assert.equal(payload.user_utterance, undefined);
  }

  for (const builder of [
    buildInterruptFollowupStartedEvent,
    buildInterruptFollowupWaitingEvent,
    buildInterruptFollowupContinuationReceivedEvent,
    buildInterruptFollowupTimeoutEvent,
  ]) {
    const event = builder({
      config,
      callSessionId,
      payload: buildInterruptFollowupQualityPayload(runtime, {
        marker_chars: 5,
        continuation_chars: 16,
        effective_transcript_chars: 16,
      }),
    });
    assert.equal(validateQualityEventInput(event).ok, true, event.eventType);
    assert.equal(JSON.stringify(event.payload).includes("Stopp"), false);
  }
});

test("10Q: timing fields present in latency metrics", () => {
  const runtime = {};
  const base = Date.now();
  beginInterruptFollowupLatency(runtime, base);
  markInterruptFollowupLatency(runtime, "stop_detected", base);
  markInterruptFollowupLatency(runtime, "playback_cancelled", base + 20);
  markInterruptFollowupLatency(runtime, "wait_window_started", base + 120);
  markInterruptFollowupLatency(runtime, "continuation_speech_start", base + 900);
  markInterruptFollowupLatency(runtime, "continuation_endpoint", base + 1400);

  const metrics = finalizeInterruptFollowupLatencyMetrics(runtime);
  assert.ok(metrics.stop_detected_ms);
  assert.ok(metrics.playback_cancelled_ms);
  assert.ok(metrics.wait_window_started_ms);
  assert.ok(metrics.continuation_speech_started_ms);
  assert.ok(metrics.continuation_endpoint_ms);
  assert.equal(metrics.stop_to_cancel_ms, 20);
  assert.equal(metrics.stop_to_wait_window_ms, 120);
  assert.equal(metrics.wait_window_to_continuation_ms, 780);

  const event = buildInterruptFollowupLatencyMetricsEvent({
    config: loadConfig(),
    callSessionId: randomUUID(),
    payload: metrics,
  });
  assert.equal(validateQualityEventInput(event).ok, true);
});

test("10Q: resetUtteranceBuffer preserves capture during interrupt wait", () => {
  const runtime = {
    waitingForInterruptionFollowup: true,
    utterance: { capturing: true, frames: [Buffer.from("x")], streamId: "s1" },
  };
  resetUtteranceBuffer(runtime);
  assert.equal(runtime.utterance.frames.length, 1);
  assert.equal(runtime.utterance.capturing, true);
});

test("10Q: beginInterruptFollowupWaitOnBargeIn emits interrupt_followup_started", () => {
  const config = loadConfig();
  const runtime = makeRuntime({ waitingForInterruptionFollowup: false });
  const ctx = { bridgeCallId: "q7", callSessionId: randomUUID() };
  beginInterruptFollowupWaitOnBargeIn(runtime, config, ctx, Date.now());
  assert.ok(
    eventTypes(runtime.qualityEventsBuffer).includes("interrupt_followup_started"),
  );
  assert.equal(runtime.waitingForInterruptionFollowup, true);
});

test("10Q: v4 flags off — processInterruptFollowupAfterStt no-op when not waiting", () => {
  const config = loadConfig();
  const runtime = { waitingForInterruptionFollowup: false };
  const result = processInterruptFollowupAfterStt(
    config,
    { bridgeCallId: "q8" },
    runtime,
    "Stopp",
  );
  assert.equal(result.defer, false);
  assert.equal(result.transcript, "Stopp");
});
