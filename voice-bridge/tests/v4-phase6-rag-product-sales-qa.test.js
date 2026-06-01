import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import {
  resolveRuntimeRoute,
  routeIncomingCallToRuntime
} from "../src/v4/runtime-router.js";
import {
  createCanaryDialogueRuntime,
  simulateInboundTranscriptTurn
} from "../src/v4/canary-runtime-loop.js";
import {
  createDialogueOrchestrator,
  decideNextAction,
  startTurn,
  acceptUserTranscript
} from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { createQualityEventSink } from "../src/v4/quality-event-sink.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { V4_STATES } from "../src/v4/state-machine.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";
import { ragAnswerMustNotCreateLead } from "../src/v4/lead-validator.js";
import {
  shouldUseRagForTurn,
  buildV4RagQuery,
  retrieveV4RagAnswer,
  validateRagAnswerSafety,
  fallbackToPlaybook,
  summarizeRagEvidence,
  V4_RAG_HOST_LOCAL_BASE_URL,
  V4_RAG_FORBIDDEN_STATES
} from "../src/v4/rag-orchestrator.js";
import { resolveDocumentedRagBaseUrl } from "../src/v4/rag-scope.js";

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
    VOICE_RAG_API_URL: "http://127.0.0.1:8080",
    ...overrides
  };
}

function ragHit(answer, score = 0.9) {
  return async () => ({
    ok: true,
    hit: true,
    hitCount: 1,
    topScore: score,
    topSource: "kb://smart-website",
    data: {
      hit: true,
      answer_context: [{ snippet: answer, score, title: "Smart Website FAQ" }]
    },
    latencyMs: 55
  });
}

test("default production route remains v3 with RAG flags unchanged", () => {
  withEnv({ VOICE_RUNTIME_VERSION: undefined, VOICE_RAG_API_URL: undefined }, () => {
    const config = loadConfig();
    assert.equal(resolveRuntimeRoute(config).runtime, "v3");
    assert.equal(routeIncomingCallToRuntime(config).handler, "v3");
  });
});

test("documented RAG base URL is host-local 127.0.0.1:8080", () => {
  withEnv({ VOICE_RAG_API_URL: undefined }, () => {
    const config = loadConfig();
    assert.equal(V4_RAG_HOST_LOCAL_BASE_URL, "http://127.0.0.1:8080");
    assert.equal(resolveDocumentedRagBaseUrl(config), "http://127.0.0.1:8080");
  });
});

test("RAG allowed in product Q&A states", () => {
  const allowed = shouldUseRagForTurn({
    state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
    transcript: "Was ist Smart Website?"
  });
  assert.equal(allowed.allowed, true);

  const sales = shouldUseRagForTurn({
    state: V4_STATES.COLLECTING_SALES_CONTEXT,
    transcript: "Was kostet das?"
  });
  assert.equal(sales.allowed, true);
});

test("RAG blocked in contact permission and lead states", () => {
  for (const state of [
    V4_STATES.COLLECTING_CONTACT_PREFERENCE,
    V4_STATES.COLLECTING_CALLBACK_PERMISSION,
    V4_STATES.CLOSING,
    V4_STATES.LEAD_READY
  ]) {
    const gate = shouldUseRagForTurn({
      state,
      transcript: "Was ist Smart Website?"
    });
    assert.equal(gate.allowed, false, `expected RAG blocked in ${state}`);
  }

  assert.ok(V4_RAG_FORBIDDEN_STATES.has(V4_STATES.COLLECTING_CALLBACK_PERMISSION));
});

test("buildV4RagQuery always includes tenant_id and agent_id", () => {
  withEnv(dialogueEnv(), () => {
    const config = loadConfig();
    const agent = loadAgentConfig(config);
    const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "rag-scope" }), "smart_website");
    const payload = buildV4RagQuery({
      config,
      agentConfig: agent,
      transcript: "Was ist Smart Website?",
      memory,
      stateMachine: { state: V4_STATES.THINKING }
    });
    assert.equal(payload.tenant_id, "technolohit");
    assert.equal(payload.agent_id, "main_voice_sales");
    assert.equal(payload.context.tenant_id, "technolohit");
    assert.equal(payload.context.agent_id, "main_voice_sales");
    assert.equal(payload.context.product, "smart_website");
  });
});

