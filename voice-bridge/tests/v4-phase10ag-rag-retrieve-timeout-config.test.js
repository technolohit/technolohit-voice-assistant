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
import { runtimeRetrieveMaxAttempts, runtimeRetrieveTimeoutMs } from "../src/v4/rag-retrieve-config.js";
import { runRagRetrievePreflight } from "../src/v4/rag-retrieve-preflight.js";
import { V4_STATES } from "../src/v4/state-machine.js";

const TRANSCRIPT = "Was ist Smart Website, was macht sie und was kostet sie?";

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
    VOICE_RAG_TIMEOUT_MS: "700",
    VOICE_RAG_RETRIEVE_TIMEOUT_MS: "1500",
    VOICE_RAG_RETRIEVE_MAX_ATTEMPTS: "3",
    ...overrides,
  };
}

function smartWebsiteMemory() {
  return {
    ...setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10ag" }), "smart_website"),
    current_product_context: "smart_website",
    current_state: V4_STATES.THINKING,
  };
}

function smartWebsiteHit(latencyMs = 280) {
  return {
    ok: true,
    hit: true,
    hitCount: 1,
    topScore: 0.88,
    status: 200,
    data: {
      answer_context: [{
        snippet: "Smart Website macht Leistungen sichtbar und bereitet qualifizierte Anfragen vor.",
        title: "Smart Website",
        source_uri: "kb://products.technolohit.json#smart_website",
        score: 0.88,
        metadata: { product_id: "smart_website" },
      }],
    },
    latencyMs,
  };
}

test("10AG: retrieve timeout and max attempts are configured independently from legacy RAG timeout", () => {
  withEnv(ragEnv({ VOICE_RAG_RETRIEVE_TIMEOUT_MS: "2000", VOICE_RAG_RETRIEVE_MAX_ATTEMPTS: "2" }), () => {
    const config = loadConfig();
    assert.equal(config.rag.timeoutMs, 700);
    assert.equal(config.rag.retrieveTimeoutMs, 2000);
    assert.equal(config.rag.retrieveMaxAttempts, 2);
    assert.equal(runtimeRetrieveTimeoutMs(config), 2000);
    assert.equal(runtimeRetrieveMaxAttempts(config), 2);
  });
});

test("10AG: preflight uses configured retrieve timeout and passes after timeout then hit", async () => {
  await withEnv(ragEnv({ VOICE_RAG_RETRIEVE_TIMEOUT_MS: "1500", VOICE_RAG_RETRIEVE_MAX_ATTEMPTS: "3" }), async () => {
    let calls = 0;
    const seenTimeouts = [];
    const result = await runRagRetrievePreflight(loadConfig(), {
      skipCanary: true,
      retrieveFn: async (_config, payload) => {
        calls += 1;
        seenTimeouts.push(payload.timeoutMs);
        if (calls === 1) return { ok: false, reason: "timeout", latencyMs: 1501 };
        return smartWebsiteHit(250);
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.timeout_ms, 1500);
    assert.equal(result.attempt_count, 2);
    assert.equal(result.success_count, 1);
    assert.equal(result.required_success_count, 1);
    assert.equal(result.timeout_count, 1);
    assert.equal(result.hit, true);
    assert.deepEqual(seenTimeouts, [1500, 1500]);
  });
});

test("10AG: live RAG path uses configured timeout and records completed event after retry success", async () => {
  await withEnv(ragEnv({ VOICE_RAG_RETRIEVE_TIMEOUT_MS: "1500", VOICE_RAG_RETRIEVE_MAX_ATTEMPTS: "3" }), async () => {
    let calls = 0;
    const events = [];
    const seenTimeouts = [];
    const config = loadConfig();
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: createRuntimeContext(config, { bridgeCallId: "10ag-live" }),
      memory: smartWebsiteMemory(),
      stateMachine: { state: V4_STATES.THINKING },
      agentConfig: loadAgentConfig(config),
      adapters: {
        ragRetriever: async (_config, payload) => {
          calls += 1;
          seenTimeouts.push(payload.timeoutMs);
          if (calls === 1) return { ok: false, reason: "timeout", latencyMs: 1501 };
          return smartWebsiteHit(249);
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

    startTurn(orchestrator);
    acceptUserTranscript(orchestrator, TRANSCRIPT);
    const action = await decideNextAction(orchestrator, { transcript: TRANSCRIPT });

    assert.equal(calls, 2);
    assert.deepEqual(seenTimeouts, [1500, 1500]);
    assert.equal(action.ragResult.used_rag, true);
    assert.equal(action.ragResult.rag_product_scope, "smart_website");
    assert.equal(action.plan.rag_used, true);
    assert.equal(action.plan.rag_fallback_used, false);
    const completed = events.find((event) => event.eventType === "rag_retrieval_completed");
    assert.ok(completed);
    assert.equal(completed.payload.used_rag, true);
    assert.equal(completed.payload.rag_result_count, 1);
    assert.equal(completed.payload.rag_product_scope, "smart_website");
    assert.equal(completed.payload.rag_attempt_count, 2);
    assert.equal(completed.payload.rag_success_count, 1);
    assert.equal(completed.payload.rag_timeout_count, 1);
    assert.deepEqual(completed.payload.rag_attempt_fallback_reasons, ["timeout"]);
    assert.equal("transcript" in completed.payload, false);
    assert.equal("query" in completed.payload, false);
  });
});

test("10AG: live RAG records failed event only after all configured timeout attempts fail", async () => {
  await withEnv(ragEnv({ VOICE_RAG_RETRIEVE_TIMEOUT_MS: "1500", VOICE_RAG_RETRIEVE_MAX_ATTEMPTS: "3" }), async () => {
    let calls = 0;
    const result = await retrieveV4RagAnswer({
      config: loadConfig(),
      agentConfig: loadAgentConfig(loadConfig()),
      transcript: TRANSCRIPT,
      memory: smartWebsiteMemory(),
      stateMachine: { state: V4_STATES.THINKING },
      retrieveFn: async () => {
        calls += 1;
        return { ok: false, reason: "timeout", latencyMs: 1501 };
      },
    });

    assert.equal(calls, 3);
    assert.equal(result.used_rag, false);
    assert.equal(result.fallback_reason, "timeout");
    assert.equal(result.rag_attempt_count, 3);
    assert.equal(result.rag_timeout_count, 3);
    assert.ok(result.answer.length > 0);
  });
});
