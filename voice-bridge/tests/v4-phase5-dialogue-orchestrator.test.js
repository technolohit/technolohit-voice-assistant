import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import {
  resolveRuntimeRoute,
  routeIncomingCallToRuntime,
  routeCanaryDialogueRuntime,
  canPrepareV4Dialogue
} from "../src/v4/runtime-router.js";
import {
  createCanaryDialogueRuntime,
  simulateInboundTranscriptTurn,
  simulateAssistantPlayback,
  simulateBargeInDuringPlayback,
  finalizeCanaryTurn,
  closeCanaryDialogueRuntime
} from "../src/v4/canary-runtime-loop.js";
import {
  createDialogueOrchestrator,
  tryLeadReadyTransition,
  markLeadCandidate,
  handleInterruption
} from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { createQualityEventSink, isQualityEventSinkWritable } from "../src/v4/quality-event-sink.js";
import {
  buildResponsePlan,
  RESPONSE_TYPES,
  sanitizeResponseText
} from "../src/v4/response-planner.js";
import { V4_STATES } from "../src/v4/state-machine.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";
import { validateQualityEventInput } from "../src/v4/quality-events.js";
import { ragAnswerMustNotCreateLead } from "../src/v4/lead-validator.js";

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

function dialogueEnv(overrides = {}) {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_V4_BARGE_IN_ENABLED: "false",
    VOICE_AGENT_CONFIG_PATH: undefined,
    ...overrides
  };
}

test("default production route remains v3", () => {
  withEnv({ VOICE_RUNTIME_VERSION: undefined }, () => {
    const config = loadConfig();
    assert.equal(resolveRuntimeRoute(config).runtime, "v3");
    assert.equal(routeIncomingCallToRuntime(config).handler, "v3");
    assert.equal(routeCanaryDialogueRuntime(config).handler, "v3");
  });
});

test("v4 canary dialogue runtime only with harnessExplicit", () => {
  withEnv(dialogueEnv(), () => {
    const config = loadConfig();
    assert.equal(canPrepareV4Dialogue(config), true);
    const blocked = routeCanaryDialogueRuntime(config, { bridgeCallId: "live-1" });
    assert.equal(blocked.handler, "v3");
    assert.equal(blocked.dropCall, false);
    assert.equal(blocked.runtime, null);

    const harness = routeCanaryDialogueRuntime(config, { harnessExplicit: true, bridgeCallId: "h1" });
    assert.equal(harness.handler, "v4_canary_dialogue_stub");
    assert.equal(harness.dropCall, false);
    assert.ok(harness.runtime.orchestrator);
  });
});

test("resolveRuntimeRoute reports dialogue stub reason without barge-in", () => {
  withEnv(dialogueEnv(), () => {
    const route = resolveRuntimeRoute(loadConfig());
    assert.equal(route.dialogueReady, true);
    assert.equal(route.reason, "v4_canary_dialogue_stub_phase5");
  });
});