test("buildV4RagQuery redacts phone numbers from query and context", () => {
  withEnv(dialogueEnv(), () => {
    const config = loadConfig();
    const agent = loadAgentConfig(config);
    const payload = buildV4RagQuery({
      config,
      agentConfig: agent,
      transcript: "Meine Nummer ist +49 170 1234567, was kostet Smart Website?",
      memory: { selected_product_id: "smart_website", current_state: V4_STATES.THINKING },
      stateMachine: { state: V4_STATES.THINKING }
    });
    assert.match(payload.query, /\[phone_redacted\]/);
    assert.doesNotMatch(JSON.stringify(payload), /1701234567/);
  });
});

test("retrieveV4RagAnswer fails closed on timeout and unavailable", async () => {
  await withEnv(dialogueEnv(), async () => {
    const config = loadConfig();
    const agent = loadAgentConfig(config);
    const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "fail-1" }), "smart_website");

    const timeout = await retrieveV4RagAnswer({
      config,
      agentConfig: agent,
      transcript: "Was ist Smart Website?",
      memory,
      stateMachine: { state: V4_STATES.ANSWERING_PRODUCT_QUESTION },
      retrieveFn: async () => ({ ok: false, reason: "timeout", latencyMs: 700 })
    });
    assert.equal(timeout.used_rag, false);
    assert.equal(timeout.fallback_reason, "timeout");
    assert.ok(timeout.answer.length > 0);

    const lowScore = await retrieveV4RagAnswer({
      config,
      agentConfig: agent,
      transcript: "Was ist Smart Website?",
      memory,
      stateMachine: { state: V4_STATES.ANSWERING_PRODUCT_QUESTION },
      retrieveFn: ragHit("Antwort", 0.2)
    });
    assert.equal(lowScore.used_rag, false);
    assert.equal(lowScore.fallback_reason, "rag_low_score");

    const noUrl = await retrieveV4RagAnswer({
      config: { ...config, rag: { ...config.rag, apiUrl: "" } },
      agentConfig: agent,
      transcript: "Was ist Smart Website?",
      memory,
      stateMachine: { state: V4_STATES.ANSWERING_PRODUCT_QUESTION }
    });
    assert.equal(noUrl.used_rag, false);
    assert.equal(noUrl.fallback_reason, "rag_api_url_missing");
  });
});

test("retrieveV4RagAnswer uses RAG hit when score passes threshold", async () => {
  await withEnv(dialogueEnv(), async () => {
    const config = loadConfig();
    const agent = loadAgentConfig(config);
    const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "hit-1" }), "smart_website");
    const result = await retrieveV4RagAnswer({
      config,
      agentConfig: agent,
      transcript: "Was ist Smart Website?",
      memory,
      stateMachine: { state: V4_STATES.ANSWERING_PRODUCT_QUESTION },
      retrieveFn: ragHit("Smart Website bündelt Website und lokale Sichtbarkeit.")
    });
    assert.equal(result.used_rag, true);
    assert.match(result.answer, /Smart Website/i);
    assert.equal(result.creates_lead, false);
    assert.equal(result.payload_tenant_id, "technolohit");
    assert.equal(result.payload_agent_id, "main_voice_sales");
  });
});

test("forbidden claims trigger playbook fallback", async () => {
  await withEnv(dialogueEnv(), async () => {
    const config = loadConfig();
    const agent = loadAgentConfig(config);
    const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "unsafe-1" }), "smart_website");
    const unsafe = await retrieveV4RagAnswer({
      config,
      agentConfig: agent,
      transcript: "Was ist Smart Website?",
      memory,
      stateMachine: { state: V4_STATES.ANSWERING_PRODUCT_QUESTION },
      retrieveFn: ragHit("Wir bieten guaranteed rankings für jede Branche.")
    });
    assert.equal(unsafe.used_rag, false);
    assert.equal(unsafe.fallback_reason, "rag_unsafe_or_empty");
    assert.doesNotMatch(unsafe.answer, /guaranteed rankings/i);
  });
});

test("validateRagAnswerSafety rejects phone and guarantee language", () => {
  const agent = loadAgentConfig(loadConfig());
  assert.equal(validateRagAnswerSafety("Rufen Sie +491701234567 an.", agent).ok, false);
  assert.equal(validateRagAnswerSafety("100% Erfolgsgarantie inklusive.", agent).ok, false);
  assert.equal(validateRagAnswerSafety("Smart Website unterstützt lokale Sichtbarkeit.", agent).ok, true);
});

