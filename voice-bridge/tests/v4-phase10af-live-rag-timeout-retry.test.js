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
import { retrieveV4RagAnswer } from "../src/v4/rag-orchestrator.js";
import { V4_STATES } from "../src/v4/state-machine.js";

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

function ragEnv() {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_RAG_ENABLED: "true",
    VOICE_RAG_SALES_ANSWERER_ENABLED: "true",
    VOICE_RAG_API_URL: "http://127.0.0.1:8080",
    VOICE_RAG_TIMEOUT_MS: "700",
  };
}

function smartWebsiteMemory() {
  return {
    ...setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10af" }), "smart_website"),
    current_product_context: "smart_website",
    current_state: V4_STATES.THINKING,
  };
}

function smartWebsiteHit(latencyMs = 206) {
  return {
    ok: true,
    hit: true,
    hitCount: 1,
    topScore: 0.88,
    status: 200,
    data: {
      answer_context: [{
        snippet: "Smart Website strukturiert Inhalte und verbessert qualifizierte Anfragen.",
        title: "Smart Website",
        source_uri: "kb://products.technolohit.json#smart_website",
        score: 0.88,
        metadata: { product_id: "smart_website" },
      }],
    },
    latencyMs,
  };
}

test("10AF: live RAG retries one timeout and uses second successful hit", async () => {
  await withEnv(ragEnv(), async () => {
    let calls = 0;
    const result = await retrieveV4RagAnswer({
      config: loadConfig(),
      agentConfig: loadAgentConfig(loadConfig()),
      transcript: "Was ist Smart Website, was macht sie und was kostet sie?",
      memory: smartWebsiteMemory(),
      stateMachine: { state: V4_STATES.THINKING },
      retrieveFn: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, reason: "timeout", latencyMs: 702 };
        return smartWebsiteHit(206);
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.used_rag, true);
    assert.equal(result.rag_product_scope, "smart_website");
    assert.equal(result.rag_attempt_count, 2);
    assert.equal(result.rag_success_count, 1);
    assert.equal(result.rag_timeout_count, 1);
    assert.deepEqual(result.rag_attempt_fallback_reasons, ["timeout"]);
    assert.equal(result.latency_ms, 908);
    assert.equal(result.result_count, 1);
  });
});

test("10AF: live RAG does not retry non-timeout misses", async () => {
  await withEnv(ragEnv(), async () => {
    let calls = 0;
    const result = await retrieveV4RagAnswer({
      config: loadConfig(),
      agentConfig: loadAgentConfig(loadConfig()),
      transcript: "Was kostet das?",
      memory: smartWebsiteMemory(),
      stateMachine: { state: V4_STATES.THINKING },
      retrieveFn: async () => {
        calls += 1;
        return {
          ok: true,
          hit: false,
          hitCount: 0,
          status: 200,
          data: { answer_context: [] },
          latencyMs: 44,
        };
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.used_rag, false);
    assert.equal(result.fallback_reason, "rag_miss");
    assert.equal(result.rag_attempt_count, 1);
    assert.equal(result.rag_timeout_count, 0);
  });
});

test("10AF: RAG quality event includes retry diagnostics without raw transcript", async () => {
  await withEnv(ragEnv(), async () => {
    let calls = 0;
    const events = [];
    const config = loadConfig();
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: createRuntimeContext(config, { bridgeCallId: "10af-quality" }),
      memory: smartWebsiteMemory(),
      stateMachine: { state: V4_STATES.THINKING },
      agentConfig: loadAgentConfig(config),
      adapters: {
        ragRetriever: async () => {
          calls += 1;
          if (calls === 1) return { ok: false, reason: "timeout", latencyMs: 701 };
          return smartWebsiteHit(205);
        },
      },
      qualitySink: createQualityEventSink({ v4PathActive: true }),
      v4PathActive: true,
    });
    const originalBuffer = orchestrator.qualitySink.bufferQualityEvent.bind(orchestrator.qualitySink);
    orchestrator.qualitySink.bufferQualityEvent = (event) => {
      events.push(event);
      return originalBuffer(event);
    };

    const transcript = "Was ist Smart Website, was macht sie und was kostet sie?";
    startTurn(orchestrator);
    acceptUserTranscript(orchestrator, transcript);
    const action = await decideNextAction(orchestrator, { transcript });

    assert.equal(action.ragResult.used_rag, true);
    const completed = events.find((event) => event.eventType === "rag_retrieval_completed");
    assert.ok(completed);
    assert.equal(completed.payload.rag_attempt_count, 2);
    assert.equal(completed.payload.rag_success_count, 1);
    assert.equal(completed.payload.rag_timeout_count, 1);
    assert.deepEqual(completed.payload.rag_attempt_fallback_reasons, ["timeout"]);
    assert.equal(completed.payload.rag_total_latency_ms, 906);
    assert.equal(completed.payload.rag_latency_ms, 906);
    assert.equal("transcript" in completed.payload, false);
    assert.equal("query" in completed.payload, false);
  });
});
