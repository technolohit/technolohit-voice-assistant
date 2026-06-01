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
import { createQualityEventSink, isQualityEventSinkWritable } from "../src/v4/quality-event-sink.js";
import {
  enrichQualityEventForPersistence,
  createDbQualityEventInsertFn,
  flushOrchestratorQualityEvents
} from "../src/v4/quality-persistence.js";
import {
  buildCallQualitySummary,
  classifyQualityError
} from "../src/v4/quality-analytics.js";
import { createDialogueOrchestrator, closeCall } from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { validateQualityEventInput } from "../src/v4/quality-events.js";
import { assertNoRawPhoneInPayload } from "../src/v4/privacy-sanitize.js";

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

function sampleEvent(overrides = {}) {
  return {
    tenantId: "technolohit",
    agentId: "main_voice_sales",
    callSessionId: null,
    eventType: "turn_started",
    eventStage: "dialogue",
    payload: { bridge_call_id: "q-1", turn_index: 1 },
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

test("quality sink flushes only on v4 active path", async () => {
  const v3Sink = createQualityEventSink({ v4PathActive: false, insertFn: async () => ({ ok: true }) });
  v3Sink.bufferQualityEvent(sampleEvent());
  const v3Flush = await v3Sink.flushQualityEvents();
  assert.equal(v3Flush.ok, false);
  assert.equal(v3Flush.reason, "v3_path_no_flush");

  const v4Sink = createQualityEventSink({
    v4PathActive: true,
    insertFn: async () => ({ ok: true, reason: "inserted" })
  });
  v4Sink.bufferQualityEvent(sampleEvent());
  const v4Flush = await v4Sink.flushQualityEvents({ v4PathActive: true });
  assert.equal(v4Flush.flushed, 1);
  assert.equal(v4Flush.failed, 0);
});

test("flush enriches and redacts payload before insert", async () => {
  const config = loadConfig();
  const agent = loadAgentConfig(config);
  const ctx = createRuntimeContext(config, { bridgeCallId: "persist-1" });
  const inserted = [];
  const sink = createQualityEventSink({
    v4PathActive: true,
    insertFn: async (event) => {
      inserted.push(event);
      return { ok: true, reason: "inserted" };
    }
  });
  sink.bufferQualityEvent(
    sampleEvent({
      payload: {
        bridge_call_id: "persist-1",
        caller_phone: "+491701234567",
        note: "call +49 170 1234567"
      }
    })
  );
  await sink.flushQualityEvents({
    v4PathActive: true,
    persistMetadata: ctx.persistMetadata,
    config,
    agentConfig: agent
  });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].payload.caller_phone, "[redacted]");
  assert.match(inserted[0].payload.note, /\[phone_redacted\]/);
  assert.equal(inserted[0].payload.runtime_version, ctx.persistMetadata.runtime_version);
  assert.equal(assertNoRawPhoneInPayload(inserted[0].payload), true);
});

test("insert failure is captured and does not throw through flush", async () => {
  const sink = createQualityEventSink({
    v4PathActive: true,
    insertFn: async () => {
      throw new Error("db_down");
    }
  });
  sink.bufferQualityEvent(sampleEvent({ eventType: "stt_completed", metricName: "stt_ms", metricValue: 120 }));
  sink.bufferQualityEvent(sampleEvent({ eventType: "tts_started" }));
  let flushError = null;
  const result = await sink.flushQualityEvents({ v4PathActive: true }).catch((err) => {
    flushError = err;
    return null;
  });
  assert.equal(flushError, null);
  assert.ok(result);
  assert.equal(result.failed, 2);
  assert.equal(result.flushed, 0);
  assert.equal(result.failures[0].reason, "insert_exception");
});

test("latency rollup computes expected values", () => {
  const summary = buildCallQualitySummary([
    sampleEvent({ eventType: "stt_completed", metricName: "stt_ms", metricValue: 100 }),
    sampleEvent({ eventType: "stt_completed", metricName: "stt_ms", metricValue: 200 }),
    sampleEvent({ eventType: "rag_retrieval_completed", metricName: "rag_ms", metricValue: 55 }),
    sampleEvent({
      eventType: "playback_cancelled",
      metricName: "cancel_latency_ms",
      metricValue: 180
    }),
    sampleEvent({ eventType: "vad_endpoint_detected", metricName: "endpoint_ms", metricValue: 420 })
  ]);
  assert.equal(summary.latencies.stt.count, 2);
  assert.equal(summary.latencies.stt.avg, 150);
  assert.equal(summary.latencies.rag.max, 55);
  assert.equal(summary.latencies.barge_in_cancel.max, 180);
  assert.equal(summary.latencies.endpointing.max, 420);
});

