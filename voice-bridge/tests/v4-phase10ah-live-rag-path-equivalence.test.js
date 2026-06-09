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
import { runRagRetrievePreflight } from "../src/v4/rag-retrieve-preflight.js";
import {
  formatRagLivePathPreflightLines,
  runRagLivePathPreflight,
} from "../src/v4/rag-live-path-preflight.js";
import { buildSafeRagEventDiagnostics } from "../src/v4/rag-quality-diagnostics.js";
import { LIVE_GATE3_COMBINED_TRANSCRIPT } from "../src/v4/rag-retrieve-probe.js";
import { V4_STATES } from "../src/v4/state-machine.js";

const TRANSCRIPT = LIVE_GATE3_COMBINED_TRANSCRIPT;

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
    VOICE_RAG_RETRIEVE_TIMEOUT_MS: "1500",
    VOICE_RAG_RETRIEVE_MAX_ATTEMPTS: "3",
    ...overrides,
  };
}

const scopedHitFn = async () => ({
  ok: true,
  hit: true,
  hitCount: 1,
  topScore: 0.88,
  status: 200,
  latencyMs: 340,
  data: {
    answer_context: [{
      snippet: "Smart Website strukturiert Inhalte und Anfragen.",
      score: 0.88,
      metadata: { product_id: "smart_website" },
      source_uri: "kb://products.technolohit.json#smart_website",
    }],
  },
});

const contentOnlyScopedHitFn = async () => ({
  ok: true,
  hit: true,
  hitCount: 1,
  topScore: 0.78,
  status: 200,
  latencyMs: 347,
  data: {
    answer_context: [{
      content: "Smart Website ist eine moderne Firmenwebsite mit klaren Leistungsseiten.",
      score: 0.78,
      metadata: { product_id: "smart_website" },
      source_uri: "kb://products.technolohit.json#smart_website",
    }],
  },
});

const wrongProductHitFn = async () => ({
  ok: true,
  hit: true,
  hitCount: 1,
  topScore: 0.91,
  status: 200,
  latencyMs: 347,
  data: {
    answer_context: [{
      snippet: "Digitale Rezeption beantwortet Anrufe.",
      score: 0.91,
      metadata: { product_id: "voice_agent" },
      source_uri: "kb://products.technolohit.json#voice_agent",
    }],
  },
});

const unsafeHitFn = async () => ({
  ok: true,
  hit: true,
  hitCount: 1,
  topScore: 0.9,
  status: 200,
  latencyMs: 300,
  data: {
    answer_context: [{
      snippet: "Rufen Sie uns an unter +491701234567890.",
      score: 0.9,
      metadata: { product_id: "smart_website" },
    }],
  },
});

test("10AH: live-path preflight passes when retrieveV4RagAnswer would use RAG", async () => {
  await withEnv(ragEnv(), async () => {
    const result = await runRagLivePathPreflight(loadConfig(), {
      skipCanary: true,
      retrieveFn: scopedHitFn,
    });
    assert.equal(result.ok, true);
    assert.equal(result.used_rag, true);
    assert.equal(result.product_scope, "smart_website");
    assert.ok(result.result_count > 0);
    assert.equal(result.fallback_reason, null);
    assert.ok(result.top_score >= 0.72);
    assert.match(formatRagLivePathPreflightLines(result), /rag_live_path_preflight=pass/);
    assert.doesNotMatch(formatRagLivePathPreflightLines(result), /Was ist Smart Website/);
  });
});

test("10AI: live-path preflight accepts rag-api content-only chunks", async () => {
  await withEnv(ragEnv(), async () => {
    const result = await runRagLivePathPreflight(loadConfig(), {
      skipCanary: true,
      retrieveFn: contentOnlyScopedHitFn,
    });
    assert.equal(result.ok, true);
    assert.equal(result.used_rag, true);
    assert.equal(result.result_count, 1);
    assert.equal(result.result_count_after_product_filter, 1);
    assert.equal(result.fallback_reason, null);
  });
});

test("10AH: raw retrieve preflight can pass while live-path preflight fails on product filter", async () => {
  await withEnv(ragEnv(), async () => {
    const config = loadConfig();
    const raw = await runRagRetrievePreflight(config, {
      skipCanary: true,
      retrieveFn: wrongProductHitFn,
    });
    const live = await runRagLivePathPreflight(config, {
      skipCanary: true,
      retrieveFn: wrongProductHitFn,
    });
    assert.equal(raw.ok, true);
    assert.equal(live.ok, false);
    assert.equal(live.fallback_reason, "rag_wrong_product_scope");
    assert.equal(live.raw_result_count_before_voice_filter, 1);
    assert.equal(live.result_count_after_product_filter, 0);
    assert.match(live.failures.join(","), /rag_wrong_product_scope/);
  });
});