test("product question updates memory and state", async () => {
  await withEnv(dialogueEnv(), async () => {
    const runtime = createCanaryDialogueRuntime(loadConfig(), {
      harnessExplicit: true,
      bridgeCallId: "pq-1"
    });
    const turn = await simulateInboundTranscriptTurn(runtime, "Was ist Smart Website?");
    assert.equal(turn.plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
    assert.equal(turn.plan.rag_allowed, true);
    assert.equal(turn.memory.selected_product_id, "smart_website");
    assert.equal(turn.stateMachine.state, V4_STATES.SPEAKING);
  });
});

test("sales context collection updates memory", async () => {
  await withEnv(dialogueEnv(), async () => {
    const runtime = createCanaryDialogueRuntime(loadConfig(), { harnessExplicit: true });
    await simulateInboundTranscriptTurn(runtime, "Ich interessiere mich für Smart Website");
    const turn = await simulateInboundTranscriptTurn(runtime, "Wir sind Neukunde");
    assert.equal(turn.memory.customer_type, "new_prospect");
    assert.equal(turn.plan.response_type, RESPONSE_TYPES.COLLECT_SALES_CONTEXT);
  });
});

test("interruption product switch changes selected product", async () => {
  await withEnv(dialogueEnv({ VOICE_V4_BARGE_IN_MIN_PLAYBACK_MS: "0", VOICE_V4_VAD_RMS_THRESHOLD: "400" }), async () => {
    const config = loadConfig();
    const runtime = createCanaryDialogueRuntime(config, { harnessExplicit: true, bridgeCallId: "sw-1" });
    await simulateInboundTranscriptTurn(runtime, "Erzählen Sie mir über Smart Website");
    simulateAssistantPlayback(runtime, { frames: 2 });

    const bargeIn = await simulateBargeInDuringPlayback(runtime, {
      speechFrames: 4,
      amplitude: 1000,
      callerText: "Stopp, ich meine Digitale Rezeption"
    });
    assert.equal(bargeIn.ok, true);
    assert.equal(bargeIn.interruption.recovery.recoveryAction, "product_switch");
    assert.equal(bargeIn.interruption.memory.selected_product_id, "voice_agent");
    assert.notEqual(bargeIn.interruption.memory.selected_product_id, "smart_website");
  });
});

test("RAG plan is product Q&A only and cannot create lead", () => {
  withEnv(dialogueEnv(), () => {
    const agent = loadAgentConfig(loadConfig());
    const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "rag-1" }), "smart_website");
    const plan = buildResponsePlan({
      agentConfig: agent,
      memory,
      stateMachine: { state: V4_STATES.THINKING },
      transcript: "Was ist Smart Website?",
      ragAnswer: "Kurzantwort aus Wissensbasis."
    });
    assert.equal(plan.rag_allowed, true);
    assert.equal(plan.lead_transition_allowed, false);
    assert.equal(ragAnswerMustNotCreateLead(true).createsLead, false);
  });
});

test("lead-ready requires validator approval", () => {
  withEnv(dialogueEnv(), () => {
    const config = loadConfig();
    const ctx = createRuntimeContext(config, { bridgeCallId: "lead-1" });
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: ctx,
      v4PathActive: true
    });
    orchestrator.memory = {
      ...orchestrator.memory,
      contact_preference: "phone",
      callback_permission: "granted",
      phone_present: false
    };
    const failed = tryLeadReadyTransition(orchestrator);
    assert.equal(failed.ok, false);
    assert.equal(orchestrator.memory.lead_ready, false);

    orchestrator.stateMachine = { ...orchestrator.stateMachine, state: V4_STATES.VALIDATING_CONTACT };
    const ok = tryLeadReadyTransition(orchestrator, {
      callerPhoneNormalized: "+491701234567",
      explicitUserPermission: true
    });
    assert.equal(ok.ok, true);
    assert.equal(orchestrator.memory.lead_ready, true);
  });
});

test("email path remains non-callback ready", async () => {
  await withEnv(dialogueEnv(), async () => {
    const runtime = createCanaryDialogueRuntime(loadConfig(), { harnessExplicit: true });
    const turn = await simulateInboundTranscriptTurn(runtime, "Lieber per E-Mail");
    assert.equal(turn.plan.response_type, RESPONSE_TYPES.EMAIL_GUIDANCE);
    assert.equal(turn.memory.contact_preference, "email");
    assert.equal(turn.memory.lead_ready, false);
  });
});

test("markLeadCandidate does not set lead_ready", () => {
  withEnv(dialogueEnv(), () => {
    const ctx = createRuntimeContext(loadConfig(), { bridgeCallId: "cand-1" });
    const orchestrator = createDialogueOrchestrator({ config: loadConfig(), runtimeContext: ctx, v4PathActive: true });
    markLeadCandidate(orchestrator, { contact_preference: "phone" });
    assert.equal(orchestrator.memory.lead_ready, false);
    assert.equal(orchestrator.memory.contact_preference, "phone");
  });
});