test("counters compute expected values", () => {
  const summary = buildCallQualitySummary([
    sampleEvent({ eventType: "turn_started" }),
    sampleEvent({ eventType: "turn_started" }),
    sampleEvent({ eventType: "barge_in_detected" }),
    sampleEvent({ eventType: "rag_retrieval_completed" }),
    sampleEvent({ eventType: "rag_retrieval_failed", payload: { fallback_reason: "timeout" } }),
    sampleEvent({ eventType: "lead_created" }),
    sampleEvent({ eventType: "lead_skipped", payload: { reason: "not_callback_ready" } })
  ]);
  assert.equal(summary.counters.turn_count, 2);
  assert.equal(summary.counters.interruption_count, 1);
  assert.equal(summary.counters.rag_used_count, 1);
  assert.equal(summary.counters.rag_failed_count, 1);
  assert.equal(summary.counters.lead_created_count, 1);
  assert.equal(summary.counters.lead_skipped_count, 1);
  assert.equal(summary.lead_skip_reasons.not_callback_ready, 1);
  assert.equal(summary.errors.rag_timeout, 1);
});

test("classifyQualityError maps provider and runtime failures", () => {
  assert.equal(
    classifyQualityError({ eventType: "rag_retrieval_failed", payload: { fallback_reason: "timeout" } }),
    "rag_timeout"
  );
  assert.equal(classifyQualityError({ eventType: "post_call_error" }), "post_call_error");
  assert.equal(
    classifyQualityError({ eventType: "rag_retrieval_failed", payload: { fallback_reason: "rate_limit" } }),
    "provider_rate_limited"
  );
});

test("tenant_id and agent_id preserved in summary and enriched events", () => {
  const config = loadConfig();
  const agent = loadAgentConfig(config);
  const meta = createRuntimeContext(config, { bridgeCallId: "tenant-1" }).persistMetadata;
  const enriched = enrichQualityEventForPersistence(sampleEvent(), {
    persistMetadata: meta,
    config,
    agentConfig: agent
  });
  assert.equal(enriched.tenantId, "technolohit");
  assert.equal(enriched.agentId, "main_voice_sales");
  assert.ok(enriched.payload.agent_config_version);
  const summary = buildCallQualitySummary([sampleEvent()], { persistMetadata: meta });
  assert.equal(summary.tenant_id, "technolohit");
  assert.equal(summary.agent_id, "main_voice_sales");
});

test("createDbQualityEventInsertFn fails closed when DB disabled", async () => {
  const config = loadConfig();
  const insertFn = createDbQualityEventInsertFn({ ...config, db: { enabled: false } });
  const result = await insertFn(sampleEvent());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "db_disabled");
});

test("flushOrchestratorQualityEvents skips v3 orchestrator", async () => {
  const config = loadConfig();
  const orchestrator = createDialogueOrchestrator({
    config,
    runtimeContext: createRuntimeContext(config, { bridgeCallId: "v3-orch" }),
    v4PathActive: false
  });
  orchestrator.qualitySink.bufferQualityEvent(sampleEvent());
  const flush = await flushOrchestratorQualityEvents(orchestrator);
  assert.equal(flush.reason, "v3_path_no_flush");
});

test("canary close produces quality summary without full phone", async () => {
  await withEnv(dialogueEnv(), async () => {
    const runtime = createCanaryDialogueRuntime(loadConfig(), {
      harnessExplicit: true,
      bridgeCallId: "close-q-1"
    });
    runtime.orchestrator.callerPhoneNormalized = "+491701234567";
    await simulateInboundTranscriptTurn(runtime, "Was ist Smart Website?");
    const closed = await closeCanaryDialogueRuntime(runtime);
    assert.equal(closed.ok, true);
    assert.ok(closed.qualitySummary);
    assert.equal(closed.qualitySummary.privacy_ok, true);
    assert.ok(closed.qualitySummary.counters.event_count >= 3);
    assert.equal(closed.qualityFlush.memory_only, true);
    for (const event of closed.qualityFlush.events ?? []) {
      assert.equal(validateQualityEventInput(event).ok, true);
    }
  });
});

test("isQualityEventSinkWritable requires v4 runtime and insertFn", () => {
  withEnv(dialogueEnv(), () => {
    const config = loadConfig();
    const writable = createQualityEventSink({
      v4PathActive: true,
      insertFn: async () => ({ ok: true })
    });
    assert.equal(isQualityEventSinkWritable(writable, config), true);
    withEnv({ VOICE_RUNTIME_VERSION: "v3" }, () => {
      assert.equal(isQualityEventSinkWritable(writable, loadConfig()), false);
    });
  });
});

test("closeCall buffers events; flush persists with mock insert", async () => {
  await withEnv(dialogueEnv(), async () => {
    const config = loadConfig();
    const inserted = [];
    const sink = createQualityEventSink({
      v4PathActive: true,
      insertFn: async (event) => {
        inserted.push(event);
        return { ok: true };
      }
    });
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: createRuntimeContext(config, { bridgeCallId: "flush-1" }),
      qualitySink: sink,
      v4PathActive: true
    });
    closeCall(orchestrator);
    const flush = await flushOrchestratorQualityEvents(orchestrator);
    assert.ok(flush.events.length >= 2);
    assert.equal(flush.flushed, flush.events.length);
    assert.equal(inserted.length, flush.flushed);
    assert.equal(flush.summary.conversion.lead_skipped >= 0 || flush.summary.conversion.lead_created >= 0, true);
  });
});