test("fallbackToPlaybook stays bounded and sales-safe", () => {
  const agent = loadAgentConfig(loadConfig());
  const fb = fallbackToPlaybook({ productId: "smart_website", agentConfig: agent });
  assert.equal(fb.used_rag, false);
  assert.equal(fb.creates_lead, false);
  assert.ok(fb.answer.length <= 220);
  assert.equal(fb.safety_ok, true);
});

test("summarizeRagEvidence redacts sources", () => {
  const summary = summarizeRagEvidence({
    hit: true,
    topScore: 0.88,
    topSource: "doc +491701234567",
    data: { answer_context: [{ title: "FAQ", score: 0.88 }] },
    latencyMs: 40
  });
  assert.equal(summary.hit, true);
  assert.match(summary.top_source, /\[phone_redacted\]/);
});

test("RAG path never creates leads", async () => {
  await withEnv(dialogueEnv(), async () => {
    const config = loadConfig();
    const ctx = createRuntimeContext(config, { bridgeCallId: "no-lead" });
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: ctx,
      agentConfig: loadAgentConfig(config),
      v4PathActive: true,
      qualitySink: createQualityEventSink({ v4PathActive: true }),
      adapters: {
        ragRetriever: ragHit("Produktinfo ohne Lead-Erstellung.")
      }
    });
    orchestrator.memory = setSelectedProduct(orchestrator.memory, "smart_website");
    startTurn(orchestrator);
    acceptUserTranscript(orchestrator, "Was ist Smart Website?");
    const action = await decideNextAction(orchestrator, { transcript: "Was ist Smart Website?" });
    assert.equal(action.plan.rag_allowed, true);
    assert.equal(action.plan.lead_transition_allowed, false);
    assert.equal(action.ragResult.creates_lead, false);
    assert.equal(ragAnswerMustNotCreateLead(true).createsLead, false);
    assert.equal(orchestrator.memory.lead_ready, false);
  });
});

test("product question after contact capture does not restart intake", async () => {
  await withEnv(dialogueEnv(), async () => {
    const runtime = createCanaryDialogueRuntime(loadConfig(), { harnessExplicit: true, bridgeCallId: "post-1" });
    await simulateInboundTranscriptTurn(runtime, "Smart Website bitte");
    await simulateInboundTranscriptTurn(runtime, "Wir sind Neukunde");
    await simulateInboundTranscriptTurn(runtime, "Lieber per E-Mail");
    assert.equal(runtime.orchestrator.memory.contact_preference, "email");

    const pricingTurn = await simulateInboundTranscriptTurn(runtime, "Was kostet Smart Website?");
    assert.equal(pricingTurn.plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
    assert.equal(pricingTurn.memory.contact_preference, "email");
    assert.equal(pricingTurn.memory.customer_type, "new_prospect");
    assert.notEqual(pricingTurn.plan.next_state, V4_STATES.COLLECTING_CONTACT_PREFERENCE);
    assert.equal(pricingTurn.plan.lead_transition_allowed, false);
  });
});

test("orchestrator buffers rag quality events on canary path", async () => {
  await withEnv(dialogueEnv(), async () => {
    const runtime = createCanaryDialogueRuntime(loadConfig(), {
      harnessExplicit: true,
      bridgeCallId: "qe-1",
      ragRetriever: ragHit("Kurze Produktantwort.")
    });
    await simulateInboundTranscriptTurn(runtime, "Was ist Smart Website?");
    const types = runtime.qualitySink.getBufferedQualityEvents().map((e) => e.eventType);
    assert.ok(types.includes("rag_retrieval_started"));
    assert.ok(types.includes("rag_retrieval_completed"));
  });
});

test("buildResponsePlan respects ragGate in forbidden validating state without product Q", () => {
  const agent = loadAgentConfig(loadConfig());
  const memory = {
    ...setSelectedProduct(createCallSessionMemory({ bridgeCallId: "gate-1" }), "smart_website"),
    contact_preference: "phone",
    callback_permission: "granted"
  };
  const gate = shouldUseRagForTurn({
    state: V4_STATES.VALIDATING_CONTACT,
    transcript: "Ja genau",
    memory
  });
  assert.equal(gate.allowed, false);
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory,
    stateMachine: { state: V4_STATES.VALIDATING_CONTACT },
    transcript: "Ja genau",
    ragGate: gate
  });
  assert.equal(plan.rag_allowed, false);
});