test("10AH: live-path preflight fails when answer safety rejects chunks", async () => {
  await withEnv(ragEnv(), async () => {
    const result = await runRagLivePathPreflight(loadConfig(), {
      skipCanary: true,
      retrieveFn: unsafeHitFn,
    });
    assert.equal(result.ok, false);
    assert.equal(result.used_rag, false);
    assert.equal(result.fallback_reason, "rag_unsafe_or_empty");
    assert.match(result.failures.join(","), /rag_unsafe_or_empty/);
  });
});

test("10AH: live diagnostics include before/after counts and no raw query", async () => {
  await withEnv(ragEnv(), async () => {
    const config = loadConfig();
    const agentConfig = loadAgentConfig(config);
    const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10ah" }), "smart_website");
    const ragResult = await retrieveV4RagAnswer({
      config,
      agentConfig,
      transcript: TRANSCRIPT,
      memory,
      stateMachine: { state: V4_STATES.THINKING },
      retrieveFn: wrongProductHitFn,
    });
    const diagnostics = buildSafeRagEventDiagnostics({
      config,
      transcript: TRANSCRIPT,
      ragResult,
      productScope: "smart_website",
      tenantId: "technolohit",
      agentId: "main_voice_sales",
    });
    assert.equal(diagnostics.normalized_query_type, "combined_product_inquiry");
    assert.equal(diagnostics.query_chars, TRANSCRIPT.length);
    assert.equal(diagnostics.raw_result_count_before_voice_filter, 1);
    assert.equal(diagnostics.result_count_after_product_filter, 0);
    assert.equal(diagnostics.top_score_before_filter, 0.91);
    assert.equal(diagnostics.top_score_after_filter, null);
    assert.equal("query" in diagnostics, false);
    assert.equal("transcript" in diagnostics, false);
  });
});

test("10AH: orchestrator RAG failed event includes filter diagnostics without PII", async () => {
  await withEnv(ragEnv(), async () => {
    const config = loadConfig();
    const events = [];
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: createRuntimeContext(config, { bridgeCallId: "10ah-orchestrator" }),
      memory: setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10ah-orchestrator" }), "smart_website"),
      stateMachine: { state: V4_STATES.THINKING },
      agentConfig: loadAgentConfig(config),
      adapters: { ragRetriever: wrongProductHitFn },
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
    await decideNextAction(orchestrator, { transcript: TRANSCRIPT });

    const failed = events.find((event) => event.eventType === "rag_retrieval_failed");
    assert.ok(failed);
    assert.equal(failed.payload.fallback_reason, "rag_wrong_product_scope");
    assert.equal(failed.payload.raw_result_count_before_voice_filter, 1);
    assert.equal(failed.payload.result_count_after_product_filter, 0);
    assert.equal(failed.payload.normalized_query_type, "combined_product_inquiry");
    assert.equal(failed.payload.query_chars, TRANSCRIPT.length);
    assert.equal("query" in failed.payload, false);
    assert.equal("transcript" in failed.payload, false);
  });
});

test("10AH: low_score uses scoped top score after product filter", async () => {
  await withEnv(ragEnv(), async () => {
    const lowScopedHitFn = async () => ({
      ok: true,
      hit: true,
      hitCount: 1,
      topScore: 0.91,
      status: 200,
      latencyMs: 320,
      data: {
        answer_context: [{
          snippet: "Smart Website erklaert Angebote.",
          score: 0.65,
          metadata: { product_id: "smart_website" },
        }],
      },
    });
    const result = await retrieveV4RagAnswer({
      config: loadConfig(),
      agentConfig: loadAgentConfig(loadConfig()),
      transcript: TRANSCRIPT,
      memory: setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10ah-low" }), "smart_website"),
      stateMachine: { state: V4_STATES.THINKING },
      retrieveFn: lowScopedHitFn,
    });
    assert.equal(result.used_rag, false);
    assert.equal(result.fallback_reason, "rag_low_score");
    assert.equal(result.top_score_after_filter, 0.65);
    assert.equal(result.result_count_after_product_filter, 1);
  });
});

test("10AH: v3/RAG-off defaults unchanged", () => {
  return withEnv(
    {
      VOICE_RUNTIME_VERSION: undefined,
      VOICE_RAG_ENABLED: undefined,
      VOICE_RAG_SALES_ANSWERER_ENABLED: undefined,
    },
    () => {
      const config = loadConfig();
      assert.equal(config.v4?.runtimeVersion ?? "v3", "v3");
      assert.equal(config.rag.enabled, false);
      assert.equal(config.rag.salesAnswererEnabled, false);
    },
  );
});
