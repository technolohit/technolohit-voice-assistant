/**
 * Phase 12M — protected captured callback phone persists to voice.leads only.
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
  finalizeV4PostCallHandoff,
  resolveProtectedNormalizedPhoneForLeadPersistence,
} from "../src/v4/post-call-bridge.js";
import { buildLeadCandidateFromMemory } from "../src/v4/lead-candidate.js";
import { resolveLeadNormalizedPhoneForPostCall } from "../src/post-call-lead.js";
import { notificationPayload } from "../src/post-call-notify.js";
import {
  assertNoKnownSpokenPhoneInPayload,
  assertNoRawPhoneInPayload,
} from "../src/v4/privacy-sanitize.js";

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
    ...extra,
  };
}

function createOrchestrator({ callerPhoneNormalized = null } = {}) {
  const config = loadConfig();
  return createDialogueOrchestrator({
    config,
    runtimeContext: createRuntimeContext(config, { bridgeCallId: "12m" }),
    memory: setSelectedProduct(createCallSessionMemory({ bridgeCallId: "12m" }), "smart_website"),
    stateMachine: { state: "listening" },
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

test("12M: resolveProtectedNormalizedPhoneForLeadPersistence requires callback_ready", () => {
  const candidate = buildLeadCandidateFromMemory(
    {
      contact_preference: "phone",
      callback_permission: "granted",
      product_interest: "smart_website",
    },
    { callerPhoneNormalized: CAPTURED_PHONE }
  );
  assert.equal(candidate.callback_ready, true);
  assert.equal(
    resolveProtectedNormalizedPhoneForLeadPersistence(candidate, {
      callerPhoneNormalized: CAPTURED_PHONE,
    }),
    CAPTURED_PHONE
  );
  assert.equal(
    resolveProtectedNormalizedPhoneForLeadPersistence(
      { ...candidate, callback_ready: false },
      { callerPhoneNormalized: CAPTURED_PHONE }
    ),
    ""
  );
});

test("12M: resolveLeadNormalizedPhoneForPostCall prefers v4 handoff over empty session", () => {
  const ctx = {
    v4PostCallHandoff: { protectedNormalizedPhone: CAPTURED_PHONE },
  };
  const session = { caller_phone_normalized: "", caller_phone_raw: "" };
  assert.equal(resolveLeadNormalizedPhoneForPostCall(ctx, session), CAPTURED_PHONE);
});

test("12M: resolveLeadNormalizedPhoneForPostCall falls back to session caller ID", () => {
  const ctx = { v4PostCallHandoff: { protectedNormalizedPhone: "" } };
  const session = { caller_phone_normalized: "+491701234567", caller_phone_raw: "" };
  assert.equal(resolveLeadNormalizedPhoneForPostCall(ctx, session), "+491701234567");
});

test("12M: full sequence produces callback_ready handoff with protected phone", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createOrchestrator({ callerPhoneNormalized: null });

    await runTurn(orchestrator, "Bitte rufen Sie mich telefonisch einfach zurück.");
    await runTurn(orchestrator, "Telefonisch bitte.");
    const capture = await runTurn(orchestrator, LIVE_NUMERIC_PHONE);
    assert.equal(capture.plan.response_type, RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION);
    assert.equal(orchestrator.callerPhoneNormalized, CAPTURED_PHONE);

    const finalized = await runTurn(orchestrator, "Ja.");
    assert.equal(finalized.plan.response_type, RESPONSE_TYPES.CALLBACK_FINALIZED);

    const closed = closeCall(orchestrator);
    assert.equal(closed.leadCandidate.callback_ready, true);
    assert.equal(closed.postCallHandoff.protectedNormalizedPhone, CAPTURED_PHONE);
    assert.equal(closed.postCallHandoff.summaryMetadata.phone_present, true);
    assert.doesNotMatch(JSON.stringify(closed.postCallHandoff.summaryMetadata), /015112345678/);
  });
});

test("12M: public payloads stay phone-safe after handoff", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createOrchestrator({ callerPhoneNormalized: null });
    await runTurn(orchestrator, "Bitte rufen Sie mich zurück.");
    await runTurn(orchestrator, "Telefonisch bitte.");
    await runTurn(orchestrator, LIVE_NUMERIC_PHONE);
    await runTurn(orchestrator, "Ja.");
    closeCall(orchestrator);

    assert.equal(orchestrator.lastPlan.captured_phone_normalized, undefined);
    assert.doesNotMatch(JSON.stringify(orchestrator.lastPlan), /015112345678/);

    const handoff = finalizeV4PostCallHandoff(orchestrator, {
      callerPhoneNormalized: orchestrator.callerPhoneNormalized,
    });
    assert.equal(handoff.protectedNormalizedPhone, CAPTURED_PHONE);
    assert.equal(handoff.privacy_ok, true);
    assert.doesNotMatch(JSON.stringify(handoff.summaryMetadata), /015112345678/);

    const payload = notificationPayload(
      { callSessionId: "sess-12m", bridgeCallId: "12m", externalCallId: "ext-12m" },
      { summaryId: "sum-12m", summaryText: "done", metadata: handoff.summaryMetadata },
      { action: "created", reason: "summary_guard_passed", leadId: "lead-12m" }
    );
    assert.equal(assertNoRawPhoneInPayload(payload), true);
    assert.equal(assertNoKnownSpokenPhoneInPayload(payload, [LIVE_NUMERIC_PHONE]), true);
    assert.equal(payload.summary?.permission, "granted");

    const serialized = serializeMemoryForPersistence(orchestrator.memory);
    assert.equal(assertNoRawPhoneInPayload(serialized), true);
  });
});

test("12M: manual review without phone does not expose protected persistence", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createOrchestrator({ callerPhoneNormalized: null });
    await runTurn(orchestrator, "Bitte rufen Sie mich zurück.");
    await runTurn(orchestrator, "Telefonisch bitte.");
    const failed = await runTurn(orchestrator, "Meine Nummer ist 015.");
    assert.equal(failed.plan.response_type, RESPONSE_TYPES.REQUEST_PHONE_RETRY);
    const exhausted = await runTurn(orchestrator, "Meine Nummer ist 015.");
    assert.equal(exhausted.plan.response_type, RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW);
    const closed = closeCall(orchestrator);
    assert.equal(closed.leadCandidate.callback_ready, false);
    assert.equal(closed.postCallHandoff.protectedNormalizedPhone, "");
  });
});
