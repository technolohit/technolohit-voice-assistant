/**
 * Phase 12N — preserve split phone digits across VAD/STT endpoints without
 * exposing them outside protected orchestrator state.
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
import { CALLBACK_FLOW_STATES } from "../src/v4/callback-flow-policy.js";
import { RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { V4_STATES } from "../src/v4/state-machine.js";
import {
  extractPhoneCaptureFragment,
} from "../src/v4/spoken-phone-capture.js";
import {
  assertNoKnownSpokenPhoneInPayload,
  assertNoRawPhoneInPayload,
} from "../src/v4/privacy-sanitize.js";
import { safeTranscriptPreview } from "../src/v4/live-dialogue-endpoint.js";

const CAPTURED_PHONE = "015112345678";

function phonePendingMemory() {
  return {
    ...setSelectedProduct(createCallSessionMemory({ bridgeCallId: "12n" }), "smart_website"),
    current_product_context: "smart_website",
    contact_preference: "phone",
    contact_flow_pending: true,
    phone_capture_attempted: true,
    phone_capture_attempt_count: 0,
    callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
    current_state: V4_STATES.COLLECTING_PHONE_NUMBER,
  };
}

function createOrchestrator() {
  const config = loadConfig();
  const memory = phonePendingMemory();
  return createDialogueOrchestrator({
    config,
    runtimeContext: createRuntimeContext(config, { bridgeCallId: "12n" }),
    memory,
    stateMachine: { state: V4_STATES.COLLECTING_PHONE_NUMBER },
    agentConfig: loadAgentConfig(config),
    qualitySink: createQualityEventSink({ v4PathActive: true }),
    v4PathActive: true,
    callerPhoneNormalized: null,
  });
}

async function runTurn(orchestrator, transcript) {
  startTurn(orchestrator);
  acceptUserTranscript(orchestrator, transcript);
  const action = await decideNextAction(orchestrator, { transcript });
  commitAssistantPlanWithoutPlayback(orchestrator, action.plan?.text, action.plan);
  return action;
}

test("12N: numeric and spoken partial fragments are extracted deterministically", () => {
  assert.equal(extractPhoneCaptureFragment("Meine Nummer ist 0151"), "0151");
  assert.equal(extractPhoneCaptureFragment("null eins fuenf eins"), "0151");
  assert.equal(extractPhoneCaptureFragment("noch einen Moment"), "");
});

test("12N: live log preview redacts partial digits only in locked phone capture", () => {
  const memory = phonePendingMemory();
  assert.equal(safeTranscriptPreview("Meine Nummer ist 0151", 48, memory), "[phone_redacted]");
  assert.equal(
    safeTranscriptPreview("Was kostet eins zwei Smart Website?", 48, memory),
    "Was kostet eins zwei Smart Website?",
  );
});

test("12N: numeric phone split across endpoints reaches permission", async () => {
  const orchestrator = createOrchestrator();
  const first = await runTurn(orchestrator, "Meine Nummer ist 0151");

  assert.equal(first.plan.response_type, RESPONSE_TYPES.REQUEST_PHONE_RETRY);
  assert.equal(orchestrator.protectedPhoneCaptureFragment, "0151");
  assert.equal(orchestrator.memory.last_user_utterance, "[phone_redacted]");
  assert.equal(orchestrator.currentTurn.transcript, "[phone_redacted]");

  const second = await runTurn(orchestrator, "12345678");
  assert.equal(second.plan.response_type, RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION);
  assert.equal(second.plan.plan_reason, "phone_number_captured");
  assert.equal(second.plan.phone_capture_accumulated, true);
  assert.equal(second.plan.phone_capture_segment_count, 2);
  assert.equal(orchestrator.callerPhoneNormalized, CAPTURED_PHONE);
  assert.equal(orchestrator.protectedPhoneCaptureFragment, "");
});

test("12N: spoken digit fragments accumulate and finalize callback", async () => {
  const orchestrator = createOrchestrator();
  await runTurn(orchestrator, "null eins fuenf eins");
  const capture = await runTurn(
    orchestrator,
    "eins zwei drei vier fuenf sechs sieben acht",
  );
  assert.equal(capture.plan.response_type, RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION);
  assert.equal(orchestrator.callerPhoneNormalized, CAPTURED_PHONE);

  const finalized = await runTurn(orchestrator, "Ja.");
  assert.equal(finalized.plan.response_type, RESPONSE_TYPES.CALLBACK_FINALIZED);
  const closed = closeCall(orchestrator);
  assert.equal(closed.leadCandidate.callback_ready, true);
  assert.equal(closed.postCallHandoff.protectedNormalizedPhone, CAPTURED_PHONE);
});

test("12N: a repeated full number replaces the protected partial", async () => {
  const orchestrator = createOrchestrator();
  await runTurn(orchestrator, "Meine Nummer ist 015");
  const capture = await runTurn(orchestrator, "01511 2345678");

  assert.equal(capture.plan.response_type, RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION);
  assert.equal(capture.plan.phone_capture_accumulated, false);
  assert.equal(orchestrator.callerPhoneNormalized, CAPTURED_PHONE);
});

test("12N: exhausted invalid capture clears protected fragments", async () => {
  const orchestrator = createOrchestrator();
  await runTurn(orchestrator, "Meine Nummer ist 015");
  const failed = await runTurn(orchestrator, "zwei");

  assert.equal(failed.plan.response_type, RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW);
  assert.equal(failed.plan.plan_reason, "phone_capture_failed_after_retry");
  assert.equal(orchestrator.protectedPhoneCaptureFragment, "");
  assert.equal(orchestrator.protectedPhoneCaptureSegmentCount, 0);
});

test("12N: refusal clears a protected partial without exposing it", async () => {
  const orchestrator = createOrchestrator();
  await runTurn(orchestrator, "Meine Nummer ist 0151");
  const refused = await runTurn(orchestrator, "Nein, lieber nicht.");

  assert.equal(refused.plan.response_type, RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW);
  assert.equal(refused.plan.plan_reason, "phone_capture_refused");
  assert.equal(orchestrator.protectedPhoneCaptureFragment, "");
  assert.equal(orchestrator.protectedPhoneCaptureSegmentCount, 0);
  assert.doesNotMatch(JSON.stringify(refused.plan), /0151/);
});

test("12N: protected fragments never enter public payloads", async () => {
  const orchestrator = createOrchestrator();
  const firstText = "Meine Nummer ist 0151";
  const secondText = "12345678";
  const first = await runTurn(orchestrator, firstText);
  const second = await runTurn(orchestrator, secondText);
  await runTurn(orchestrator, "Ja.");
  const closed = closeCall(orchestrator);

  for (const payload of [
    first.plan,
    second.plan,
    orchestrator.lastPlan,
    serializeMemoryForPersistence(orchestrator.memory),
    closed.postCallHandoff.summaryMetadata,
    orchestrator.qualitySink.getBufferedQualityEvents(),
  ]) {
    assert.equal(assertNoRawPhoneInPayload(payload), true);
    assert.equal(assertNoKnownSpokenPhoneInPayload(payload, [firstText, secondText]), true);
    assert.doesNotMatch(JSON.stringify(payload), /0151|12345678|015112345678/);
  }
});
