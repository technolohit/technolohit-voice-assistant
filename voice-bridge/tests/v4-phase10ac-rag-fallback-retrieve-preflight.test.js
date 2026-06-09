import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import {
  createDialogueOrchestrator,
  startTurn,
  acceptUserTranscript,
  decideNextAction,
} from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { createQualityEventSink } from "../src/v4/quality-event-sink.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";
import { retrieveV4RagAnswer, fallbackToPlaybook, buildV4RagQuery } from "../src/v4/rag-orchestrator.js";
import { SMART_WEBSITE_COMBINED_LIVE_ANSWER } from "../src/v4/playbook-short-answer.js";
import {
  prepareLiveAssistantSpeechText,
  maxLiveResponseChars,
} from "../src/v4/live-tts-playback-endpoint.js";
import {
  formatRagRetrievePreflightLines,
  runRagRetrievePreflight,
} from "../src/v4/rag-retrieve-preflight.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { V4_STATES } from "../src/v4/state-machine.js";

const COMBINED_TRANSCRIPT = "Was ist Smart Website, was macht sie und was kostet sie?";

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

function ragEnv(overrides = {}) {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "true",
    VOICE_V4_LIVE_CANARY_ALLOWLIST: "bridge:",
    VOICE_RAG_ENABLED: "true",
    VOICE_RAG_SALES_ANSWERER_ENABLED: "true",
    VOICE_RAG_API_URL: "http://127.0.0.1:8080",
    ...overrides,
  };
}

function smartWebsiteMemory() {
  return {
    ...setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10ac" }), "smart_website"),
    current_product_context: "smart_website",
    current_state: V4_STATES.THINKING,
  };
}

const missRetrieveFn = async () => ({
  ok: true,
  hit: false,
  hitCount: 0,
  data: { answer_context: [] },
  latencyMs: 30,
  status: 200,
});

const timeoutRetrieveFn = async () => ({
  ok: false,
  reason: "timeout",
  latencyMs: 700,
});

const hitRetrieveFn = async () => ({
  ok: true,
  hit: true,
  hitCount: 1,
  topScore: 0.91,
  status: 200,
  data: {
    answer_context: [{
      snippet: "Smart Website strukturiert Inhalte und bereitet Anfragen vor.",
      title: "Smart Website",
      source_uri: "kb://products.technolohit.json#smart_website",
      score: 0.91,
      metadata: { product_id: "smart_website" },
    }],
  },
  latencyMs: 45,
});

async function runCombinedInquiryTurn(transcript, retrieveFn) {
  const config = loadConfig();
  const events = [];
  const orchestrator = createDialogueOrchestrator({
    config,
    runtimeContext: createRuntimeContext(config, { bridgeCallId: "10ac-combined" }),
    memory: smartWebsiteMemory(),
    stateMachine: { state: V4_STATES.THINKING },
    agentConfig: loadAgentConfig(config),
    adapters: { ragRetriever: retrieveFn },
    qualitySink: createQualityEventSink({ v4PathActive: true }),
    v4PathActive: true,
  });
  const originalBuffer = orchestrator.qualitySink.bufferQualityEvent.bind(orchestrator.qualitySink);
  orchestrator.qualitySink.bufferQualityEvent = (event) => {
    events.push(event);
    return originalBuffer(event);
  };
  startTurn(orchestrator);
  acceptUserTranscript(orchestrator, transcript);
  const action = await decideNextAction(orchestrator, { transcript });
  return { action, events, config };
}

function assertCombinedFallbackPlan(action, config) {
  const { plan } = action;
  assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
  assert.match(plan.plan_reason, /combined_product_inquiry|playbook_combined/);
  assert.equal(plan.rag_used, false);
  assert.equal(plan.rag_fallback_used, true);
  assert.notEqual(plan.response_type, RESPONSE_TYPES.COLLECT_SALES_CONTEXT);

  const prepared = prepareLiveAssistantSpeechText(config, plan.text);
  assert.equal(prepared.ok, true);
  assert.match(prepared.text, /Smart Website/i);
  assert.match(prepared.text, /Anfragen/i);
  assert.match(prepared.text, /Preis hängt vom Umfang/i);
  assert.doesNotMatch(prepared.text, /Neukunde|bestehender Kunde/i);
  assert.ok(prepared.text.length <= maxLiveResponseChars(config));
}

