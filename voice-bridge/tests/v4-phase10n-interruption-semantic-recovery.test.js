import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import {
  resolveInterruptionRecovery,
  captureInterruptedAssistantState
} from "../src/v4/interruption-context.js";
import {
  detectTranscriptIntent,
  isDefiniteCallerGoodbye,
  getWarmGoodbyeResponseText,
  isInterruptionFollowUpPhrase
} from "../src/v4/transcript-intent.js";
import {
  validateQualityEventInput,
  buildBargeInDetectedEvent
} from "../src/v4/quality-events.js";
import { getBargeInMetrics, markBargeInTriggered, createBargeInDetectorFromConfig } from "../src/v4/barge-in-detector.js";
import { setSelectedProduct, createCallSessionMemory, attachInterruptionContext } from "../src/v4/call-session-memory.js";
import { V4_STATES } from "../src/v4/state-machine.js";
import {
  beginLiveTurnLatency,
  markLiveTurnLatency,
  finalizeLiveTurnLatencyMetrics
} from "../src/v4/live-turn-latency.js";
import {
  createCanaryDialogueRuntime,
  simulateInboundTranscriptTurn,
  simulateBargeInDuringPlayback,
  simulateAssistantPlayback
} from "../src/v4/canary-runtime-loop.js";

function dialogueEnv(extra = {}) {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_V4_BARGE_IN_ENABLED: "true",
    VOICE_V4_BARGE_IN_MIN_PLAYBACK_MS: "0",
    VOICE_V4_VAD_RMS_THRESHOLD: "400",
    ...extra
  };
}

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

function planAfterInterruption(agent, memory, transcript, interruptedProductId) {
  const ctx = captureInterruptedAssistantState({
    memory: setSelectedProduct(memory, interruptedProductId),
    stateMachine: { state: V4_STATES.SPEAKING },
    playback: { enabled: true, framesSent: 3, bytesSent: 960 }
  });
  const recovery = resolveInterruptionRecovery({
    agentConfig: agent,
    memory: memory,
    stateMachine: { state: V4_STATES.INTERRUPTED },
    context: ctx,
    callerText: transcript
  });
  return buildResponsePlan({
    agentConfig: agent,
    memory: recovery.memory,
    stateMachine: recovery.stateMachine,
    transcript,
    interruptionRecovery: recovery,
    ragGate: { allowed: false, reason: "rag_disabled" }
  });
}

test("10N: Stopp kurze Frage is interruption follow-up not fallback", () => {
  withEnv(dialogueEnv(), () => {
    const agent = loadAgentConfig(loadConfig());
    const memory = setSelectedProduct(
      attachInterruptionContext(createCallSessionMemory({ bridgeCallId: "10n-1" }), {
        interrupted_product_id: "voice_agent"
      }),
      "voice_agent"
    );
    const plan = planAfterInterruption(
      agent,
      memory,
      "Stopp, ich habe eine kurze Frage",
      "voice_agent"
    );
    assert.notEqual(plan.response_type, RESPONSE_TYPES.FALLBACK_CLARIFICATION);
    assert.equal(plan.response_type, RESPONSE_TYPES.INTERRUPTION_RECOVERY);
    assert.match(plan.text, /Gerne/i);
    assert.doesNotMatch(plan.text, /nicht ganz verstanden/i);
  });
});

test("10N: generic follow-up preserves product context", () => {
  withEnv(dialogueEnv(), () => {
    const agent = loadAgentConfig(loadConfig());
    const memory = createCallSessionMemory({ bridgeCallId: "10n-2" });
    const plan = planAfterInterruption(agent, memory, "Ich habe eine kurze Frage", "voice_agent");
    assert.equal(plan.memory_patch?.selected_product_id ?? plan.memory_patch?.product_interest, "voice_agent");
    assert.match(plan.text, /digitale Rezeption|Gerne/i);
  });
});

