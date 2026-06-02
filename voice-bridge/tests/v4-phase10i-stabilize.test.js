import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { pcmChunkBytes } from "../src/audio-media.js";
import { startSilenceWriter, stopSilenceWriter } from "../src/media-outbound.js";
import { finalizeAudioSocketCall } from "../src/call-finish.js";
import { describeRuntimeRoute, resolveRuntimeRoute } from "../src/v4/runtime-router.js";
import { createSttAdapter } from "../src/v4/stt-adapter.js";
import {
  createLiveSttAdapter,
  resolveLiveSttProvider,
  validateLiveCanarySttProvider,
  runLiveSttOnEndpoint
} from "../src/v4/live-stt-endpoint.js";
import { wrapPcm8kAsWav } from "../src/v4/pcm-wav.js";
import { transcribeOpenAiPcmUtterance8k } from "../src/v4/openai-stt-provider.js";
import { createLiveCanaryRuntime } from "../src/v4/canary-runtime-loop.js";
import { selectLiveCallHandler } from "../src/v4/live-audiosocket-handler.js";
import { runLiveTtsAndPlayback } from "../src/v4/live-tts-playback-endpoint.js";
import { createTtsAdapter } from "../src/v4/tts-adapter.js";
import { RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { V4_STATES } from "../src/v4/state-machine.js";

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

test("10I: VOICE_V4_STT_PROVIDER defaults to mock when unset", () => {
  withEnv({ VOICE_V4_STT_PROVIDER: undefined }, () => {
    const config = loadConfig();
    assert.equal(config.v4.sttProvider, "mock");
    assert.equal(resolveLiveSttProvider(config).provider, "mock");
  });
});

test("10I: resolveLiveSttProvider selects openai only with API key", () => {
  withEnv(
    { VOICE_V4_STT_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" },
    () => {
      const config = loadConfig();
      const resolved = resolveLiveSttProvider(config);
      assert.equal(resolved.provider, "openai");
      assert.equal(resolved.openaiActive, true);
    }
  );
});

test("10I: live canary blocks mock STT without explicit test allow flag", () => {
  withEnv(
    {
      ...liveCanaryEnv("qa-canary"),
      VOICE_V4_STT_PROVIDER: "mock",
      VOICE_V4_STT_ALLOW_MOCK_FOR_TESTS: undefined
    },
    () => {
      const config = loadConfig();
      const gate = validateLiveCanarySttProvider(config, { allowMockStt: false });
      assert.equal(gate.ok, false);
      assert.equal(gate.reason, "live_stt_mock_not_allowed");

      const ctx = makeCtx({ bridgeCallId: "qa-canary" });
      const selection = selectLiveCallHandler(config, ctx);
      assert.equal(selection.handler, "v3");
      assert.equal(selection.reason, "live_stt_mock_not_allowed");
    }
  );
});

test("10I: openai STT adapter uses injected fetch without network", async () => {
  const pcm = makePcmFrame(500, 160);
  const wav = wrapPcm8kAsWav(pcm);
  assert.ok(wav.length > pcm.length);

  const fetchImpl = async (_url, init) => {
    assert.ok(init?.body instanceof FormData);
    return {
      ok: true,
      async json() {
        return { text: "Ich interessiere mich für die digitale Rezeption" };
      }
    };
  };

  const result = await transcribeOpenAiPcmUtterance8k({
    pcmBuffer: pcm,
    apiKey: "sk-test",
    fetchImpl
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "openai");
  assert.match(result.text, /digitale Rezeption/i);

  const adapter = createSttAdapter({
    provider: "openai",
    enabled: true,
    endpointTranscribeFn: async (buffer) =>
      transcribeOpenAiPcmUtterance8k({ pcmBuffer: buffer, apiKey: "sk-test", fetchImpl })
  });
  const started = adapter.startSttStream({ streamId: "stt-openai-1", language: "de" });
  assert.equal(started.ok, true);
  adapter.appendAudio(started.streamId, pcm);
  const completed = await adapter.completeSttTurnAsync(started.streamId);
  assert.equal(completed.ok, true);
  assert.match(completed.event.text, /digitale Rezeption/i);
  assert.equal(completed.event.provider, "openai");
});

test("10I: endpoint STT transcript flows into dialogue on VAD endpoint", async () => {
  await withEnv(
    {
      ...liveCanaryEnv("qa-canary-stt"),
      VOICE_V4_STT_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test"
    },
    async () => {
      const config = loadConfig();
      const ctx = makeCtx({ bridgeCallId: "qa-canary-stt" });
      const fetchImpl = async () => ({
        ok: true,
        async json() {
          return { text: "Ich interessiere mich für die digitale Rezeption" };
        }
      });
      const runtime = createLiveCanaryRuntime(config, ctx, {
        endpointTranscribeFn: async (buffer) =>
          transcribeOpenAiPcmUtterance8k({
            pcmBuffer: buffer,
            apiKey: "sk-test",
            fetchImpl
          })
      });
      assert.equal(runtime.ok, true);
      assert.equal(runtime.sttAdapter.provider, "openai");

      runtime.sttAdapter.startSttStream({ streamId: "live-stt-test", language: "de" });
      runtime.utterance = {
        capturing: true,
        frames: [],
        streamId: "live-stt-test",
        startedAt: Date.now()
      };
      const frame = makePcmFrame(800, 160);
      runtime.utterance.frames.push(frame);
      runtime.sttAdapter.appendAudio("live-stt-test", frame);

      const sttResult = await runLiveSttOnEndpoint(config, ctx, runtime);
      assert.equal(sttResult.ok, true);
      assert.ok(sttResult.transcriptChars > 10);
      assert.equal(sttResult.dialogue?.ok, true);
    }
  );
});

test("10I: TTS playback pauses silence writer and resumes after completion", async () => {
  await withEnv(liveCanaryEnv("qa-canary-tts-silence"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-tts-silence" });
    const socket = createMockLiveSocket();
    ctx.v4LiveSocket = socket;

    startSilenceWriter(config, ctx, socket);
    assert.ok(ctx.silenceTimer);

    const runtime = createLiveCanaryRuntime(config, ctx, {
      ttsAdapter: createTtsAdapter({ provider: "mock", enabled: true })
    });
    runtime.liveSocket = socket;
    runtime.orchestrator = {
      lastAssistantText: "Guten Tag, wie kann ich Ihnen helfen?",
      lastPlan: { text: "Guten Tag, wie kann ich Ihnen helfen?" },
      stateMachine: { state: V4_STATES.THINKING },
      memory: {}
    };
    runtime.lastAssistantPlanCandidate = {
      ok: true,
      response_type: RESPONSE_TYPES.GREETING,
      turn_index: 0,
      endpoint_index: 0,
      atMs: Date.now()
    };

    const playback = await runLiveTtsAndPlayback(config, ctx, runtime, { ok: true });
    assert.equal(playback.ok, true);
    assert.ok(ctx.silenceTimer, "silence writer should restart after playback");
    stopSilenceWriter(ctx);
  });
});

test("10I: TTS playback resumes silence writer after barge-in cancellation", async () => {
  await withEnv(liveCanaryEnv("qa-canary-tts-cancel"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-tts-cancel" });
    const socket = createMockLiveSocket();
    ctx.v4LiveSocket = socket;
    startSilenceWriter(config, ctx, socket);

    const runtime = createLiveCanaryRuntime(config, ctx, {
      ttsAdapter: createTtsAdapter({ provider: "mock", enabled: true })
    });
    runtime.liveSocket = socket;
    runtime.orchestrator = {
      lastAssistantText: "Das ist eine längere Antwort für den Test.",
      lastPlan: { text: "Das ist eine längere Antwort für den Test." },
      stateMachine: { state: V4_STATES.THINKING },
      memory: {}
    };
    runtime.lastAssistantPlanCandidate = {
      ok: true,
      response_type: RESPONSE_TYPES.PRODUCT_INFO,
      turn_index: 1,
      endpoint_index: 1,
      atMs: Date.now()
    };

    const playbackPromise = runLiveTtsAndPlayback(config, ctx, runtime, { ok: true });
    for (let i = 0; i < 50 && !runtime.playbackInFlight; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(runtime.playbackInFlight, true);
    if (runtime.livePlaybackSession) {
      runtime.livePlaybackSession.cancelled = true;
      runtime.livePlaybackSession.cancelReason = "barge_in_test";
    }
    const playback = await playbackPromise;
    assert.equal(playback.cancelled, true);
    assert.ok(ctx.silenceTimer, "silence writer should restart after cancelled playback");
    stopSilenceWriter(ctx);
  });
});

test("10I: PCM chunk size is 20 ms at 8 kHz s16le", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(pcmChunkBytes(config.sampleRate, config.frameMs), 320);
  });
});

test("10I: finalizeAudioSocketCall persists onCallEnded once across duplicate finish", async () => {
  const config = loadConfig();
  const ctx = makeCtx();
  let endCalls = 0;

  await Promise.all([
    finalizeAudioSocketCall(config, ctx, "socket_close", {
      onCallEnded: async () => {
        endCalls += 1;
      },
      runPostCallProcessing: async () => {},
      finishLiveCanaryCall: async () => ({ ok: true })
    }),
    finalizeAudioSocketCall(config, ctx, "hangup", {
      onCallEnded: async () => {
        endCalls += 1;
      },
      runPostCallProcessing: async () => {},
      finishLiveCanaryCall: async () => ({ ok: true })
    })
  ]);

  assert.equal(endCalls, 1);
  assert.equal(ctx.callEndedPersisted, true);
});

test("10I: v4 finish failure still persists onCallEnded", async () => {
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

test("10I: describeRuntimeRoute uses unambiguous v3 default fields", () => {
  withEnv(
    {
      VOICE_RUNTIME_VERSION: undefined,
      VOICE_V4_REALTIME_ENABLED: undefined,
      VOICE_V4_CANARY_ENABLED: undefined
    },
    () => {
      const config = loadConfig();
      const route = describeRuntimeRoute(config);
      assert.equal(route.selected_runtime, "v3");
      assert.equal(route.selected_runtime_active, true);
      assert.equal(route.v4_requested, false);
      assert.equal(route.v4_runtime_active, false);
      assert.equal(route.reason, "default_v3");
      assert.equal(resolveRuntimeRoute(config).runtime, "v3");
    }
  );
});

test("10I: createLiveSttAdapter stays mock only when explicitly configured", () => {
  withEnv(
    {
      VOICE_V4_STT_PROVIDER: "mock",
      VOICE_V4_STT_ALLOW_MOCK_FOR_TESTS: "true"
    },
    () => {
      const config = loadConfig();
      const adapter = createLiveSttAdapter(config, { suppressMockWarning: true });
      assert.equal(adapter.provider, "mock");
    }
  );
});