test("quality event sink buffers redacts and flushes v4-only", async () => {
  withEnv(dialogueEnv(), () => {
    const config = loadConfig();
    const inserts = [];
    const sink = createQualityEventSink({
      v4PathActive: true,
      insertFn: async (event) => {
        inserts.push(event);
      }
    });
    const bad = sink.bufferQualityEvent({
      tenantId: "technolohit",
      agentId: "main_voice_sales",
      eventType: "turn_started",
      payload: { caller_phone: "+491701234567" }
    });
    assert.equal(bad.ok, true);
    assert.equal(sink.getBufferedQualityEvents()[0].payload.caller_phone, "[redacted]");

    const v3Sink = createQualityEventSink({ v4PathActive: false, insertFn: async () => {} });
    v3Sink.bufferQualityEvent({
      tenantId: "t",
      agentId: "a",
      eventType: "turn_started",
      payload: {}
    });
    return v3Sink.flushQualityEvents().then((v3Flush) => {
      assert.equal(v3Flush.ok, false);
      assert.equal(v3Flush.reason, "v3_path_no_flush");
      return sink.flushQualityEvents().then((v4Flush) => {
        assert.equal(v4Flush.ok, true);
        assert.equal(v4Flush.flushed, 1);
        assert.equal(isQualityEventSinkWritable(sink, config), true);
      });
    });
  });
});

test("orchestrator buffers events without DB on memory-only sink", async () => {
  await withEnv(dialogueEnv(), async () => {
    const runtime = createCanaryDialogueRuntime(loadConfig(), { harnessExplicit: true });
    await simulateInboundTranscriptTurn(runtime, "Smart Website bitte");
    const events = runtime.qualitySink.getBufferedQualityEvents();
    assert.ok(events.length >= 3);
    for (const event of events) {
      assert.equal(validateQualityEventInput(event).ok, true);
    }
    assert.equal(runtime.qualitySink.insertFn, null);
  });
});

test("response text avoids Rückruf wording", () => {
  const sanitized = sanitizeResponseText("Möchten Sie einen Rückruf?");
  assert.doesNotMatch(sanitized, /rückruf|rueckruf|ruckruf/i);
});

test("canary loop finalize turn completes without drop", async () => {
  await withEnv(dialogueEnv(), async () => {
    const runtime = createCanaryDialogueRuntime(loadConfig(), { harnessExplicit: true });
    await simulateInboundTranscriptTurn(runtime, "Smart Website");
    const finalized = await finalizeCanaryTurn(runtime);
    assert.equal(finalized.ok, true);
    assert.equal(finalized.stateMachine.state, V4_STATES.LISTENING);
    const closed = closeCanaryDialogueRuntime(runtime);
    assert.equal(closed.ok, true);
    assert.equal(closed.stateMachine.state, V4_STATES.COMPLETED);
  });
});

test("handleInterruption preserves recovery plan", async () => {
  await withEnv(dialogueEnv(), async () => {
    const config = loadConfig();
    const agent = loadAgentConfig(config);
    const ctx = createRuntimeContext(config, { bridgeCallId: "int-1" });
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: ctx,
      agentConfig: agent,
      v4PathActive: true,
      qualitySink: createQualityEventSink({ v4PathActive: true })
    });
    orchestrator.memory = setSelectedProduct(orchestrator.memory, "smart_website");
    orchestrator.stateMachine = { ...orchestrator.stateMachine, state: V4_STATES.SPEAKING };
    orchestrator.lastAssistantText = "Smart Website erklärt...";
    orchestrator.playback = {
      playbackId: "pb-test",
      bridgeCallId: "int-1",
      turnIndex: 1,
      status: "cancel_requested",
      startedAt: Date.now() - 200,
      framesSent: 3,
      bytesSent: 960,
      cancelReason: "barge_in",
      cancelLatencyMs: 200,
      stoppedByBargeIn: true
    };

    const result = await handleInterruption(orchestrator, {
      callerText: "Stopp, Digitale Rezeption bitte"
    });
    assert.equal(result.recovery.recoveryAction, "product_switch");
    assert.equal(result.memory.selected_product_id, "voice_agent");
  });
});
