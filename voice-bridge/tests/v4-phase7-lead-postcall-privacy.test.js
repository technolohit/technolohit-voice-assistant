import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { resolveRuntimeRoute, routeIncomingCallToRuntime } from "../src/v4/runtime-router.js";
import {
  createCanaryDialogueRuntime,
  simulateInboundTranscriptTurn,
  closeCanaryDialogueRuntime
} from "../src/v4/canary-runtime-loop.js";
import {
  createDialogueOrchestrator,
  tryLeadReadyTransition,
  closeCall
} from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { createQualityEventSink } from "../src/v4/quality-event-sink.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";
import {
  validateCallbackReadyLead,
  validatePhoneForCallback,
  ragAnswerMustNotCreateLead,
  assertRagCannotSetLeadReady
} from "../src/v4/lead-validator.js";
import {
  buildLeadCandidateFromMemory,
  INCOMPLETE_SPOKEN_PHONE_EXAMPLES,
  leadCandidateMustNotUseTeamCallback
} from "../src/v4/lead-candidate.js";
import {
  buildV4PostCallSummaryMetadata,
  mergeV4SummaryMetadataPatch,
  finalizeV4PostCallHandoff
} from "../src/v4/post-call-bridge.js";
import {
  maskPhoneForExternal,
  assertNoRawPhoneInPayload,
  buildPostCallIdempotencyKey,
  sanitizeOutboundObject
} from "../src/v4/privacy-sanitize.js";
import { notificationPayload } from "../src/post-call-notify.js";
import { validateQualityEventInput } from "../src/v4/quality-events.js";
import { retrieveV4RagAnswer } from "../src/v4/rag-orchestrator.js";
import { RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { V4_STATES } from "../src/v4/state-machine.js";

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
    ...overrides
  };
}

function phoneMemory(overrides = {}) {
  return {
    ...setSelectedProduct(createCallSessionMemory({ bridgeCallId: "lead-1" }), "smart_website"),
    customer_type: "new_prospect",
    contact_preference: "phone",
    callback_permission: "granted",
    ...overrides
  };
}

test("default production route remains v3", () => {
  withEnv({ VOICE_RUNTIME_VERSION: undefined }, () => {
    const config = loadConfig();
    assert.equal(resolveRuntimeRoute(config).runtime, "v3");
    assert.equal(routeIncomingCallToRuntime(config).handler, "v3");
  });
});

test("callback lead candidate accepted with valid caller ID and explicit permission", () => {
  const memory = phoneMemory();
  const candidate = buildLeadCandidateFromMemory(memory, {
    callerPhoneNormalized: "+491701234567",
    explicitUserPermission: true
  });
  assert.equal(candidate.callback_ready, true);
  assert.equal(candidate.next_action, "team_callback");
  assert.equal(candidate.validation.allowed, true);
});

test("callback lead candidate rejected without valid phone", () => {
  const memory = phoneMemory();
  const candidate = buildLeadCandidateFromMemory(memory, {
    callerPhoneNormalized: "",
    explicitUserPermission: true
  });
  assert.equal(candidate.callback_ready, false);
  assert.notEqual(candidate.next_action, "team_callback");
  assert.equal(candidate.validation.allowed, false);
});

test("callback lead candidate rejected with incomplete spoken phone", () => {
  for (const spoken of INCOMPLETE_SPOKEN_PHONE_EXAMPLES) {
    const check = validatePhoneForCallback({ spokenPhone: spoken });
    assert.equal(check.ok, false, `expected incomplete phone rejected: ${spoken}`);
  }
  const candidate = buildLeadCandidateFromMemory(phoneMemory(), {
    spokenPhone: "0170",
    explicitUserPermission: true
  });
  assert.equal(candidate.callback_ready, false);
});

test("email route does not become team_callback", () => {
  const memory = phoneMemory({
    contact_preference: "email",
    callback_permission: null,
    email_present: true,
    phone_present: false
  });
  const candidate = buildLeadCandidateFromMemory(memory, {
    callerPhoneNormalized: "+491701234567"
  });
  assert.equal(candidate.next_action, "await_customer_email");
  assert.equal(leadCandidateMustNotUseTeamCallback(candidate), true);
});

