import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { generateTestTonePcm } from "../src/audio-media.js";
import { finalizeAudioSocketCall, finalizeAllActiveCallsOnShutdown } from "../src/call-finish.js";
import {
  registerActiveCall,
  clearActiveCallRegistryForTests,
  getActiveCallRegistrySize
} from "../src/active-call-registry.js";
import { createSttAdapter } from "../src/v4/stt-adapter.js";
import { transcribeOpenAiPcmUtterance8k } from "../src/v4/openai-stt-provider.js";
import { sanitizeOpenAiErrorSnippet, parseOpenAiErrorBody } from "../src/v4/openai-stt-diagnostics.js";
import {
  runOpenAiSttPreflight,
  formatOpenAiSttPreflightLines
} from "../src/v4/openai-stt-preflight.js";
import { createLiveSttAdapter } from "../src/v4/live-stt-endpoint.js";
import { createLiveCanaryRuntime } from "../src/v4/canary-runtime-loop.js";
import { processLiveCanaryInboundFrame } from "../src/v4/live-audiosocket-handler.js";
import { assertNoRawPhoneInPayload } from "../src/v4/privacy-sanitize.js";
import { createTtsAdapter } from "../src/v4/tts-adapter.js";

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
    VOICE_V4_LIVE_CANARY_ALLOWLIST: allowlist,
    VOICE_V4_STT_ALLOW_MOCK_FOR_TESTS: "true"
  };
}

function makeCtx(overrides = {}) {
  const ctx = {
    bridgeCallId: overrides.bridgeCallId ?? randomUUID(),
    callSessionId: overrides.callSessionId ?? randomUUID(),
    callHandler: overrides.callHandler ?? "v4_canary",
    closed: false,
    finishInProgress: false,
    callEndedPersisted: false,
    postCallTriggered: false,
    framesReceived: 0,
    bytesReceived: 0,
    silenceTimer: null
  };
  ctx.externalCallId = overrides.externalCallId ?? `bridge:${ctx.bridgeCallId}`;
  return ctx;
}

function makePcmFrame(amplitude, samples = 160) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(amplitude, i * 2);
  }
  return buf;
}

function createMockLiveSocket() {
  const writes = [];
  return {
    writable: true,
    write(data) {
      writes.push(Buffer.from(data));
      return true;
    },
    once() {},
    writes
  };
}

async function feedSpeechUtteranceWithEndpoint(config, ctx, runtime, socket) {
  ctx.v4LiveSocket = socket;
  runtime.liveSocket = socket;
  for (let i = 0; i < 15; i += 1) {
    await processLiveCanaryInboundFrame(config, ctx, runtime, makePcmFrame(800));
  }
  for (let i = 0; i < 30; i += 1) {
    await processLiveCanaryInboundFrame(config, ctx, runtime, makePcmFrame(0));
  }
}

test("10J: OpenAI STT HTTP error captures safe diagnostics", async () => {
  const pcm = generateTestTonePcm(8000, 200);
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    async text() {
      return JSON.stringify({
        error: {
          code: "invalid_api_key",
          type: "invalid_request_error",
          message: "Incorrect API key provided: sk-secret123"
        }
      });
    }
  });

  const result = await transcribeOpenAiPcmUtterance8k({
    pcmBuffer: pcm,
    apiKey: "sk-test",
    fetchImpl,
    frameCount: 10
  });

  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 401);
  assert.equal(result.errorCode, "invalid_api_key");
  assert.equal(result.diagnostics.pcm_bytes, pcm.length);
  assert.ok(result.diagnostics.wav_bytes > pcm.length);
  assert.ok(!String(result.message).includes("sk-secret123"));
  assert.ok(!String(JSON.stringify(result.diagnostics)).includes("sk-secret123"));
  assert.equal(assertNoRawPhoneInPayload(result.diagnostics), true);
});

test("10J: sanitizeOpenAiErrorSnippet redacts bearer and phone", () => {
  const snippet = sanitizeOpenAiErrorSnippet(
    "Bearer sk-abc123 failed for +491701234567"
  );
  assert.ok(!snippet.includes("sk-abc123"));
  assert.ok(!snippet.includes("+491701234567"));
});

test("10J: STT failure triggers fallback playback not silence", async () => {
  await withEnv(liveCanaryEnv("qa-canary-stt-fallback"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-stt-fallback", callHandler: "v4_canary" });
    const socket = createMockLiveSocket();
    const adapter = createSttAdapter({ provider: "mock", enabled: true });
    adapter.completeSttTurn = () => ({
      ok: false,
      error: { code: "stt_timeout", message: "timeout", recoverable: true },
      diagnostics: {
        stt_provider: "mock",
        stt_http_status: 504,
        pcm_bytes: 3200,
        wav_bytes: 3244,
        utterance_frames: 20
      }
    });
    const runtime = createLiveCanaryRuntime(config, ctx, {
      sttAdapter: adapter,
      ttsAdapter: createTtsAdapter({ provider: "mock", enabled: true })
    });
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime, socket);

    assert.equal(runtime.sttCompletedCount, 0);
    assert.equal(runtime.lastCallerTurnCandidate, null);

    const sttErrors = runtime.qualityEventsBuffer.filter(
      (e) => e.eventType === "runtime_error" && e.payload?.event_subtype === "stt_error"
    );
    assert.equal(sttErrors.length, 1);
    assert.equal(sttErrors[0].payload?.stt_http_status, 504);
    assert.equal(sttErrors[0].payload?.stt_error_code, "stt_timeout");
    assert.equal(assertNoRawPhoneInPayload(sttErrors[0].payload), true);
    assert.notEqual(sttErrors[0].payload?.event_subtype, "stt_failure_fallback");

    const fallbackEvents = runtime.qualityEventsBuffer.filter(
      (e) => e.payload?.event_subtype === "stt_failure_fallback"
    );
    assert.equal(fallbackEvents.length, 1);
    assert.equal(fallbackEvents[0].payload?.stt_failed_fallback_prompted, true);
    assert.ok(socket.writes.length > 0, "caller should hear fallback audio frames");
  });
});

