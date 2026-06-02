import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { generateTestTonePcm } from "../src/audio-media.js";
import {
  createLiveTtsAdapter,
  resolveLiveTtsProvider,
  prepareLiveAssistantSpeechText,
  runLiveTtsAndPlayback
} from "../src/v4/live-tts-playback-endpoint.js";
import {
  fetchOpenAiSpeechWav,
  synthesizeOpenAiSpeechPcm8k
} from "../src/v4/openai-tts-provider.js";
import { convertWavBufferToPcm8k } from "../src/v4/tts-pcm-convert.js";
import { createLiveCanaryRuntime } from "../src/v4/canary-runtime-loop.js";
import { createAudioSession } from "../src/v4/audio-session.js";
import { selectLiveCallHandler } from "../src/v4/live-audiosocket-handler.js";
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

function makeCtx(overrides = {}) {
  return {
    bridgeCallId: overrides.bridgeCallId ?? randomUUID(),
    callSessionId: overrides.callSessionId ?? randomUUID(),
    callHandler: overrides.callHandler ?? "v4_canary"
  };
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

function mockFetchReturningWav(wav = Buffer.from("RIFFmock")) {
  return async () => ({
    ok: true,
    async arrayBuffer() {
      return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
    }
  });
}

test("VOICE_V4_TTS_PROVIDER defaults to mock when unset", () => {
  withEnv({ VOICE_V4_TTS_PROVIDER: undefined }, () => {
    const config = loadConfig();
    assert.equal(config.v4.ttsProvider, "mock");
    assert.equal(resolveLiveTtsProvider(config).provider, "mock");
  });
});

test("resolveLiveTtsProvider selects openai only with API key", () => {
  withEnv(
    { VOICE_V4_TTS_PROVIDER: "openai", OPENAI_API_KEY: "sk-test-key" },
    () => {
      const config = loadConfig();
      const resolved = resolveLiveTtsProvider(config);
      assert.equal(resolved.provider, "openai");
      assert.equal(resolved.openaiActive, true);
    }
  );

  withEnv({ VOICE_V4_TTS_PROVIDER: "openai", OPENAI_API_KEY: undefined }, () => {
    const config = loadConfig();
    assert.equal(resolveLiveTtsProvider(config).provider, "mock");
  });
});

test("createLiveTtsAdapter uses mock when provider unset", () => {
  withEnv({ VOICE_V4_TTS_PROVIDER: undefined }, () => {
    const adapter = createLiveTtsAdapter(loadConfig());
    assert.equal(adapter.provider, "mock");
    const result = adapter.synthesizeSentenceChunk("Hallo");
    assert.equal(result.ok, true);
    assert.match(String(result.chunks[0].audio), /mock-tts/);
  });
});

test("OpenAI adapter uses injected async synthesize without network", async () => {
  const pcm = generateTestTonePcm(8000, 200);
  await withEnv({ VOICE_V4_TTS_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" }, async () => {
    const config = loadConfig();
    const wired = createLiveTtsAdapter(config, {
      synthesizeImplAsync: async () => pcm
    });
    assert.equal(wired.provider, "openai");
    const result = await wired.synthesizeSentenceChunkAsync("Guten Tag");
    assert.equal(result.ok, true);
    assert.equal(result.chunks[0].audio.length, pcm.length);
  });
});

test("fetchOpenAiSpeechWav uses injected fetch mock", async () => {
  const wav = Buffer.from("RIFF-test-wav");
  const result = await fetchOpenAiSpeechWav({
    apiKey: "sk-test",
    text: "Hallo",
    fetchImpl: mockFetchReturningWav(wav)
  });
  assert.equal(result.ok, true);
  assert.equal(result.wav.toString(), wav.toString());
});

test("conversion failure fails closed", async () => {
  const result = await convertWavBufferToPcm8k(Buffer.from("bad"), async () => {
    throw new Error("ffmpeg missing");
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ffmpeg_convert_failed");
});

test("synthesizeOpenAiSpeechPcm8k passes PCM when fetch and ffmpeg succeed", async () => {
  const pcm = generateTestTonePcm(8000, 160);
  const execFileImpl = async (_cmd, args) => {
    const outPath = args[args.length - 1];
    await writeFile(outPath, pcm);
  };
  const result = await synthesizeOpenAiSpeechPcm8k({
    config: loadConfig(),
    text: "Test",
    apiKey: "sk-test",
    fetchImpl: mockFetchReturningWav(Buffer.from("RIFF-wav-stub")),
    execFileImpl
  });
  assert.equal(result.ok, true);
  assert.equal(result.pcm.length, pcm.length);
});

test("phone-like response uses fallback text before provider synthesis", async () => {
  let synthCalls = 0;
  const config = loadConfig();
  const ctx = makeCtx();
  const runtime = {
    lastAssistantPlanCandidate: { ok: true, turn_index: 1, endpoint_index: 1, atMs: Date.now() },
    qualityEventsBuffer: [],
    audioSession: createAudioSession({
      bridgeCallId: ctx.bridgeCallId,
      callSessionId: ctx.callSessionId
    }),
    orchestrator: { lastAssistantText: "Rueckruf +4917012345678" },
    liveTtsHooks: { assistantText: "Rueckruf +4917012345678" },
    ttsAdapter: createTtsAdapter({
      provider: "openai",
      enabled: true,
      synthesizeImplAsync: async () => {
        synthCalls += 1;
        return generateTestTonePcm(8000, 80);
      }
    })
  };
  ctx.v4LiveSocket = createMockLiveSocket();

  const prepared = prepareLiveAssistantSpeechText(config, runtime.liveTtsHooks.assistantText);
  assert.equal(prepared.usedFallback, true);
  assert.doesNotMatch(prepared.text, /\+?\d{8,}/);

  const playback = await runLiveTtsAndPlayback(config, ctx, runtime, { ok: true });
  assert.equal(playback.ok, true);
  assert.equal(runtime.lastAssistantPlaybackCandidate?.used_fallback, true);
  assert.equal(synthCalls, 1);
  assert.doesNotMatch(String(runtime.lastAssistantPlaybackCandidate?.response_chars), /\+?\d{8,}/);
});

test("v3 default route unchanged", () => {
  withEnv(
    {
      VOICE_RUNTIME_VERSION: undefined,
      VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: undefined,
      VOICE_V4_LIVE_CANARY_ALLOWLIST: undefined
    },
    () => {
      const config = loadConfig();
      const selected = selectLiveCallHandler(config, makeCtx());
      assert.equal(selected.handler, "v3");
    }
  );
});

test("live canary OpenAI TTS feeds PCM into playback with mock socket", async () => {
  return withEnv(
    {
      VOICE_RUNTIME_VERSION: "v4",
      VOICE_V4_REALTIME_ENABLED: "true",
      VOICE_V4_CANARY_ENABLED: "true",
      VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "true",
      VOICE_V4_LIVE_CANARY_ALLOWLIST: "qa-openai-tts",
      VOICE_V4_STT_ALLOW_MOCK_FOR_TESTS: "true",
      VOICE_V4_TTS_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test"
    },
    async () => {
      const config = loadConfig();
      const ctx = makeCtx({ bridgeCallId: "qa-openai-tts-001", callHandler: "v4_canary" });
      const pcm = generateTestTonePcm(8000, 240);
      const runtime = createLiveCanaryRuntime(config, ctx, {
        ttsAdapter: createLiveTtsAdapter(config, {
          synthesizeImplAsync: async () => pcm
        })
      });
      assert.equal(runtime.phase, "phase10g_live_quality_flush");
      assert.equal(runtime.ttsAdapter.provider, "openai");

      ctx.v4LiveRuntime = runtime;
      const socket = createMockLiveSocket();
      ctx.v4LiveSocket = socket;
      runtime.liveSocket = socket;
      runtime.lastAssistantPlanCandidate = {
        ok: true,
        response_type: "product_question_answer",
        turn_index: 1,
        endpoint_index: 1,
        atMs: Date.now()
      };
      runtime.orchestrator = { lastAssistantText: "Smart Website hilft bei Sichtbarkeit." };

      const result = await runLiveTtsAndPlayback(config, ctx, runtime, { ok: true });
      assert.equal(result.ok, true);
      assert.equal(runtime.lastAssistantPlaybackCandidate?.tts_provider, "openai");
      assert.ok(socket.writes.length > 0);
      const ttsEvents = runtime.qualityEventsBuffer.filter((e) =>
        ["tts_started", "tts_first_chunk", "tts_completed", "playback_started", "playback_completed"].includes(
          e.eventType
        )
      );
      assert.ok(ttsEvents.length >= 4);
    }
  );
});