test("RAG answer cannot set lead_ready", async () => {
  withEnv(dialogueEnv({ VOICE_RAG_API_URL: "http://127.0.0.1:8080" }), async () => {
    const config = loadConfig();
    const memory = phoneMemory();
    const ragResult = await retrieveV4RagAnswer({
      config,
      agentConfig: loadAgentConfig(config),
      transcript: "Was ist Smart Website?",
      memory,
      stateMachine: { state: V4_STATES.ANSWERING_PRODUCT_QUESTION },
      retrieveFn: async () => ({
        ok: true,
        hit: true,
        hitCount: 1,
        topScore: 0.9,
        data: { answer_context: [{ snippet: "Info", score: 0.9 }] },
        latencyMs: 10
      })
    });
    assert.equal(ragResult.creates_lead, false);
    assert.equal(ragAnswerMustNotCreateLead(true).createsLead, false);
    const guard = assertRagCannotSetLeadReady({ lead_ready: true }, "rag_sales_answerer");
    assert.equal(guard.ok, false);
  });
});

test("post-contact product question does not reset lead or contact state", async () => {
  await withEnv(dialogueEnv(), async () => {
    const runtime = createCanaryDialogueRuntime(loadConfig(), { harnessExplicit: true, bridgeCallId: "pc-1" });
    await simulateInboundTranscriptTurn(runtime, "Smart Website bitte");
    await simulateInboundTranscriptTurn(runtime, "Wir sind Neukunde");
    await simulateInboundTranscriptTurn(runtime, "Lieber per E-Mail");
    const before = { ...runtime.orchestrator.memory };
    const turn = await simulateInboundTranscriptTurn(runtime, "Was kostet Smart Website?");
    assert.equal(turn.plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
    assert.equal(turn.memory.contact_preference, before.contact_preference);
    assert.equal(turn.memory.customer_type, before.customer_type);
    assert.equal(turn.memory.lead_ready, false);
  });
});

test("no full phone in v4 post-call metadata or notification payload", () => {
  const config = loadConfig();
  const agent = loadAgentConfig(config);
  const memory = phoneMemory({ lead_ready: false });
  const orchestrator = {
    memory,
    agentConfig: agent,
    callerPhoneNormalized: "+491701234567",
    callerPhoneRaw: "+491701234567"
  };
  const handoff = finalizeV4PostCallHandoff(orchestrator);
  assert.equal(handoff.privacy_ok, true);
  assert.match(handoff.leadCandidate.phone_masked, /\*\*\*\*/);
  assert.doesNotMatch(JSON.stringify(handoff.summaryMetadata), /1701234567/);

  const payload = notificationPayload(
    { callSessionId: "sess-1", bridgeCallId: "b1", externalCallId: "ext-1" },
    {
      summaryId: "sum-1",
      summaryText: "Product interest: smart_website",
      metadata: handoff.summaryMetadata
    },
    { action: "skipped", reason: "guard_not_met", leadId: "" }
  );
  assert.equal(assertNoRawPhoneInPayload(payload), true);
  assert.ok(payload.idempotency_key.includes("sess-1"));
});

test("quality events from closeCall remain phone-safe", async () => {
  await withEnv(dialogueEnv(), async () => {
    const config = loadConfig();
    const ctx = createRuntimeContext(config, { bridgeCallId: "qe-7" });
    const sink = createQualityEventSink({ v4PathActive: true });
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: ctx,
      agentConfig: loadAgentConfig(config),
      qualitySink: sink,
      v4PathActive: true,
      callerPhoneNormalized: "+491701234567"
    });
    orchestrator.memory = phoneMemory();
    closeCall(orchestrator);
    for (const event of sink.getBufferedQualityEvents()) {
      assert.equal(validateQualityEventInput(event).ok, true);
      assert.equal(assertNoRawPhoneInPayload(event.payload), true);
    }
  });
});