test("10AC: fallbackToPlaybook returns combined answer for multi-facet Smart Website inquiry", () => {
  const agent = loadAgentConfig(loadConfig());
  const fb = fallbackToPlaybook({
    productId: "smart_website",
    transcript: COMBINED_TRANSCRIPT,
    agentConfig: agent,
  });
  assert.equal(fb.used_rag, false);
  assert.equal(fb.fallback_reason, "playbook_combined_inquiry");
  assert.equal(fb.answer, SMART_WEBSITE_COMBINED_LIVE_ANSWER);
});

test("10AC: fallbackToPlaybook returns pricing with Umfang for scoped pricing question", () => {
  const agent = loadAgentConfig(loadConfig());
  const fb = fallbackToPlaybook({
    productId: "smart_website",
    transcript: "Was kostet das?",
    agentConfig: agent,
  });
  assert.equal(fb.fallback_reason, "playbook_pricing");
  assert.match(fb.answer, /Umfang/i);
});

test("10AC A: RAG miss on combined Smart Website inquiry uses playbook combined fallback", async () => {
  await withEnv(ragEnv(), async () => {
    const { action, config } = await runCombinedInquiryTurn(COMBINED_TRANSCRIPT, missRetrieveFn);
    assert.equal(action.ragResult.used_rag, false);
    assert.equal(action.ragResult.fallback_reason, "rag_miss");
    assertCombinedFallbackPlan(action, config);
    assert.equal(action.plan.text, SMART_WEBSITE_COMBINED_LIVE_ANSWER);
  });
});

test("10AC B: RAG timeout on combined Smart Website inquiry uses playbook combined fallback", async () => {
  await withEnv(ragEnv(), async () => {
    const { action, config } = await runCombinedInquiryTurn(COMBINED_TRANSCRIPT, timeoutRetrieveFn);
    assert.equal(action.ragResult.used_rag, false);
    assert.equal(action.ragResult.fallback_reason, "timeout");
    assertCombinedFallbackPlan(action, config);
  });
});

test("10AC C: RAG hit on combined Smart Website inquiry uses scoped RAG answer", async () => {
  await withEnv(ragEnv(), async () => {
    const { action } = await runCombinedInquiryTurn(COMBINED_TRANSCRIPT, hitRetrieveFn);
    assert.equal(action.ragResult.used_rag, true);
    assert.equal(action.plan.rag_used, true);
    assert.equal(action.plan.rag_product_scope, "smart_website");
    assert.match(action.plan.text, /Smart Website/i);
    assert.notEqual(action.plan.text, SMART_WEBSITE_COMBINED_LIVE_ANSWER);
  });
});

test("10AC D: repeated pricing question after RAG miss returns pricing fallback not generic explanation", async () => {
  await withEnv(ragEnv(), async () => {
    const { action } = await runCombinedInquiryTurn("Was kostet das?", missRetrieveFn);
    assert.equal(action.ragResult.used_rag, false);
    assert.equal(action.plan.rag_fallback_used, true);
    assert.match(action.plan.text, /Umfang|kalkuliert/i);
    assert.doesNotMatch(
      action.plan.text,
      /^Eine Smart Website zeigt Ihr Angebot klar/
    );
  });
});

