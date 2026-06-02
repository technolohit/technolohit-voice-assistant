import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { validateQualityEventInput } from "../src/v4/quality-events.js";
import {
  flushLiveCanaryQualityEvents,
  buildSummaryQualityEvent
} from "../src/v4/live-quality-flush-endpoint.js";
import { buildLiveCanaryCallQualitySummary } from "../src/v4/quality-analytics.js";
import { finishLiveCanaryCall } from "../src/v4/live-audiosocket-handler.js";
import { createLiveCanaryRuntime } from "../src/v4/canary-runtime-loop.js";
import {
  beginLiveTurnLatency,
  markLiveTurnLatency,
  finalizeLiveTurnLatencyMetrics
} from "../src/v4/live-turn-latency.js";
import { buildResponsePlan } from "../src/v4/response-planner.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { isDefiniteCallerGoodbye, getWarmGoodbyeResponseText } from "../src/v4/transcript-intent.js";
import { RESPONSE_TYPES } from "../src/v4/response-planner.js";

function liveCanaryEnv() {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "true",
    VOICE_V4_LIVE_CANARY_ALLOWLIST: "qa-canary",
    VOICE_V4_STT_ALLOW_MOCK_FOR_TESTS: "true"
  };
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(() => restoreEnv(previous));
    }
    restoreEnv(previous);
    return result;
  } catch (err) {
    restoreEnv(previous);
    throw err;
  }
}

test("10M: live_call_quality_summary validates with UUID bridge_call_id in payload", () => {
  const config = loadConfig();
  const callSessionId = randomUUID();
  const bridgeCallId = randomUUID();
  const ctx = { bridgeCallId, callSessionId, callHandler: "v4_canary" };
  const runtime = { phase: "phase10m", endpointCount: 1, sttCompletedCount: 1, startedAt: Date.now() - 5000 };
  const summary = buildLiveCanaryCallQualitySummary(runtime, ctx, []);
  const event = buildSummaryQualityEvent(config, ctx, runtime, [], summary, "socket_close");
  assert.equal(event.eventType, "live_call_quality_summary");
  const validation = validateQualityEventInput(event);
  assert.equal(validation.ok, true, validation.errors?.join("; "));
});

test("10M: flush inserts live_call_quality_summary and audio_session_closed by eventType", async () => {
  await withEnv(liveCanaryEnv(), async () => {
    const config = loadConfig();
    const callSessionId = randomUUID();
    const bridgeCallId = randomUUID();
    const ctx = {
      bridgeCallId,
      callSessionId,
      callHandler: "v4_canary",
      externalCallId: `bridge:${bridgeCallId}`
    };
    const runtime = createLiveCanaryRuntime(config, ctx);
    runtime.qualityEventsBuffer = [];
    runtime.endpointCount = 2;
    runtime.sttCompletedCount = 1;
    ctx.v4LiveRuntime = runtime;

    const insertedByType = [];
    const result = await finishLiveCanaryCall(config, ctx, "socket_close", {
      insertFn: async (event) => {
        insertedByType.push(event.eventType);
        return { ok: true, reason: "inserted" };
      }
    });

    assert.equal(result.ok, true);
    assert.ok(
      insertedByType.includes("live_call_quality_summary"),
      `expected summary, got: ${insertedByType.join(",")}`
    );
    assert.ok(
      insertedByType.includes("audio_session_closed"),
      `expected close, got: ${insertedByType.join(",")}`
    );
    const summaryIndex = insertedByType.indexOf("live_call_quality_summary");
    const closeIndex = insertedByType.lastIndexOf("audio_session_closed");
    assert.ok(summaryIndex >= 0);
    assert.ok(closeIndex >= 0);
  });
});