test("10N: Stopp ich meine Smart Website switches product", async () => {
  await withEnv(dialogueEnv(), async () => {
    const config = loadConfig();
    const runtime = createCanaryDialogueRuntime(config, { harnessExplicit: true, bridgeCallId: "10n-sw" });
    await simulateInboundTranscriptTurn(runtime, "Erzählen Sie mir über die digitale Rezeption");
    runtime.orchestrator.memory = setSelectedProduct(runtime.orchestrator.memory, "voice_agent");
    simulateAssistantPlayback(runtime, { frames: 2 });
    const bargeIn = await simulateBargeInDuringPlayback(runtime, {
      speechFrames: 4,
      amplitude: 1000,
      callerText: "Stopp, ich meine Smart Website"
    });
    assert.equal(bargeIn.interruption.recovery.recoveryAction, "product_switch");
    assert.equal(bargeIn.interruption.memory.selected_product_id, "smart_website");
  });
});

test("10N: pricing follow-up with RAG disabled returns playbook answer", () => {
  withEnv(dialogueEnv(), () => {
    const agent = loadAgentConfig(loadConfig());
    const memory = createCallSessionMemory({ bridgeCallId: "10n-price" });
    const plan = planAfterInterruption(agent, memory, "Was kostet das?", "voice_agent");
    assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
    assert.match(plan.text, /individuell|kalkuliert/i);
    assert.equal(plan.rag_allowed, false);
  });
});

test("10N: goodbye returns warm closing", () => {
  const agent = loadAgentConfig(loadConfig());
  const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10n-bye" }), "smart_website");
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory,
    stateMachine: { state: V4_STATES.ANSWERING_PRODUCT_QUESTION },
    transcript: "Auf Wiederhören"
  });
  assert.equal(isDefiniteCallerGoodbye("Keine Frage mehr"), true);
  assert.equal(plan.text, getWarmGoodbyeResponseText());
  assert.equal(plan.memory_patch.call_closing, true);
});

test("10N: goodbye wins over pending interruption context", () => {
  const agent = loadAgentConfig(loadConfig());
  const memory = attachInterruptionContext(
    setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10n-bye-interrupted" }), "voice_agent"),
    { interrupted_product_id: "voice_agent", cancellation_reason: "inbound_speech_detected" }
  );
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory,
    stateMachine: { state: V4_STATES.INTERRUPTED },
    transcript: "Auf Wiederhören",
    ragGate: { allowed: false, reason: "rag_disabled" }
  });
  assert.equal(plan.response_type, RESPONSE_TYPES.CLOSING);
  assert.equal(plan.text, getWarmGoodbyeResponseText());
  assert.equal(plan.memory_patch.interruption_context, null);
});

test("10N: successful turn latency fields populated after TTS playback marks", () => {
  const runtime = {};
  const base = Date.now();
  beginLiveTurnLatency(runtime, 1);
  markLiveTurnLatency(runtime, "stt_completed", base + 80);
  markLiveTurnLatency(runtime, "dialogue_plan", base + 200);
  markLiveTurnLatency(runtime, "tts_started", base + 350);
  markLiveTurnLatency(runtime, "tts_first_chunk", base + 480);
  markLiveTurnLatency(runtime, "tts_completed", base + 520);
  markLiveTurnLatency(runtime, "playback_started", base + 540);
  markLiveTurnLatency(runtime, "playback_completed", base + 1100);
  const metrics = finalizeLiveTurnLatencyMetrics(runtime);
  assert.ok(metrics.dialogue_plan_to_tts_started_ms != null);
  assert.ok(metrics.tts_started_to_first_chunk_ms != null);
  assert.ok(metrics.endpoint_to_first_playback_ms != null);
});

test("10N: barge_in_detected with epoch timestamp passes validation", () => {
  const config = loadConfig();
  const detector = markBargeInTriggered(createBargeInDetectorFromConfig(config), null, Date.now());
  const metrics = getBargeInMetrics(detector);
  const event = buildBargeInDetectedEvent({
    config,
    callSessionId: randomUUID(),
    metricValue: 95,
    payload: {
      bridge_call_id: randomUUID(),
      triggered_at: metrics.triggered_at,
      playback_ms_at_trigger: metrics.playback_ms_at_trigger,
      trigger_count: metrics.trigger_count
    }
  });
  const validation = validateQualityEventInput(event);
  assert.equal(validation.ok, true, validation.errors?.join("; "));
});

test("10N: interruption follow-up phrase detector", () => {
  assert.equal(isInterruptionFollowUpPhrase("Stopp, ich habe eine kurze Frage"), true);
  assert.equal(detectTranscriptIntent("Stopp, ich habe eine kurze Frage"), "interruption_followup");
});
