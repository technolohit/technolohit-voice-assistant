import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { buildQualityEventInput, validateQualityEventInput } from "../src/v4/quality-events.js";
import { createQualityEventSink } from "../src/v4/quality-event-sink.js";
import { enrichQualityEventForPersistence } from "../src/v4/quality-persistence.js";
import { finishLiveCanaryCall } from "../src/v4/live-audiosocket-handler.js";
import { createLiveCanaryRuntime } from "../src/v4/canary-runtime-loop.js";
import {
  flushLiveCanaryQualityEvents,
  canFlushLiveCanaryQuality,
  resolveLiveQualityInsertFn
} from "../src/v4/live-quality-flush-endpoint.js";
import { buildLiveCanaryCallQualitySummary } from "../src/v4/quality-analytics.js";
import { assertNoRawPhoneInPayload } from "../src/v4/privacy-sanitize.js";

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

function liveCanaryEnv(allowlist = "qa-canary") {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "true",
    VOICE_V4_LIVE_CANARY_ALLOWLIST: allowlist
  };
}

function makeCtx(overrides = {}) {
  const ctx = {
    bridgeCallId: overrides.bridgeCallId ?? randomUUID(),
    callSessionId: overrides.callSessionId ?? randomUUID(),
    callHandler: overrides.callHandler ?? "v4_canary"
  };
  ctx.externalCallId = overrides.externalCallId ?? `bridge:${ctx.bridgeCallId}`;
  return ctx;
}

function sampleBufferedEvent(overrides = {}) {
  return buildQualityEventInput({
    config: loadConfig(),
    callSessionId: overrides.callSessionId ?? randomUUID(),
    eventType: overrides.eventType ?? "vad_speech_start",
    eventStage: "vad",
    metricName: "vad_speech_start_ms",
    metricValue: 12,
    payload: {
      bridge_call_id: "qa-flush-1",
      last_rms: 800,
      ...(overrides.payload ?? {})
    }
  });
}

test("10G: v3 path does not flush live quality events", async () => {
  const config = loadConfig();
  const ctx = makeCtx({ callHandler: "v3" });
  const runtime = { liveCanary: false, qualityEventsBuffer: [sampleBufferedEvent()] };
  const flush = await flushLiveCanaryQualityEvents(config, ctx, runtime);
  assert.equal(flush.reason, "not_v4_canary");
  assert.equal(runtime.qualityEventsBuffer.length, 1);
});

test("10G: empty buffer still writes summary and close events when insert is available", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-flush-empty", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    const inserted = [];
    const result = await finishLiveCanaryCall(config, ctx, "socket_close", {
      insertFn: async (event) => {
        inserted.push(event);
        return { ok: true };
      }
    });
    assert.equal(result.ok, true);
    assert.equal(ctx.v4LiveRuntime, null);
    assert.equal(inserted.length, 2);
    assert.ok(inserted.some((e) => e.eventType === "live_call_quality_summary"));
    assert.ok(inserted.some((e) => e.eventType === "audio_session_closed"));
    assert.equal(result.qualityFlush?.reason, "flushed");
  });
});

test("10G: live canary flushes buffered events on finish with mock insert", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const callSessionId = randomUUID();
    const ctx = makeCtx({
      bridgeCallId: "qa-canary-flush-ok",
      callHandler: "v4_canary",
      callSessionId
    });
    const runtime = createLiveCanaryRuntime(config, ctx);
    runtime.qualityEventsBuffer = [
      sampleBufferedEvent({ callSessionId, eventType: "stt_completed", metricName: "stt_ms", metricValue: 90 }),
      sampleBufferedEvent({ callSessionId, eventType: "tts_started" })
    ];
    runtime.endpointCount = 2;
    runtime.sttCompletedCount = 1;
    runtime.ttsCompletedCount = 1;
    ctx.v4LiveRuntime = runtime;

    const inserted = [];
    const result = await finishLiveCanaryCall(config, ctx, "socket_close", {
      insertFn: async (event) => {
        inserted.push(event);
        return { ok: true, reason: "inserted" };
      }
    });

    assert.equal(result.ok, true);
    assert.equal(ctx.v4LiveRuntime, null);
    assert.ok(inserted.length >= 3);
    assert.ok(inserted.some((e) => e.eventType === "live_call_quality_summary"));
    assert.ok(inserted.some((e) => e.eventType === "audio_session_closed"));
    assert.equal(result.qualityFlush?.inserted_count, inserted.length);
    assert.equal(runtime.qualityEventsBuffer.length, 0);
  });
});