test("10AC D2: interruption follow-up after RAG miss returns pricing fallback not generic explanation", () => {
  const config = loadConfig();
  const agentConfig = loadAgentConfig(config);
  const plan = buildResponsePlan({
    agentConfig,
    memory: smartWebsiteMemory(),
    stateMachine: { state: V4_STATES.THINKING },
    transcript: "Was kostet das?",
    intent: "product_question",
    interruptionRecovery: {
      recoveryAction: "product_question",
      context: { interrupted_product_id: "smart_website" },
    },
    ragAnswer: "Eine Smart Website zeigt Ihr Angebot klar, beantwortet wichtige Fragen und bereitet bessere Anfragen vor.",
    ragGate: { allowed: true, used_rag: false },
    ragResult: { used_rag: false, fallback_reason: "rag_miss" },
  });
  assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
  assert.equal(plan.rag_allowed, false);
  assert.match(plan.text, /Umfang|kalkuliert/i);
  assert.doesNotMatch(
    plan.text,
    /^Eine Smart Website zeigt Ihr Angebot klar/
  );
});

test("10AC: rag_retrieval_failed events include safe diagnostics without transcript", async () => {
  await withEnv(ragEnv(), async () => {
    const { events } = await runCombinedInquiryTurn(COMBINED_TRANSCRIPT, missRetrieveFn);
    const failed = events.find((event) => event.eventType === "rag_retrieval_failed");
    assert.ok(failed);
    assert.equal(failed.payload.fallback_reason, "rag_miss");
    assert.equal(failed.payload.rag_product_scope, "smart_website");
    assert.equal(failed.payload.rag_result_count, 0);
    assert.equal(failed.payload.rag_fallback_used, true);
    assert.equal(failed.payload.payload_tenant_id, "technolohit");
    assert.equal(failed.payload.payload_agent_id, "main_voice_sales");
    assert.equal("transcript" in failed.payload, false);
    assert.equal("query" in failed.payload, false);
  });
});

test("10AC E: retrieve preflight passes when Smart Website hit is returned", async () => {
  await withEnv(ragEnv(), async () => {
    const result = await runRagRetrievePreflight(loadConfig(), {
      skipCanary: true,
      retrieveFn: hitRetrieveFn,
    });
    assert.equal(result.ok, true);
    assert.equal(result.hit, true);
    assert.ok(result.result_count > 0);
    const output = formatRagRetrievePreflightLines(result);
    assert.match(output, /rag_retrieve_preflight=pass/);
    assert.match(output, /product_scope=smart_website/);
    assert.match(output, /hit=true/);
    assert.doesNotMatch(output, /Was ist Smart Website/);
  });
});

test("10AC E: retrieve preflight fails when hit_count is zero", async () => {
  await withEnv(ragEnv(), async () => {
    const result = await runRagRetrievePreflight(loadConfig(), {
      skipCanary: true,
      retrieveFn: missRetrieveFn,
    });
    assert.equal(result.ok, false);
    assert.equal(result.fallback_reason, "rag_miss");
    assert.equal(result.result_count, 0);
    const output = formatRagRetrievePreflightLines(result);
    assert.match(output, /rag_retrieve_preflight=fail/);
    assert.match(output, /reason=rag_miss|fallback_reason=rag_miss/);
    assert.match(output, /result_count=0/);
  });
});

test("10AC E: retrieve preflight fails when product_scope is wrong in payload", async () => {
  await withEnv(ragEnv(), async () => {
    const config = loadConfig();
    const result = await runRagRetrievePreflight(config, {
      skipCanary: true,
      retrieveFn: hitRetrieveFn,
      buildV4RagQueryFn: (args) => {
        const payload = buildV4RagQuery(args);
        payload.context.product_scope = "voice_agent";
        return payload;
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.failures.join(","), /payload_product_scope/);
  });
});

test("10AC F: retrieve preflight output contains safe markers only", async () => {
  await withEnv(ragEnv(), async () => {
    const output = formatRagRetrievePreflightLines(
      await runRagRetrievePreflight(loadConfig(), {
        skipCanary: true,
        retrieveFn: missRetrieveFn,
      }),
    );
    assert.doesNotMatch(output, /@[\w.-]+\.\w+/);
    assert.doesNotMatch(output, /\+?\d{6,}/);
    assert.doesNotMatch(output, /Was ist Smart Website/);
  });
});
