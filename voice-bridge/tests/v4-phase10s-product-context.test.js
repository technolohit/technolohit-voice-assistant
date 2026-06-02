import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import {
  beginInterruptFollowupWaitOnBargeIn,
  processInterruptFollowupAfterStt,
} from "../src/v4/interrupt-followup-wait.js";
import { splitInterruptMarkerAndContinuation } from "../src/v4/interrupt-marker-split.js";
import {
  resolveInterruptionRecovery,
  captureInterruptedAssistantState,
} from "../src/v4/interruption-context.js";
import { clearStaleInterruptionRecovery } from "../src/v4/interrupt-followup-cycle.js";
import {
  resolveClosedDomainIntent,
} from "../src/v4/closed-domain-intent.js";
import {
  resolveInterruptSequenceId,
  isGenericScopedProductQuestion,
} from "../src/v4/product-context-persistence.js";
import {
  validateQualityEventInput,
  TIMING_TELEMETRY_PAYLOAD_KEYS,
} from "../src/v4/quality-events.js";
import {
  decideNextAction,
  commitAssistantPlanWithoutPlayback,
  createDialogueOrchestrator,
  startTurn,
  acceptUserTranscript,
} from "../src/v4/dialogue-orchestrator.js";
import { setSelectedProduct, createCallSessionMemory } from "../src/v4/call-session-memory.js";
import { V4_STATES } from "../src/v4/state-machine.js";

function makeMemory(productId = "voice_agent") {
  return setSelectedProduct(createCallSessionMemory({ bridgeCallId: "s-test" }), productId);
}

function switchToSmartWebsite(agent, memory) {
  return resolveInterruptionRecovery({
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
}

test("10S: after switch Was kostet das answers smart_website pricing", () => {
  const agent = loadAgentConfig(loadConfig());
  const recovery = switchToSmartWebsite(agent, makeMemory("voice_agent"));
  const memory = recovery.memory;
  assert.equal(memory.current_product_context, "smart_website");

  const plan = buildResponsePlan({
    agentConfig: agent,
    memory,
    stateMachine: { state: "listening" },
    transcript: "Was kostet das?",
    ragGate: { allowed: false },
  });
  assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
  assert.match(plan.text, /individuell|kalkuliert/i);
  assert.equal(plan.memory_patch.current_product_context, "smart_website");
});

test("10S: after switch Wie funktioniert das answers smart_website capability", () => {
  const agent = loadAgentConfig(loadConfig());
  const memory = switchToSmartWebsite(agent, makeMemory()).memory;
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory,
    stateMachine: { state: "listening" },
    transcript: "Wie funktioniert das?",
    ragGate: { allowed: false },
  });
  assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
  assert.equal(plan.memory_patch.current_product_context, "smart_website");
  assert.doesNotMatch(plan.text, /nicht ganz verstanden/i);
});

test("10S: Stopp. Wie funktioniert das splits and answers in context", () => {
  const split = splitInterruptMarkerAndContinuation("Stopp. Wie funktioniert das?");
  assert.equal(split.continuation, "Wie funktioniert das?");

  const agent = loadAgentConfig(loadConfig());
  const memory = setSelectedProduct(makeMemory(), "smart_website");
  memory.current_product_context = "smart_website";

  const plan = buildResponsePlan({
    agentConfig: agent,
    memory,
    stateMachine: { state: "listening" },
    transcript: split.continuation,
    ragGate: { allowed: false },
  });
  assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
  assert.notEqual(plan.response_type, RESPONSE_TYPES.FALLBACK_CLARIFICATION);
  assert.notEqual(plan.next_state, V4_STATES.COLLECTING_SALES_CONTEXT);
});

test("10S: generic question with known context never fallback_clarification", () => {
  const agent = loadAgentConfig(loadConfig());
  const memory = setSelectedProduct(makeMemory(), "smart_website");
  memory.current_product_context = "smart_website";
  for (const q of ["Was kostet das?", "Was kann das?", "Erklär mir das kurz."]) {
    const plan = buildResponsePlan({
      agentConfig: agent,
      memory,
      stateMachine: { state: "listening" },
      transcript: q,
      ragGate: { allowed: false },
    });
    assert.notEqual(plan.response_type, RESPONSE_TYPES.FALLBACK_CLARIFICATION, q);
  }
});

test("10S: generic question does not enter collect_sales_context", () => {
  const agent = loadAgentConfig(loadConfig());
  const memory = switchToSmartWebsite(agent, makeMemory()).memory;
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory,
    stateMachine: { state: "listening" },
    transcript: "Was kostet das?",
    ragGate: { allowed: false },
  });
  assert.notEqual(plan.next_state, V4_STATES.COLLECTING_SALES_CONTEXT);
  assert.notEqual(plan.response_type, RESPONSE_TYPES.COLLECT_SALES_CONTEXT);
});

