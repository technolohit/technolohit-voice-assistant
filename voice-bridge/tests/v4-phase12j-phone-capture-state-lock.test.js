/**
 * Phase 12J — locked phone-capture sub-state, partial retry, and barge-in repair.
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
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import {
  CALLBACK_FLOW_STATES,
  resolveCallbackFlowState,
} from "../src/v4/callback-flow-policy.js";
import { runLiveDialogueOnCallerTranscript } from "../src/v4/live-dialogue-endpoint.js";
import { createLiveCanaryRuntime } from "../src/v4/canary-runtime-loop.js";
import {
  executeLivePhoneCapturePlaybackCancel,
} from "../src/v4/live-barge-in-endpoint.js";
import { shouldUseRagForTurn } from "../src/v4/rag-orchestrator.js";
import { applyQuestionnaireRuntimeToPlan } from "../src/v4/questionnaire-runtime.js";
import { finalizeV4PostCallHandoff } from "../src/v4/post-call-bridge.js";
import { notificationPayload } from "../src/post-call-notify.js";
import {
  assertNoKnownSpokenPhoneInPayload,
  assertNoRawPhoneInPayload,
} from "../src/v4/privacy-sanitize.js";
import { resolvePhoneCaptureEndpointSilenceMs } from "../src/v4/phone-capture-policy.js";
import { V4_STATES } from "../src/v4/state-machine.js";
import { createPlaybackController, startPlayback } from "../src/v4/playback-controller.js";

const LIVE_NUMERIC_PHONE = "Meine Nummer ist 01511 2345678.";
const CAPTURED_PHONE = "015112345678";

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
    VOICE_V4_BARGE_IN_ENABLED: "true",
    VOICE_RAG_ENABLED: "true",
    VOICE_RAG_SALES_ANSWERER_ENABLED: "true",
    ...extra,
  };
}

function phonePendingMemory(extra = {}) {
  return {
    ...setSelectedProduct(createCallSessionMemory({ bridgeCallId: "12j" }), "smart_website"),
    current_product_context: "smart_website",
    contact_preference: "phone",
    contact_flow_pending: true,
    phone_capture_attempted: true,
    phone_capture_attempt_count: 0,
    callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
    current_state: V4_STATES.COLLECTING_PHONE_NUMBER,
    ...extra,
  };
}

function createOrchestrator({ callerPhoneNormalized = null, memory = null } = {}) {
  const config = loadConfig();
  return createDialogueOrchestrator({
    config,
    runtimeContext: createRuntimeContext(config, { bridgeCallId: "12j" }),
    memory: memory ?? phonePendingMemory(),
    stateMachine: { state: memory?.current_state ?? V4_STATES.COLLECTING_PHONE_NUMBER },
    agentConfig: loadAgentConfig(config),
    qualitySink: createQualityEventSink({ v4PathActive: true }),
    v4PathActive: true,
    callerPhoneNormalized,
  });
}

async function runTurn(orchestrator, transcript, extra = {}) {
  startTurn(orchestrator);
  acceptUserTranscript(orchestrator, transcript);
  const action = await decideNextAction(orchestrator, { transcript, ...extra });
  commitAssistantPlanWithoutPlayback(orchestrator, action.plan?.text, action.plan);
  return action;
}

test("12J: Phase 12I sequence passes through permission to callback_finalized", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createOrchestrator({ callerPhoneNormalized: null });
    orchestrator.memory = {
      ...setSelectedProduct(createCallSessionMemory({ bridgeCallId: "12j-seq" }), "smart_website"),
      current_state: V4_STATES.LISTENING,
    };
    orchestrator.stateMachine = { state: V4_STATES.LISTENING };

    await runTurn(orchestrator, "Bitte rufen Sie mich telefonisch einfach zurück.");
    const phonePref = await runTurn(orchestrator, "Telefonisch bitte.");
    assert.equal(phonePref.plan.response_type, RESPONSE_TYPES.REQUEST_PHONE_ONCE);

    const capture = await runTurn(orchestrator, LIVE_NUMERIC_PHONE);
    assert.equal(capture.intent, "phone_number_candidate");
    assert.equal(capture.plan.response_type, RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION);
    assert.equal(orchestrator.callerPhoneNormalized, CAPTURED_PHONE);

    const finalized = await runTurn(orchestrator, "Ja.");
    assert.equal(finalized.plan.response_type, RESPONSE_TYPES.CALLBACK_FINALIZED);
    closeCall(orchestrator);
    assert.equal(orchestrator.leadCandidate.callback_ready, true);
  });
});

test("12J: partial phone stays in PHONE_NUMBER_PENDING with retry", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createOrchestrator({ callerPhoneNormalized: null });
    const action = await runTurn(orchestrator, "Meine Nummer ist 015");

    assert.equal(action.intent, "phone_capture_partial");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.REQUEST_PHONE_RETRY);
    assert.equal(action.plan.plan_reason, "phone_capture_partial_or_incomplete");
    assert.equal(
      resolveCallbackFlowState(orchestrator.memory),
      CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING
    );
    assert.equal(orchestrator.memory.phone_capture_attempt_count, 1);
  });
});

test("12J: retry then success finalizes callback", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createOrchestrator({
      memory: phonePendingMemory({ phone_capture_attempt_count: 1 }),
      callerPhoneNormalized: null,
    });
    const capture = await runTurn(orchestrator, LIVE_NUMERIC_PHONE);
    assert.equal(capture.plan.response_type, RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION);

    const finalized = await runTurn(orchestrator, "Ja.");
    assert.equal(finalized.plan.response_type, RESPONSE_TYPES.CALLBACK_FINALIZED);
  });
});

test("12J: retry exhaustion yields phone_capture_failed_after_retry", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createOrchestrator({
      memory: phonePendingMemory({ phone_capture_attempt_count: 1 }),
      callerPhoneNormalized: null,
    });
    const action = await runTurn(orchestrator, "null eins zwei");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW);
    assert.equal(action.plan.plan_reason, "phone_capture_failed_after_retry");

    closeCall(orchestrator);
    assert.equal(orchestrator.leadCandidate.validation.reason, "phone_capture_failed_after_retry");
    assert.notEqual(orchestrator.leadCandidate.validation.reason, "callback_permission_missing");
  });
});

test("12J: refusal during phone pending yields phone_capture_refused manual review", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createOrchestrator({ callerPhoneNormalized: null });
    const action = await runTurn(orchestrator, "Nein, lieber nicht.");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW);
    assert.equal(action.plan.plan_reason, "phone_capture_refused");
  });
});

test("12J: RAG, questionnaire, product QA, and fallback blocked while phone pending", async () => {
  await withEnv(canaryEnv({ VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true" }), async () => {
    const config = loadConfig();
    const memory = phonePendingMemory();
    const transcript = "Was kostet Smart Website?";

    const ragGate = shouldUseRagForTurn({
      config,
      state: V4_STATES.COLLECTING_PHONE_NUMBER,
      intent: "phone_capture_partial",
      memory,
      transcript,
    });
    assert.equal(ragGate.allowed, false);

    const plan = buildResponsePlan({
      agentConfig: loadAgentConfig(config),
      memory,
      stateMachine: { state: V4_STATES.COLLECTING_PHONE_NUMBER },
      transcript,
      intent: "phone_capture_partial",
      config,
      v4PathActive: true,
    });
    const withQuestionnaire = applyQuestionnaireRuntimeToPlan(plan, {
      config,
      memory,
      resolvedIntent: "phone_capture_partial",
      v4PathActive: true,
    });
    assert.equal(withQuestionnaire.questionnaire?.used ?? false, false);
    assert.equal(plan.response_type, RESPONSE_TYPES.REQUEST_PHONE_RETRY);
    assert.notEqual(plan.response_type, RESPONSE_TYPES.FALLBACK_CLARIFICATION);
    assert.notEqual(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
  });
});

test("12J: closing still wins while phone pending", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createOrchestrator({ callerPhoneNormalized: null });
    const action = await runTurn(orchestrator, "Danke, das reicht erstmal.");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.CLOSING);
  });
});

test("12J: barge-in during request_phone_once does not open interruption recovery", async () => {
  await withEnv(canaryEnv({ VOICE_V4_STT_PROVIDER: "mock" }), async () => {
    const config = loadConfig();
    const ctx = { bridgeCallId: "12j-barge", callSessionId: "00000000-0000-0000-0000-0000000012j1" };
    const runtime = createLiveCanaryRuntime(config, ctx, { allowMockStt: true });
    assert.equal(runtime.ok, true);
    ctx.v4LiveRuntime = runtime;

    runtime.runtimeContext.memory = phonePendingMemory();
    runtime.runtimeContext.stateMachine.state = V4_STATES.COLLECTING_PHONE_NUMBER;
    runtime.lastAssistantPlanCandidate = { response_type: RESPONSE_TYPES.REQUEST_PHONE_ONCE };
    runtime.playbackInFlight = true;
    runtime.playback = startPlayback(
      createPlaybackController({ enabled: true, bridgeCallId: "12j-barge", turnIndex: 1, label: "request_phone_once" }),
      Date.now(),
    );

    const result = executeLivePhoneCapturePlaybackCancel(
      config,
      ctx,
      runtime,
      Date.now(),
      Buffer.alloc(320),
      runtime.playback,
    );

    assert.equal(result.cancelled, true);
    assert.equal(result.reason, "phone_capture_continuation");
    assert.equal(runtime.pendingInterruptionRecovery, false);
    assert.equal(runtime.interruptionContext, null);
    assert.equal(runtime.runtimeContext.memory.callback_flow_state, CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING);
  });
});

test("12J: live dialogue with interruption recovery still captures phone", async () => {
  await withEnv(canaryEnv({ VOICE_V4_STT_PROVIDER: "mock" }), async () => {
    const config = loadConfig();
    const ctx = {
      bridgeCallId: "12j-live-interrupt",
      callSessionId: "00000000-0000-0000-0000-0000000012j2",
    };
    const runtime = createLiveCanaryRuntime(config, ctx, { allowMockStt: true });
    ctx.v4LiveRuntime = runtime;
    runtime.runtimeContext.memory = phonePendingMemory();
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
  });
});

test("12J: extended endpoint silence while collecting phone number", () => {
  const config = loadConfig();
  const memory = phonePendingMemory();
  const extended = resolvePhoneCaptureEndpointSilenceMs(config, memory);
  const normal = resolvePhoneCaptureEndpointSilenceMs(config, { callback_flow_state: "none" });
  assert.ok(extended > normal);
  assert.equal(extended, 1200);
});

test("12J: privacy — no raw phone in plan, memory, summary, or notification", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createOrchestrator({ callerPhoneNormalized: null });
    await runTurn(orchestrator, LIVE_NUMERIC_PHONE);
    await runTurn(orchestrator, "Ja.");
    closeCall(orchestrator);

    assert.equal(orchestrator.lastPlan.captured_phone_normalized, undefined);
    assert.doesNotMatch(JSON.stringify(orchestrator.lastPlan), /015112345678/);
    const serialized = serializeMemoryForPersistence(orchestrator.memory);
    assert.equal(assertNoRawPhoneInPayload(serialized), true);

    const handoff = finalizeV4PostCallHandoff(orchestrator, {
      callerPhoneNormalized: orchestrator.callerPhoneNormalized,
    });
    assert.equal(handoff.privacy_ok, true);
    const payload = notificationPayload(
      { callSessionId: "sess-12j", bridgeCallId: "12j-privacy", externalCallId: "ext-12j" },
      { summaryId: "sum-12j", summaryText: "done", metadata: handoff.summaryMetadata },
      { action: "skipped", reason: "guard_not_met", leadId: "" },
    );
    assert.equal(assertNoRawPhoneInPayload(payload), true);
    assert.equal(assertNoKnownSpokenPhoneInPayload(payload, [LIVE_NUMERIC_PHONE]), true);
  });
});
