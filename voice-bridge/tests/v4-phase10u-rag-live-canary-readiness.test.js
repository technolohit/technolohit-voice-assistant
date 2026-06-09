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
} from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { createQualityEventSink } from "../src/v4/quality-event-sink.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";
import { buildV4RagQuery, retrieveV4RagAnswer } from "../src/v4/rag-orchestrator.js";
import { filterRagChunksByProductScope } from "../src/v4/rag-product-scope.js";
import { checkRagApiHealth } from "../src/rag-client.js";
import { V4_STATES } from "../src/v4/state-machine.js";
import { splitInterruptMarkerAndContinuation } from "../src/v4/interrupt-marker-split.js";

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
    VOICE_RAG_ENABLED: "true",
    VOICE_RAG_SALES_ANSWERER_ENABLED: "true",
    VOICE_RAG_API_URL: "http://127.0.0.1:8080",
    ...overrides,
  };
}

function smartWebsiteMemory() {
  return {
    ...setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10u" }), "smart_website"),
    current_product_context: "smart_website",
    previous_product_context: "voice_agent",
    current_state: V4_STATES.THINKING,
  };
}

function scopedHit(answer = "Smart Website strukturiert Inhalte und Anfragen.") {
  return async (_config, payload) => {
    assert.equal(payload.context.product_scope, "smart_website");
    return {
      ok: true,
      hit: true,
      hitCount: 1,
      topScore: 0.91,
      topSource: "kb://products.technolohit.json#smart_website",
      data: {
        hit: true,
        answer_context: [{
          snippet: answer,
          title: "Smart Website",
          source_uri: "kb://products.technolohit.json#smart_website",
          score: 0.91,
          metadata: { product_id: "smart_website" },
        }],
      },
      latencyMs: 45,
    };
  };
}

async function runOrchestratorTurn(transcript, ragRetriever = scopedHit()) {
  const config = loadConfig();
  const ctx = createRuntimeContext(config, { bridgeCallId: "10u-live" });
  const events = [];
  const orchestrator = createDialogueOrchestrator({
    config,
    runtimeContext: ctx,
    memory: smartWebsiteMemory(),
    stateMachine: { state: V4_STATES.THINKING },
    agentConfig: loadAgentConfig(config),
    adapters: { ragRetriever },
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
  commitAssistantPlanWithoutPlayback(orchestrator, action.plan.text, action.plan);
  return { action, events };
}

test("10U: generic Smart Website pricing query uses Smart Website RAG scope", async () => {
  await withEnv(ragEnv(), async () => {
    const config = loadConfig();
    const payload = buildV4RagQuery({
      config,
      agentConfig: loadAgentConfig(config),
      transcript: "Was kostet das?",
      memory: smartWebsiteMemory(),
      stateMachine: { state: V4_STATES.THINKING },
    });
    assert.equal(payload.context.product_scope, "smart_website");
    assert.equal(payload.context.product, "smart_website");
  });
});

test("10U: first named Smart Website combined inquiry is scoped before RAG retrieval", async () => {
  await withEnv(ragEnv(), async () => {
    const config = loadConfig();
    const ctx = createRuntimeContext(config, { bridgeCallId: "10u-first-named-product" });
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: ctx,
      memory: createCallSessionMemory({ bridgeCallId: "10u-first-named-product" }),
      stateMachine: { state: V4_STATES.THINKING },
      agentConfig: loadAgentConfig(config),
      adapters: {
        ragRetriever: scopedHit("Smart Website Wissen aus dem Produktkontext."),
      },
      qualitySink: createQualityEventSink({ v4PathActive: true }),
      v4PathActive: true,
    });
    const transcript = "Was ist Smart Website, was macht sie und was kostet sie?";
    startTurn(orchestrator);
    acceptUserTranscript(orchestrator, transcript);
    const action = await decideNextAction(orchestrator, { transcript });

    assert.equal(action.ragResult.used_rag, true);
    assert.equal(action.ragResult.rag_product_scope, "smart_website");
    assert.equal(action.plan.rag_used, true);
    assert.equal(action.plan.rag_product_scope, "smart_website");
    assert.equal(action.plan.plan_reason, "combined_product_inquiry");
    assert.match(action.plan.text, /Smart Website/i);
    assert.match(action.plan.text, /Preis h.+ngt vom Umfang/i);
  });
});

test("10U: generic Smart Website capability query uses RAG answer", async () => {
  await withEnv(ragEnv(), async () => {
    const { action } = await runOrchestratorTurn("Wie funktioniert das?");
    assert.equal(action.ragResult.used_rag, true);
    assert.equal(action.ragResult.rag_product_scope, "smart_website");
    assert.equal(action.plan.rag_used, true);
    assert.match(action.plan.text, /Smart Website/i);
  });
});

test("10U: interruption continuation stays scoped to Smart Website", async () => {
  await withEnv(ragEnv(), async () => {
    const split = splitInterruptMarkerAndContinuation("Stopp. Wie funktioniert das?");
    assert.equal(split.continuation, "Wie funktioniert das?");
    const { action } = await runOrchestratorTurn(split.continuation);
    assert.equal(action.plan.rag_product_scope, "smart_website");
    assert.equal(action.plan.rag_used, true);
  });
});