test("10G: flush enriches tenant agent and version metadata", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const agent = loadAgentConfig(config);
    const callSessionId = randomUUID();
    const ctx = makeCtx({ callHandler: "v4_canary", callSessionId });
    const runtime = createLiveCanaryRuntime(config, ctx);
    runtime.qualityEventsBuffer = [sampleBufferedEvent({ callSessionId })];
    ctx.v4LiveRuntime = runtime;

    const inserted = [];
    await finishLiveCanaryCall(config, ctx, "hangup", {
      insertFn: async (event) => {
        inserted.push(event);
        return { ok: true };
      }
    });

    const sttLike = inserted.find((e) => e.eventType === "vad_speech_start");
    assert.ok(sttLike);
    assert.equal(sttLike.tenantId, "technolohit");
    assert.equal(sttLike.agentId, "main_voice_sales");
    assert.equal(sttLike.payload.runtime_version, agent.config.runtime_version);
    assert.equal(sttLike.payload.agent_config_version, agent.config.agent_config_version);
    assert.ok(sttLike.payload.prompt_playbook_version);
    assert.ok(sttLike.payload.knowledge_version);
  });
});

test("10G: flush redacts phone-like payloads before insert", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const callSessionId = randomUUID();
    const ctx = makeCtx({ callHandler: "v4_canary", callSessionId });
    const runtime = createLiveCanaryRuntime(config, ctx);
    runtime.qualityEventsBuffer = [
      sampleBufferedEvent({
        callSessionId,
        payload: {
          bridge_call_id: "qa-canary-flush-redact",
          note: "Rueckruf unter +4917012345678"
        }
      })
    ];
    ctx.v4LiveRuntime = runtime;

    const inserted = [];
    await finishLiveCanaryCall(config, ctx, "socket_close", {
      insertFn: async (event) => {
        inserted.push(event);
        return { ok: true };
      }
    });

    assert.ok(inserted.length >= 1);
    for (const row of inserted) {
      assert.equal(assertNoRawPhoneInPayload(row.payload), true);
      assert.equal(validateQualityEventInput(row).ok, true);
    }
  });
});

test("10G: insert failures do not throw and call end still clears runtime", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-flush-fail", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    runtime.qualityEventsBuffer = [sampleBufferedEvent({ callSessionId: ctx.callSessionId })];
    ctx.v4LiveRuntime = runtime;

    let postCallRan = false;
    const result = await finishLiveCanaryCall(config, ctx, "error", {
      insertFn: async () => {
        throw new Error("relation_voice_call_quality_events_missing");
      }
    });

    postCallRan = true;
    assert.equal(postCallRan, true);
    assert.equal(ctx.v4LiveRuntime, null);
    assert.equal(result.ok, true);
    assert.equal(result.qualityFlush?.ok, false);
    assert.ok((result.qualityFlush?.failed ?? 0) >= 1);
  });
});

test("10G: live summary includes endpoint and media counters", () => {
  return withEnv(liveCanaryEnv("qa-canary"), () => {
    const config = loadConfig();
    const ctx = makeCtx();
    const runtime = createLiveCanaryRuntime(config, ctx);
    runtime.endpointCount = 3;
    runtime.sttCompletedCount = 2;
    runtime.ttsCompletedCount = 1;
    runtime.ttsFailedCount = 1;
    runtime.playbackCompletedCount = 1;
    runtime.bargeInCount = 1;
    runtime.dialogueCompletedCount = 2;
    const events = [
      sampleBufferedEvent({ eventType: "rag_retrieval_completed" }),
      sampleBufferedEvent({ eventType: "rag_retrieval_failed", payload: { fallback_reason: "timeout" } }),
      sampleBufferedEvent({ eventType: "runtime_error", payload: { error_class: "stt_failed" } })
    ];
    const summary = buildLiveCanaryCallQualitySummary(runtime, ctx, events, {
      persistMetadata: runtime.runtimeContext.persistMetadata
    });
    assert.equal(summary.live_counters.endpoint_count, 3);
    assert.equal(summary.live_counters.stt_completed_count, 2);
    assert.equal(summary.live_counters.barge_in_count, 1);
    assert.equal(summary.counters.rag_used_count, 1);
    assert.equal(summary.counters.rag_failed_count, 1);
    assert.equal(summary.privacy_ok, true);
  });
});

test("10G: default config has no live insert fn without DB", () => {
  withEnv(liveCanaryEnv("qa-canary"), () => {
    const config = loadConfig();
    const ctx = makeCtx({ callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    const insertFn = resolveLiveQualityInsertFn(config, runtime, { persistQualityToDb: false });
    assert.equal(insertFn, null);
    const gate = canFlushLiveCanaryQuality(config, ctx, runtime);
    assert.equal(gate.ok, true);
    assert.equal(gate.writable, false);
  });
});

test("10G: v3 quality sink flush still blocked", async () => {
  const sink = createQualityEventSink({
    v4PathActive: false,
    insertFn: async () => ({ ok: true })
  });
  sink.bufferQualityEvent(sampleBufferedEvent());
  const flush = await sink.flushQualityEvents();
  assert.equal(flush.reason, "v3_path_no_flush");
});

test("10G: enrich helper redacts before persistence", () => {
  const config = loadConfig();
  const agent = loadAgentConfig(config);
  const enriched = enrichQualityEventForPersistence(
    sampleBufferedEvent({ payload: { caller_phone: "+491709998877" } }),
    { config, agentConfig: agent }
  );
  assert.equal(enriched.payload.caller_phone, "[redacted]");
  assert.equal(validateQualityEventInput(enriched).ok, true);
});