test("10S: interrupt_sequence_id stable across started and continuation", () => {
  const config = loadConfig();
  const runtime = {
    runtimeContext: {
      agentConfig: loadAgentConfig(config),
      memory: makeMemory(),
      stateMachine: { state: "listening" },
    },
    qualityEventsBuffer: [],
  };
  const ctx = { bridgeCallId: "s-seq", callSessionId: randomUUID() };
  beginInterruptFollowupWaitOnBargeIn(runtime, config, ctx, Date.now());
  processInterruptFollowupAfterStt(config, ctx, runtime, "Stopp");
  processInterruptFollowupAfterStt(config, ctx, runtime, "Was kostet das?");

  const started = runtime.qualityEventsBuffer.find(
    (e) => e.eventType === "interrupt_followup_started",
  );
  assert.equal(started.payload.interrupt_sequence_id, "interrupt-1");

  const cont = runtime.qualityEventsBuffer.find(
    (e) => e.eventType === "interrupt_followup_continuation_received",
  );
  assert.equal(cont.payload.interrupt_sequence_id, "interrupt-1");
  assert.equal(cont.payload.parent_single_stop_detected, true);
});

test("10S: response_plan_created includes safe context fields", async () => {
  const config = loadConfig();
  const agent = loadAgentConfig(config);
  const memory = setSelectedProduct(makeMemory(), "smart_website");
  memory.current_product_context = "smart_website";
  memory.previous_product_context = "voice_agent";

  const events = [];
  const orchestrator = createDialogueOrchestrator({
    config,
    runtimeContext: {
      agentConfig: agent,
      memory,
      stateMachine: { state: V4_STATES.LISTENING },
    },
    memory,
    stateMachine: { state: V4_STATES.LISTENING },
    agentConfig: agent,
    adapters: {},
    qualitySink: {
      v4PathActive: true,
      bufferQualityEvent(event) {
        events.push(event);
        return { ok: true };
      },
    },
    v4PathActive: true,
  });
  orchestrator.activeInterruptSequenceId = "interrupt-2";

  startTurn(orchestrator);
  acceptUserTranscript(orchestrator, "Was kostet das?");
  const action = await decideNextAction(orchestrator, {
    transcript: "Was kostet das?",
    interrupt_sequence_id: "interrupt-2",
  });
  commitAssistantPlanWithoutPlayback(orchestrator, action.plan.text, action.plan);

  const evt = events.find((e) => e.eventType === "response_plan_created");
  assert.ok(evt);
  assert.equal(evt.payload.interrupt_sequence_id, "interrupt-2");
  assert.equal(evt.payload.current_product_context, "smart_website");
  assert.equal(evt.payload.previous_product_context, "voice_agent");
  assert.equal(evt.payload.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
  assert.ok(evt.payload.plan_reason);
});

test("10S: clearStale keeps smart_website product context", () => {
  const runtime = {
    pendingInterruptionRecovery: true,
    interruptionContext: { interrupted_product_id: "voice_agent" },
    runtimeContext: {
      memory: {
        ...makeMemory("smart_website"),
        current_product_context: "smart_website",
        previous_product_context: "voice_agent",
        interruption_context: { interrupted_product_id: "voice_agent" },
      },
      stateMachine: { state: "interrupted" },
    },
  };
  clearStaleInterruptionRecovery(runtime);
  assert.equal(runtime.runtimeContext.memory.interruption_context, null);
  assert.equal(runtime.runtimeContext.memory.selected_product_id, "smart_website");
  assert.equal(runtime.runtimeContext.memory.current_product_context, "smart_website");
});

test("10S: isGenericScopedProductQuestion detects deictic phrases", () => {
  assert.equal(isGenericScopedProductQuestion("Was kostet das?"), true);
  assert.equal(isGenericScopedProductQuestion("Kannst du das erklären?"), true);
});

test("10S: privacy accepts interrupt_sequence_id", () => {
  assert.equal(
    validateQualityEventInput({
      eventType: "turn_started",
      tenantId: "technolohit",
      agentId: "main_voice_sales",
      payload: {
        interrupt_sequence_id: "interrupt-3",
        parent_single_stop_detected: true,
        current_product_context: "smart_website",
      },
    }).ok,
    true,
  );
  for (const key of TIMING_TELEMETRY_PAYLOAD_KEYS) {
    assert.equal(
      validateQualityEventInput({
        eventType: "interrupt_followup_started",
        tenantId: "t",
        agentId: "a",
        payload: { [key]: 1735689600123, interrupt_sequence_id: "interrupt-1" },
      }).ok,
      true,
    );
  }
});

test("10S: v3 path unchanged without selected product", () => {
  const agent = loadAgentConfig(loadConfig());
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory: makeMemory(),
    stateMachine: { state: "listening" },
    transcript: "Hallo",
    ragGate: { allowed: false },
  });
  assert.ok(plan.response_type);
});