test("10M: capstone retry does not duplicate already-inserted summary", async () => {
  await withEnv(liveCanaryEnv(), async () => {
    const config = loadConfig();
    const callSessionId = randomUUID();
    const bridgeCallId = randomUUID();
    const ctx = {
      bridgeCallId,
      callSessionId,
      callHandler: "v4_canary",
      externalCallId: `bridge:${bridgeCallId}`
    };
    const runtime = createLiveCanaryRuntime(config, ctx);
    runtime.qualityEventsBuffer = [];
    ctx.v4LiveRuntime = runtime;

    const insertedByType = [];
    let closedFailureInjected = false;
    const result = await finishLiveCanaryCall(config, ctx, "socket_close", {
      insertFn: async (event) => {
        if (event.eventType === "audio_session_closed" && !closedFailureInjected) {
          closedFailureInjected = true;
          return { ok: false, reason: "test_close_insert_failed" };
        }
        insertedByType.push(event.eventType);
        return { ok: true, reason: "inserted" };
      }
    });

    assert.equal(result.ok, true);
    assert.equal(
      insertedByType.filter((eventType) => eventType === "live_call_quality_summary").length,
      1
    );
    assert.equal(
      insertedByType.filter((eventType) => eventType === "audio_session_closed").length,
      1
    );
  });
});

test("10M: turn latency metrics computed for successful path", () => {
  const runtime = {};
  const base = Date.now();
  beginLiveTurnLatency(runtime, 0);
  runtime.currentTurnLatency.endpoint_detected_at = base;
  markLiveTurnLatency(runtime, "stt_completed", base + 100);
  markLiveTurnLatency(runtime, "dialogue_plan", base + 250);
  markLiveTurnLatency(runtime, "tts_started", base + 400);
  markLiveTurnLatency(runtime, "tts_first_chunk", base + 500);
  markLiveTurnLatency(runtime, "playback_started", base + 600);
  markLiveTurnLatency(runtime, "playback_completed", base + 1200);

  const metrics = finalizeLiveTurnLatencyMetrics(runtime);
  assert.equal(metrics.endpoint_to_stt_completed_ms, 100);
  assert.equal(metrics.stt_completed_to_dialogue_plan_ms, 150);
  assert.equal(metrics.dialogue_plan_to_tts_started_ms, 150);
  assert.equal(metrics.tts_started_to_first_chunk_ms, 100);
  assert.equal(metrics.endpoint_to_first_playback_ms, 600);
  assert.equal(metrics.total_turn_response_ms, 1200);
});

test("10M: summary includes turn_latency from runtime", () => {
  const runtime = {
    endpointCount: 1,
    lastTurnLatencyMetrics: {
      endpoint_to_stt_completed_ms: 90,
      total_turn_response_ms: 800
    }
  };
  const summary = buildLiveCanaryCallQualitySummary(runtime, {}, []);
  assert.equal(summary.turn_latency?.endpoint_to_stt_completed_ms, 90);
  assert.equal(summary.turn_latency?.total_turn_response_ms, 800);
});

test("10M: definite German goodbye uses warm closing text", () => {
  const agent = loadAgentConfig(loadConfig());
  assert.equal(isDefiniteCallerGoodbye("Auf Wiederhören"), true);
  assert.equal(isDefiniteCallerGoodbye("Nein danke, das war alles"), true);

  const plan = buildResponsePlan({
    agentConfig: agent,
    memory: { selected_product_id: "smart_website", current_state: "listening" },
    stateMachine: { state: "listening" },
    transcript: "Auf Wiederhören und vielen Dank"
  });

  assert.equal(plan.response_type, RESPONSE_TYPES.CLOSING);
  assert.match(plan.text, /Vielen Dank für Ihren Anruf/i);
  assert.match(plan.text, /Wiederhören/i);
  assert.ok(!plan.text.includes("Gibt es noch etwas"));
  assert.ok(!/\b(rückruf|rueckruf)\b/i.test(plan.text));
  assert.equal(plan.text, getWarmGoodbyeResponseText());
});

test("10M: product turn then goodbye closes warmly", () => {
  const agent = loadAgentConfig(loadConfig());
  const productPlan = buildResponsePlan({
    agentConfig: agent,
    memory: {},
    transcript: "Was kostet Smart Website?"
  });
  assert.equal(productPlan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);

  const goodbyePlan = buildResponsePlan({
    agentConfig: agent,
    memory: { selected_product_id: "smart_website", current_state: "answering_product_question" },
    stateMachine: { state: "answering_product_question" },
    transcript: "Tschüss, danke"
  });
  assert.equal(goodbyePlan.response_type, RESPONSE_TYPES.CLOSING);
  assert.match(goodbyePlan.text, /Wiederhören/i);
});