test("10U: RAG timeout returns safe non-RAG answer without crash", async () => {
  await withEnv(ragEnv(), async () => {
    const { action } = await runOrchestratorTurn(
      "Was kostet das?",
      async () => ({ ok: false, reason: "timeout", latencyMs: 700 }),
    );
    assert.equal(action.ragResult.used_rag, false);
    assert.equal(action.ragResult.fallback_reason, "timeout");
    assert.equal(action.plan.rag_fallback_used, true);
    assert.ok(action.plan.text.length > 0);
  });
});

test("10U: empty RAG result returns safe product answer", async () => {
  await withEnv(ragEnv(), async () => {
    const result = await retrieveV4RagAnswer({
      config: loadConfig(),
      agentConfig: loadAgentConfig(loadConfig()),
      transcript: "Wie funktioniert das?",
      memory: smartWebsiteMemory(),
      stateMachine: { state: V4_STATES.THINKING },
      retrieveFn: async () => ({
        ok: true,
        hit: false,
        hitCount: 0,
        data: { answer_context: [] },
        latencyMs: 30,
      }),
    });
    assert.equal(result.used_rag, false);
    assert.equal(result.fallback_reason, "rag_miss");
    assert.ok(result.answer.length > 0);
  });
});

test("10U: thrown RAG provider error returns safe product answer", async () => {
  await withEnv(ragEnv(), async () => {
    const { action } = await runOrchestratorTurn("Was kann das?", async () => {
      throw new Error("provider unavailable");
    });
    assert.equal(action.ragResult.used_rag, false);
    assert.equal(action.ragResult.fallback_reason, "rag_request_failed");
    assert.equal(action.plan.rag_fallback_used, true);
    assert.equal(action.plan.rag_product_scope, "smart_website");
    assert.ok(action.plan.text.length > 0);
  });
});

test("10U: wrong-product RAG result is ignored", async () => {
  await withEnv(ragEnv(), async () => {
    const result = await retrieveV4RagAnswer({
      config: loadConfig(),
      agentConfig: loadAgentConfig(loadConfig()),
      transcript: "Was kostet das?",
      memory: smartWebsiteMemory(),
      stateMachine: { state: V4_STATES.THINKING },
      retrieveFn: async () => ({
        ok: true,
        hit: true,
        hitCount: 1,
        topScore: 0.95,
        data: {
          answer_context: [{
            snippet: "Digitale Rezeption beantwortet Anrufe.",
            title: "Digitale Rezeption",
            source_uri: "kb://products.technolohit.json#voice_agent",
            metadata: { product_id: "voice_agent" },
          }],
        },
        latencyMs: 20,
      }),
    });
    assert.equal(result.used_rag, false);
    assert.equal(result.fallback_reason, "rag_wrong_product_scope");
  });
});

test("10U: response plan and RAG events include safe evidence without transcript", async () => {
  await withEnv(ragEnv(), async () => {
    const { events } = await runOrchestratorTurn("Was kostet das?");
    const types = events.map((event) => event.eventType);
    assert.ok(types.includes("rag_retrieval_started"));
    assert.ok(types.includes("rag_retrieval_completed"));
    const plan = events.find((event) => event.eventType === "response_plan_created");
    assert.equal(plan.payload.rag_used, true);
    assert.equal(plan.payload.rag_product_scope, "smart_website");
    assert.equal(plan.payload.rag_fallback_used, false);
    assert.equal("transcript" in plan.payload, false);
    for (const event of events.filter((item) => item.eventStage === "rag")) {
      assert.equal("query" in event.payload, false);
      assert.equal("transcript" in event.payload, false);
      assert.equal("phone" in event.payload, false);
    }
  });
});

test("10U: chunk filter enforces product scope", () => {
  const chunks = [
    { title: "Smart Website", metadata: { product_id: "smart_website" } },
    { title: "Digitale Rezeption", metadata: { product_id: "voice_agent" } },
  ];
  assert.equal(filterRagChunksByProductScope(chunks, "smart_website").length, 1);
});

test("10U: RAG health check fails closed without URL", async () => {
  const result = await checkRagApiHealth({ rag: { apiUrl: "" } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "rag_api_url_missing");
});

test("10U: RAG health check uses healthz without exposing URL in result", async () => {
  let requestedUrl = "";
  const result = await checkRagApiHealth(
    { rag: { apiUrl: "http://127.0.0.1:8080" } },
    {
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return { ok: true, status: 200 };
      },
    },
  );
  assert.equal(requestedUrl, "http://127.0.0.1:8080/healthz");
  assert.equal(result.ok, true);
  assert.equal("url" in result, false);
});

test("10U: v3 defaults keep RAG disabled", () => {
  withEnv({
    VOICE_RUNTIME_VERSION: undefined,
    VOICE_RAG_ENABLED: undefined,
    VOICE_RAG_SALES_ANSWERER_ENABLED: undefined,
  }, () => {
    const config = loadConfig();
    assert.equal(config.rag.enabled, false);
    assert.equal(config.rag.salesAnswererEnabled, false);
  });
});