test("10J: openai STT adapter propagates diagnostics on failure", async () => {
  await withEnv({ VOICE_V4_STT_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" }, async () => {
    const config = loadConfig();
    const fetchImpl = async () => ({
      ok: false,
      status: 400,
      async text() {
        return JSON.stringify({ error: { code: "invalid_file", message: "bad audio" } });
      }
    });
    const adapter = createLiveSttAdapter(config, {
      fetchImpl,
      apiKey: "sk-test",
      suppressMockWarning: true
    });
    assert.equal(adapter.provider, "openai");
    const started = adapter.startSttStream({ streamId: "diag-1", language: "de" });
    adapter.appendAudio(started.streamId, generateTestTonePcm(8000, 200));
    const completed = await adapter.completeSttTurnAsync(started.streamId);
    assert.equal(completed.ok, false);
    assert.equal(completed.diagnostics?.stt_http_status, 400);
    assert.equal(completed.diagnostics?.stt_error_code, "invalid_file");
    assert.equal(assertNoRawPhoneInPayload(completed.diagnostics), true);
  });
});

test("10J: preflight prints safe lines and passes with mock fetch", async () => {
  const config = loadConfig();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { text: "test" };
    }
  });
  const result = await runOpenAiSttPreflight(config, { fetchImpl, apiKey: "sk-test" });
  assert.equal(result.ok, true);
  const lines = formatOpenAiSttPreflightLines(result);
  assert.match(lines, /openai_stt_preflight=pass/);
  assert.ok(!lines.includes("sk-test"));
  assert.ok(!lines.includes("test"));
});

test("10J: preflight fail reports http_status and error_code", async () => {
  const config = loadConfig();
  const fetchImpl = async () => ({
    ok: false,
    status: 503,
    async text() {
      return JSON.stringify({ error: { code: "server_error", message: "unavailable" } });
    }
  });
  const result = await runOpenAiSttPreflight(config, { fetchImpl, apiKey: "sk-test" });
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 503);
  assert.equal(result.errorCode, "server_error");
});

test("10J: preflight treats empty transcript on synthetic tone as connectivity pass", async () => {
  const config = loadConfig();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { text: "" };
    }
  });
  const result = await runOpenAiSttPreflight(config, { fetchImpl, apiKey: "sk-test" });
  assert.equal(result.ok, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.errorCode, "empty_transcript_on_tone");
  const lines = formatOpenAiSttPreflightLines(result);
  assert.match(lines, /openai_stt_preflight=pass/);
  assert.match(lines, /error_code=empty_transcript_on_tone/);
});

test("10J: duplicate finish persists onCallEnded once", async () => {
  clearActiveCallRegistryForTests();
  const config = loadConfig();
  const ctx = makeCtx({ callHandler: "v4_canary" });
  let endCalls = 0;
  let postCalls = 0;

  const deps = {
    onCallEnded: async () => {
      endCalls += 1;
    },
    runPostCallProcessing: async () => {
      postCalls += 1;
    },
    finishLiveCanaryCall: async () => ({ ok: true })
  };

  await Promise.all([
    finalizeAudioSocketCall(config, ctx, "socket_close", deps),
    finalizeAudioSocketCall(config, ctx, "hangup", deps)
  ]);

  assert.equal(endCalls, 1);
  assert.equal(postCalls, 1);
  clearActiveCallRegistryForTests();
});

test("10J: v4 quality flush exception does not block endCallSession", async () => {
  const config = loadConfig();
  const ctx = makeCtx({ callHandler: "v4_canary" });
  let endCalls = 0;

  await finalizeAudioSocketCall(config, ctx, "socket_error", {
    finishLiveCanaryCall: async () => {
      throw new Error("quality flush failed");
    },
    onCallEnded: async () => {
      endCalls += 1;
    },
    runPostCallProcessing: async () => {}
  });

  assert.equal(endCalls, 1);
  assert.equal(ctx.callEndedPersisted, true);
});

test("10J: process shutdown finalizes active v4 canary call", async () => {
  clearActiveCallRegistryForTests();
  const config = loadConfig();
  const ctx = makeCtx({ callHandler: "v4_canary" });
  let endCalls = 0;

  registerActiveCall(ctx, async (reason) => {
    await finalizeAudioSocketCall(config, ctx, reason, {
      onCallEnded: async () => {
        endCalls += 1;
      },
      runPostCallProcessing: async () => {},
      finishLiveCanaryCall: async () => ({ ok: true })
    });
  });

  assert.equal(getActiveCallRegistrySize(), 1);

  await finalizeAllActiveCallsOnShutdown(config, "process_shutdown", {
    onCallEnded: async () => {
      endCalls += 1;
    },
    runPostCallProcessing: async () => {},
    finishLiveCanaryCall: async () => ({ ok: true })
  });

  assert.equal(endCalls, 1);
  assert.equal(getActiveCallRegistrySize(), 0);
  assert.equal(ctx.closed, true);
  clearActiveCallRegistryForTests();
});

test("10J: parseOpenAiErrorBody never includes raw transcript field", () => {
  const parsed = parseOpenAiErrorBody(
    JSON.stringify({ error: { code: "x", message: "Ich interessiere mich" } })
  );
  assert.equal(parsed.errorCode, "x");
  assert.ok(!JSON.stringify(parsed).includes("transcript"));
});