test("tryLeadReadyTransition requires validator approval with structured memory", () => {
  withEnv(dialogueEnv(), () => {
    const config = loadConfig();
    const ctx = createRuntimeContext(config, { bridgeCallId: "tr-1" });
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: ctx,
      v4PathActive: true,
      callerPhoneNormalized: "+491701234567"
    });
    orchestrator.memory = phoneMemory();
    orchestrator.stateMachine = { ...orchestrator.stateMachine, state: V4_STATES.VALIDATING_CONTACT };
    const ok = tryLeadReadyTransition(orchestrator, { explicitUserPermission: true });
    assert.equal(ok.ok, true);
    assert.equal(orchestrator.memory.lead_ready, true);
    assert.equal(orchestrator.leadCandidate.callback_ready, true);
  });
});

test("v4 post-call summary metadata includes tenant agent and version fields", () => {
  const config = loadConfig();
  const agent = loadAgentConfig(config);
  const metadata = buildV4PostCallSummaryMetadata({
    memory: phoneMemory({ contact_preference: "email", email_present: true }),
    agentConfig: agent
  });
  assert.equal(metadata.tenant_id, "technolohit");
  assert.equal(metadata.agent_id, "main_voice_sales");
  assert.ok(metadata.agent_config_version);
  assert.equal(metadata.runtime_version, "voice-runtime-v4.0.0-foundation");
  assert.equal(metadata.include_full_transcript, false);
});

test("mergeV4SummaryMetadataPatch preserves privacy on phone-like values", () => {
  const merged = mergeV4SummaryMetadataPatch(
    { next_action: "manual_review" },
    { caller_need: "Ruf mich unter +49 170 1234567 an", tenant_id: "technolohit" }
  );
  assert.match(merged.caller_need, /\[phone_redacted\]/);
  assert.equal(assertNoRawPhoneInPayload(merged), true);
});

test("post-call idempotency key is stable for duplicate prevention", () => {
  const ctx = { callSessionId: "abc" };
  const summary = { summaryId: "sum-1" };
  const lead = { action: "created", leadId: "lead-9" };
  const key1 = buildPostCallIdempotencyKey(ctx, summary, lead);
  const key2 = buildPostCallIdempotencyKey(ctx, summary, lead);
  assert.equal(key1, key2);
  assert.equal(key1, "abc:sum-1:created:lead-9");
});

test("sanitizeOutboundObject masks phone fields", () => {
  const sanitized = sanitizeOutboundObject({
    caller_phone: "+491701234567",
    notes: "Bitte +49 170 1234567 nicht anrufen"
  });
  assert.doesNotMatch(JSON.stringify(sanitized), /1701234567/);
});

test("validateCallbackReadyLead rejects email path for callback-ready", () => {
  const result = validateCallbackReadyLead(
    phoneMemory({ contact_preference: "email", email_present: true }),
    { callerPhoneNormalized: "+491701234567", explicitUserPermission: true }
  );
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "email_path_no_phone_callback");
});

test("closeCall on canary runtime produces post-call handoff", async () => {
  await withEnv(dialogueEnv(), async () => {
    const runtime = createCanaryDialogueRuntime(loadConfig(), {
      harnessExplicit: true,
      bridgeCallId: "close-1"
    });
    runtime.orchestrator.callerPhoneNormalized = "+491701234567";
    runtime.orchestrator.memory = phoneMemory();
    const closed = await closeCanaryDialogueRuntime(runtime);
    assert.equal(closed.ok, true);
    assert.ok(closed.postCallHandoff?.summaryMetadata);
    assert.equal(closed.postCallHandoff.privacy_ok, true);
  });
});

test("notification payload handles failed lead extraction without leaking phone", () => {
  const payload = notificationPayload(
    { callSessionId: "sess-fail", bridgeCallId: "b-fail" },
    {
      summaryId: "sum-fail",
      summaryText: "Next action: manual_review",
      metadata: { next_action: "manual_review", tenant_id: "technolohit" }
    },
    { action: "failed", reason: "lead_extraction_failed", leadId: "" }
  );
  assert.equal(payload.lead.action, "failed");
  assert.equal(payload.lead.reason, "lead_extraction_failed");
  assert.equal(assertNoRawPhoneInPayload(payload), true);
});

test("maskPhoneForExternal never returns full digits", () => {
  const masked = maskPhoneForExternal("+491701234567");
  assert.match(masked, /\*\*\*\*/);
  assert.notEqual(masked, "+491701234567");
});
