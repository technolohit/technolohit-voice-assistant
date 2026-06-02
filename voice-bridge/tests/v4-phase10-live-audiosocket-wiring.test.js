import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { assignBridgeCallIdentity } from "../src/persist.js";
import {
  canActivateLiveV4Canary,
  selectLiveCallHandler,
  matchLiveCanaryAllowlist,
  shouldCaptureAssistantTurnAudio,
  handleLiveCanaryInboundFrame,
  processLiveCanaryInboundFrame,
  finishLiveCanaryCall
} from "../src/v4/live-audiosocket-handler.js";
import { createLiveCanaryRuntime } from "../src/v4/canary-runtime-loop.js";
import { createSttAdapter } from "../src/v4/stt-adapter.js";
import { validateQualityEventInput } from "../src/v4/quality-events.js";
import { RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { createTtsAdapter } from "../src/v4/tts-adapter.js";
import {
  runLiveTtsAndPlayback,
  prepareLiveAssistantSpeechText,
  containsUnsafeTtsText
} from "../src/v4/live-tts-playback-endpoint.js";
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
    VOICE_V4_LIVE_CANARY_ALLOWLIST: allowlist
  };
}

function makeCtx(overrides = {}) {
  const ctx = {
    bridgeCallId: overrides.bridgeCallId ?? randomUUID(),
    audiosocketUuid: overrides.audiosocketUuid ?? randomUUID(),
    callSessionId: overrides.callSessionId ?? randomUUID(),
    callHandler: overrides.callHandler ?? "v3",
    inboundAudioFrames: 0
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

async function feedLiveCanaryFrames(config, ctx, runtime, amplitude, count) {
  for (let i = 0; i < count; i += 1) {
    await processLiveCanaryInboundFrame(config, ctx, runtime, makePcmFrame(amplitude));
  }
}

function createMockLiveSocket({ writable = true } = {}) {
  const writes = [];
  return {
    writable,
    write(data) {
      if (writable) writes.push(Buffer.from(data));
      return true;
    },
    once() {},
    writes
  };
}

function attachLiveSocket(ctx, runtime, socket = createMockLiveSocket()) {
  ctx.v4LiveSocket = socket;
  runtime.liveSocket = socket;
  return socket;
}

async function feedSpeechUtteranceWithEndpoint(config, ctx, runtime, socket) {
  attachLiveSocket(ctx, runtime, socket ?? createMockLiveSocket());
  await feedLiveCanaryFrames(config, ctx, runtime, 800, 15);
  await feedLiveCanaryFrames(config, ctx, runtime, 0, 30);
}

test("T1: selectLiveCallHandler defaults to v3 with factory config", () => {
  withEnv(
    {
      VOICE_RUNTIME_VERSION: undefined,
      VOICE_V4_REALTIME_ENABLED: undefined,
      VOICE_V4_CANARY_ENABLED: undefined,
      VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: undefined,
      VOICE_V4_LIVE_CANARY_ALLOWLIST: undefined
    },
    () => {
      const config = loadConfig();
      const ctx = makeCtx();
      const selected = selectLiveCallHandler(config, ctx);
      assert.equal(selected.handler, "v3");
      assert.equal(selected.runtime, null);
      assert.notEqual(selected.reason, "v4_live_canary_selected");
    }
  );
});

test("T2: v4 runtime without canary/realtime does not activate live path", () => {
  withEnv(
    {
      VOICE_RUNTIME_VERSION: "v4",
      VOICE_V4_REALTIME_ENABLED: "false",
      VOICE_V4_CANARY_ENABLED: "false",
      VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "true",
      VOICE_V4_LIVE_CANARY_ALLOWLIST: "qa-canary"
    },
    () => {
      const config = loadConfig();
      const ctx = makeCtx({ bridgeCallId: "qa-canary-test-001" });
      const gate = canActivateLiveV4Canary(config, ctx);
      assert.equal(gate.ok, false);
      assert.equal(selectLiveCallHandler(config, ctx).handler, "v3");
    }
  );
});

test("T3: v4 + realtime + canary but liveAudioSocketEnabled=false → v3", () => {
  withEnv(
    {
      ...liveCanaryEnv("qa-canary"),
      VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "false"
    },
    () => {
      const config = loadConfig();
      const ctx = makeCtx({ bridgeCallId: "qa-canary-live-001" });
      const gate = canActivateLiveV4Canary(config, ctx);
      assert.equal(gate.ok, false);
      assert.equal(gate.reason, "live_audiosocket_disabled");
      assert.equal(selectLiveCallHandler(config, ctx).handler, "v3");
    }
  );
});

test("T4: all flags true but empty allowlist → v3", () => {
  withEnv(
    {
      ...liveCanaryEnv(""),
      VOICE_V4_LIVE_CANARY_ALLOWLIST: ""
    },
    () => {
      const config = loadConfig();
      assert.deepEqual(config.v4.liveCanaryAllowlist, []);
      const ctx = makeCtx({ bridgeCallId: "qa-canary-any" });
      const gate = canActivateLiveV4Canary(config, ctx);
      assert.equal(gate.ok, false);
      assert.equal(gate.reason, "live_canary_allowlist_empty");
      assert.equal(selectLiveCallHandler(config, ctx).handler, "v3");
    }
  );
});

test("T5: all gates pass + allowlist match → v4_canary", () => {
  withEnv(liveCanaryEnv("qa-canary"), () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-bridge-001" });
    const selected = selectLiveCallHandler(config, ctx);
    assert.equal(selected.handler, "v4_canary");
    assert.equal(selected.reason, "v4_live_canary_selected");
    assert.equal(selected.runtime?.ok, true);
    assert.equal(selected.runtime?.phase, "phase10f_live_barge_in");
  });
});

test("T6: createLiveCanaryRuntime init failure → fallback v3", () => {
  withEnv(
    {
      ...liveCanaryEnv("qa-canary"),
      VOICE_AGENT_CONFIG_PATH: "/nonexistent/phase10a-missing-agent.json"
    },
    () => {
      const config = loadConfig();
      const ctx = makeCtx({ bridgeCallId: "qa-canary-bridge-002" });
      const runtime = createLiveCanaryRuntime(config, ctx);
      assert.equal(runtime.ok, false);
      assert.equal(runtime.reason, "agent_config_unavailable");
      const selected = selectLiveCallHandler(config, ctx);
      assert.equal(selected.handler, "v3");
      assert.equal(selected.runtime, null);
    }
  );
});

test("T13: v3 path allows captureAssistantTurnAudio", () => {
  const ctx = makeCtx({ callHandler: "v3" });
  assert.equal(shouldCaptureAssistantTurnAudio(ctx), true);
});

test("T14: v4_canary path skips captureAssistantTurnAudio", () => {
  const ctx = makeCtx({ callHandler: "v4_canary" });
  assert.equal(shouldCaptureAssistantTurnAudio(ctx), false);
});

test("T16: UUID-style ctx with default config selects v3", () => {
  withEnv(
    {
      VOICE_RUNTIME_VERSION: undefined,
      VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: undefined,
      VOICE_V4_LIVE_CANARY_ALLOWLIST: undefined
    },
    () => {
      const config = loadConfig();
      const ctx = {
        remoteAddress: "127.0.0.1:12345",
        audiosocketUuid: null,
        callSessionId: "session-mock-001",
        callHandler: "v3"
      };
      assignBridgeCallIdentity(ctx);
      ctx.audiosocketUuid = randomUUID();
      ctx.startedAt = Date.now();

      const selected = selectLiveCallHandler(config, ctx);
      assert.equal(selected.handler, "v3");
      assert.equal(ctx.callHandler, "v3");
    }
  );
});

test("allowlist match supports prefix on bridge_call_id", () => {
  const ctx = makeCtx({ bridgeCallId: "qa-canary-prefix-123" });
  assert.equal(matchLiveCanaryAllowlist(ctx, ["qa-canary"]), true);
  assert.equal(matchLiveCanaryAllowlist(ctx, ["nomatch"]), false);
});

test("allowlist empty never matches", () => {
  const ctx = makeCtx({ bridgeCallId: "qa-canary-xyz" });
  assert.equal(matchLiveCanaryAllowlist(ctx, []), false);
});

test("loadConfig defaults live AudioSocket flags off", () => {
  withEnv(
    {
      VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: undefined,
      VOICE_V4_LIVE_CANARY_ALLOWLIST: undefined
    },
    () => {
      const config = loadConfig();
      assert.equal(config.v4.liveAudioSocketEnabled, false);
      assert.deepEqual(config.v4.liveCanaryAllowlist, []);
    }
  );
});

test("loadConfig accepts comma, semicolon, and whitespace separated live canary allowlist", () => {
  withEnv(
    {
      VOICE_V4_LIVE_CANARY_ALLOWLIST: "qa-one; qa-two qa-three,qa-four"
    },
    () => {
      const config = loadConfig();
      assert.deepEqual(config.v4.liveCanaryAllowlist, ["qa-one", "qa-two", "qa-three", "qa-four"]);
    }
  );
});

test("10B: v3 path does not run v4 VAD processing", () => {
  const config = loadConfig();
  const ctx = makeCtx({ callHandler: "v3" });
  handleLiveCanaryInboundFrame(config, ctx, null, makePcmFrame(900));
  assert.equal(ctx.v4LiveRuntime, undefined);
});

test("10B: v4_canary inbound frame increments audio session counters", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-vad-001", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    assert.equal(runtime.ok, true);
    ctx.v4LiveRuntime = runtime;
    await processLiveCanaryInboundFrame(config, ctx, runtime, makePcmFrame(0, 160));
    assert.equal(runtime.inboundFrameCount, 1);
    assert.equal(runtime.audioSession.inboundFrames, 1);
    assert.equal(runtime.inboundBytes, 320);
  });
});

test("10B: silence frames do not trigger speech start", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-vad-silence", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    await feedLiveCanaryFrames(config, ctx, runtime, 0, 20);
    assert.equal(runtime.speechStartCount, 0);
    assert.equal(runtime.endpointCount, 0);
    assert.equal(runtime.sttCompletedCount, 0);
    assert.equal(runtime.vadState.speechActive, false);
  });
});

test("10B: consecutive speech frames trigger vad speech start", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-vad-speech", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    await feedLiveCanaryFrames(config, ctx, runtime, 800, 3);
    assert.equal(runtime.speechStartCount, 1);
    assert.equal(runtime.vadState.speechActive, true);
    assert.ok(runtime.audioSession.speechStartedAt != null);
    assert.equal(runtime.qualityEventsBuffer.length, 1);
    assert.equal(runtime.qualityEventsBuffer[0].eventType, "vad_speech_start");
  });
});

test("10B: speech followed by silence triggers endpoint detected", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-vad-endpoint", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    assert.equal(runtime.speechStartCount, 1);
    assert.equal(runtime.endpointCount, 1);
    assert.equal(runtime.vadState.speechActive, false);
    assert.ok(runtime.audioSession.endpointDetectedAt != null);
    const endpointEvents = runtime.qualityEventsBuffer.filter(
      (event) => event.eventType === "vad_endpoint_detected"
    );
    assert.equal(endpointEvents.length, 1);
  });
});

test("10B: VAD quality events contain no phone-like payload data", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({
      bridgeCallId: "qa-canary-vad-privacy",
      callHandler: "v4_canary",
      callSessionId: "session-no-phone-001"
    });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    for (const event of runtime.qualityEventsBuffer) {
      const validation = validateQualityEventInput(event);
      assert.equal(validation.ok, true, validation.errors?.join("; "));
      assert.doesNotMatch(JSON.stringify(event.payload), /\+?\d{8,}/);
    }
  });
});

test("10C: silence does not invoke STT completion", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-stt-silence", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    await feedLiveCanaryFrames(config, ctx, runtime, 0, 40);
    assert.equal(runtime.sttCompletedCount, 0);
    assert.equal(runtime.lastCallerTurnCandidate, null);
    const sttEvents = runtime.qualityEventsBuffer.filter((e) =>
      ["stt_started", "stt_completed", "stt_final"].includes(e.eventType)
    );
    assert.equal(sttEvents.length, 0);
  });
});

test("10C: speech + endpoint invokes STT adapter once", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-stt-once", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    assert.equal(runtime.sttCompletedCount, 1);
    assert.equal(runtime.lastCallerTurnCandidate?.ok, true);
    const started = runtime.qualityEventsBuffer.filter((e) => e.eventType === "stt_started");
    const completed = runtime.qualityEventsBuffer.filter(
      (e) => e.eventType === "stt_completed" && e.eventStage === "stt"
    );
    assert.equal(started.length, 1);
    assert.equal(completed.length, 1);
  });
});

test("10C: default live STT adapter stays mock-safe even when env provider is openai", async () => {
  return withEnv({ ...liveCanaryEnv("qa-canary"), VOICE_V4_STT_PROVIDER: "openai" }, async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-stt-mock-safe", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    assert.equal(runtime.sttAdapter.provider, "mock");
    assert.equal(runtime.sttCompletedCount, 1);
    assert.match(runtime.lastCallerTurnCandidate?.transcript, /mock-final/);
  });
});

test("10C: STT success stores redacted caller turn candidate", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-stt-store", callHandler: "v4_canary" });
    const adapter = createSttAdapter({ provider: "mock", enabled: true });
    const baseComplete = adapter.completeSttTurn.bind(adapter);
    adapter.completeSttTurn = (streamId, options = {}) =>
      baseComplete(streamId, {
        ...options,
        finalText: "Ich interessiere mich fuer Smart Website"
      });
    const runtime = createLiveCanaryRuntime(config, ctx, { sttAdapter: adapter });
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    assert.match(runtime.lastCallerTurnCandidate.transcript, /Smart Website/);
    assert.ok(runtime.lastCallerTurnCandidate.transcriptChars > 0);
  });
});

test("10C: STT failure buffers error and does not throw", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-stt-fail", callHandler: "v4_canary" });
    const adapter = createSttAdapter({ provider: "mock", enabled: true });
    adapter.completeSttTurn = () => ({
      ok: false,
      error: { code: "stt_timeout", message: "timeout", recoverable: true }
    });
    const runtime = createLiveCanaryRuntime(config, ctx, { sttAdapter: adapter });
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    assert.equal(runtime.sttCompletedCount, 0);
    assert.equal(runtime.lastCallerTurnCandidate, null);
    const errors = runtime.qualityEventsBuffer.filter((e) => e.eventType === "runtime_error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].payload?.event_subtype, "stt_error");
  });
});

test("10C: phone-like transcript is redacted in candidate and quality events", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-stt-phone", callHandler: "v4_canary" });
    const adapter = createSttAdapter({ provider: "mock", enabled: true });
    const baseComplete = adapter.completeSttTurn.bind(adapter);
    adapter.completeSttTurn = (streamId, options = {}) =>
      baseComplete(streamId, {
        ...options,
        finalText: "Rueckruf unter +4917012345678 bitte"
      });
    const runtime = createLiveCanaryRuntime(config, ctx, { sttAdapter: adapter });
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    assert.doesNotMatch(runtime.lastCallerTurnCandidate.transcript, /\+?\d{8,}/);
    assert.match(runtime.lastCallerTurnCandidate.transcript, /\[phone_redacted\]/);
    for (const event of runtime.qualityEventsBuffer) {
      if (event.eventType === "stt_final") {
        assert.doesNotMatch(JSON.stringify(event.payload), /\+?\d{8,}/);
      }
    }
  });
});

test("10C: v3 path does not run live STT", async () => {
  const config = loadConfig();
  const ctx = makeCtx({ callHandler: "v3" });
  handleLiveCanaryInboundFrame(config, ctx, null, makePcmFrame(800));
  assert.equal(ctx.v4LiveRuntime, undefined);
  assert.equal(ctx.callHandler, "v3");
});

test("v4 live inbound frame handler increments lifecycle counters", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-frame-count", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    await processLiveCanaryInboundFrame(config, ctx, runtime, makePcmFrame(0));
    assert.equal(runtime.inboundFrameCount, 1);
    assert.equal(runtime.inboundBytes, 320);
    assert.equal(runtime.audioSession.inboundFrames, 1);
  });
});

test("10D: STT candidate triggers dialogue orchestrator exactly once per endpoint", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-dialogue-once", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    assert.equal(runtime.dialogueCompletedCount, 1);
    assert.equal(runtime.lastCallerTurnCandidate?.dialogueProcessed, true);
    const turnStarted = runtime.qualityEventsBuffer.filter((e) => e.eventType === "turn_started");
    assert.equal(turnStarted.length, 1);
  });
});

test("10E: dialogue plan triggers TTS and playback once", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-tts-once", callHandler: "v4_canary" });
    const adapter = createSttAdapter({ provider: "mock", enabled: true });
    const baseComplete = adapter.completeSttTurn.bind(adapter);
    adapter.completeSttTurn = (streamId, options = {}) =>
      baseComplete(streamId, {
        ...options,
        finalText: "Erzaehlen Sie mir bitte ueber Smart Website"
      });
    const runtime = createLiveCanaryRuntime(config, ctx, { sttAdapter: adapter });
    ctx.v4LiveRuntime = runtime;
    const socket = createMockLiveSocket();
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime, socket);
    assert.equal(runtime.ttsCompletedCount, 1);
    assert.equal(runtime.playbackCompletedCount, 1);
    assert.equal(runtime.lastAssistantPlaybackCandidate?.ok, true);
    const ttsStarted = runtime.qualityEventsBuffer.filter((e) => e.eventType === "tts_started");
    const playbackStarted = runtime.qualityEventsBuffer.filter(
      (e) => e.eventType === "playback_started"
    );
    assert.equal(ttsStarted.length, 1);
    assert.equal(playbackStarted.length, 1);
    assert.ok(socket.writes.length > 0);
  });
});

test("10D: memory selected product updates from caller transcript", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-dialogue-product", callHandler: "v4_canary" });
    const adapter = createSttAdapter({ provider: "mock", enabled: true });
    const baseComplete = adapter.completeSttTurn.bind(adapter);
    adapter.completeSttTurn = (streamId, options = {}) =>
      baseComplete(streamId, {
        ...options,
        finalText: "Ich interessiere mich fuer Smart Website"
      });
    const runtime = createLiveCanaryRuntime(config, ctx, { sttAdapter: adapter });
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    assert.equal(runtime.runtimeContext.memory.selected_product_id, "smart_website");
  });
});

test("10D: product question creates product Q&A response plan", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-dialogue-pqa", callHandler: "v4_canary" });
    const adapter = createSttAdapter({ provider: "mock", enabled: true });
    const baseComplete = adapter.completeSttTurn.bind(adapter);
    adapter.completeSttTurn = (streamId, options = {}) =>
      baseComplete(streamId, {
        ...options,
        finalText: "Was kostet Smart Website?"
      });
    const runtime = createLiveCanaryRuntime(config, ctx, { sttAdapter: adapter });
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    assert.equal(
      runtime.lastAssistantPlanCandidate?.response_type,
      RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER
    );
  });
});

test("10D: phone contact intent does not create callback-ready lead without validator", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-dialogue-phone-intent", callHandler: "v4_canary" });
    const adapter = createSttAdapter({ provider: "mock", enabled: true });
    const baseComplete = adapter.completeSttTurn.bind(adapter);
    adapter.completeSttTurn = (streamId, options = {}) =>
      baseComplete(streamId, {
        ...options,
        finalText: "Bitte Rueckruf unter +4917012345678"
      });
    const runtime = createLiveCanaryRuntime(config, ctx, { sttAdapter: adapter });
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    assert.equal(runtime.runtimeContext.memory.lead_ready, false);
    assert.notEqual(runtime.lastAssistantPlanCandidate?.response_type, RESPONSE_TYPES.LEAD_READY_ACK);
  });
});

test("10D: phone-like transcript is redacted in memory and quality events", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({
      bridgeCallId: "qa-canary-dialogue-phone-redact",
      callHandler: "v4_canary",
      callSessionId: "sess-nophone-01"
    });
    const adapter = createSttAdapter({ provider: "mock", enabled: true });
    const baseComplete = adapter.completeSttTurn.bind(adapter);
    adapter.completeSttTurn = (streamId, options = {}) =>
      baseComplete(streamId, {
        ...options,
        finalText: "Meine Nummer ist +491709998877 fuer Rueckruf"
      });
    const runtime = createLiveCanaryRuntime(config, ctx, { sttAdapter: adapter });
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    const memoryJson = JSON.stringify({
      last_user_utterance: runtime.runtimeContext.memory.last_user_utterance,
      last_assistant_text: runtime.runtimeContext.memory.last_assistant_text
    });
    assert.doesNotMatch(memoryJson, /\+?\d{8,}/);
    assert.match(memoryJson, /\[phone_redacted\]/);
    for (const event of runtime.qualityEventsBuffer) {
      assert.doesNotMatch(JSON.stringify(event.payload), /\+?\d{8,}/);
    }
  });
});

test("10D: dialogue failure buffers runtime_error and call continues", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-dialogue-fail", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    runtime.liveDialogueHooks = {
      decideNextAction: async () => {
        throw new Error("simulated_dialogue_failure");
      }
    };
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    assert.equal(runtime.sttCompletedCount, 1);
    assert.equal(runtime.lastAssistantPlanCandidate?.ok, false);
    const errors = runtime.qualityEventsBuffer.filter((e) => e.eventType === "runtime_error");
    assert.ok(errors.some((e) => e.payload?.event_subtype === "dialogue_error"));
    await feedLiveCanaryFrames(config, ctx, runtime, 800, 5);
    assert.ok(runtime.inboundFrameCount > 45);
  });
});

test("10D: v3 path does not run v4 dialogue", async () => {
  const config = loadConfig();
  const ctx = makeCtx({ callHandler: "v3" });
  handleLiveCanaryInboundFrame(config, ctx, null, makePcmFrame(800));
  assert.equal(ctx.v4LiveRuntime, undefined);
  assert.equal(ctx.lastAssistantPlanCandidate, undefined);
});

test("10E: response plan and playback candidate stored, state returns LISTENING", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-tts-listening", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    assert.equal(runtime.lastAssistantPlanCandidate?.ok, true);
    assert.equal(runtime.lastAssistantPlaybackCandidate?.ok, true);
    assert.equal(runtime.runtimeContext.stateMachine.state, V4_STATES.LISTENING);
  });
});

test("10E: no TTS or playback when STT fails", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-tts-no-stt", callHandler: "v4_canary" });
    const adapter = createSttAdapter({ provider: "mock", enabled: true });
    adapter.completeSttTurn = () => ({
      ok: false,
      error: { code: "stt_timeout", message: "timeout", recoverable: true }
    });
    const runtime = createLiveCanaryRuntime(config, ctx, { sttAdapter: adapter });
    ctx.v4LiveRuntime = runtime;
    attachLiveSocket(ctx, runtime);
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    assert.equal(runtime.ttsCompletedCount, 0);
    assert.equal(runtime.playbackCompletedCount, 0);
    assert.equal(runtime.lastAssistantPlaybackCandidate, null);
  });
});

test("10E: no duplicate TTS or playback for same response plan", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-tts-dup", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    attachLiveSocket(ctx, runtime);
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    const firstTts = runtime.ttsCompletedCount;
    const duplicate = await runLiveTtsAndPlayback(config, ctx, runtime, { ok: true });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.reason, "duplicate_playback");
    assert.equal(runtime.ttsCompletedCount, firstTts);
  });
});

test("10E: phone-like assistant text uses safe fallback and does not synthesize raw phone", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const unsafe = "Bitte anrufen unter +4917012345678";
    assert.equal(containsUnsafeTtsText(unsafe).unsafe, true);
    const prepared = prepareLiveAssistantSpeechText(config, unsafe);
    assert.equal(prepared.usedFallback, true);
    assert.doesNotMatch(prepared.text, /\+?\d{8,}/);

    const ctx = makeCtx({ bridgeCallId: "qa-canary-tts-phone-safe", callHandler: "v4_canary" });
    const ttsAdapter = createTtsAdapter({ provider: "mock", enabled: true });
    let synthesizedText = null;
    const baseSynth = ttsAdapter.synthesizeSentenceChunk.bind(ttsAdapter);
    ttsAdapter.synthesizeSentenceChunk = (text, options = {}) => {
      synthesizedText = text;
      return baseSynth(text, options);
    };
    const runtime = createLiveCanaryRuntime(config, ctx, { ttsAdapter });
    runtime.liveTtsHooks = { assistantText: unsafe };
    ctx.v4LiveRuntime = runtime;
    attachLiveSocket(ctx, runtime);
    runtime.lastAssistantPlanCandidate = {
      ok: true,
      response_type: "fallback_clarification",
      turn_index: 1,
      endpoint_index: 1,
      atMs: Date.now()
    };
    const result = await runLiveTtsAndPlayback(config, ctx, runtime, { ok: true });
    assert.equal(result.ok, true);
    assert.doesNotMatch(String(synthesizedText ?? ""), /\+?\d{8,}/);
    assert.match(String(synthesizedText ?? ""), /verstanden/i);
    assert.equal(runtime.lastAssistantPlaybackCandidate?.used_fallback, true);
  });
});

test("10E: TTS failure buffers tts_error and call continues", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-tts-fail", callHandler: "v4_canary" });
    const ttsAdapter = createTtsAdapter({ provider: "mock", enabled: true });
    ttsAdapter.synthesizeSentenceChunk = () => ({
      ok: false,
      code: "tts_timeout",
      message: "timeout"
    });
    const runtime = createLiveCanaryRuntime(config, ctx, { ttsAdapter });
    ctx.v4LiveRuntime = runtime;
    attachLiveSocket(ctx, runtime);
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    assert.equal(runtime.ttsCompletedCount, 0);
    const errors = runtime.qualityEventsBuffer.filter((e) => e.eventType === "runtime_error");
    assert.ok(errors.some((e) => e.payload?.event_subtype === "tts_error"));
    await feedLiveCanaryFrames(config, ctx, runtime, 0, 5);
    assert.ok(runtime.inboundFrameCount > 45);
  });
});

test("10E: playback failure buffers playback_error and call continues", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-playback-fail", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    const socket = createMockLiveSocket({ writable: false });
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime, socket);
    assert.equal(runtime.ttsCompletedCount, 1);
    assert.equal(runtime.lastAssistantPlaybackCandidate?.ok, false);
    const errors = runtime.qualityEventsBuffer.filter((e) => e.eventType === "runtime_error");
    assert.ok(errors.some((e) => e.payload?.event_subtype === "playback_error"));
  });
});

test("10E: v3 path does not run v4 TTS or playback", async () => {
  const config = loadConfig();
  const ctx = makeCtx({ callHandler: "v3" });
  handleLiveCanaryInboundFrame(config, ctx, null, makePcmFrame(800));
  assert.equal(ctx.v4LiveRuntime, undefined);
  assert.equal(ctx.v4LiveSocket, undefined);
});

test("10E: TTS and playback quality events contain no raw phone", async () => {
  return withEnv(liveCanaryEnv("qa-canary"), async () => {
    const config = loadConfig();
    const ctx = makeCtx({
      bridgeCallId: "qa-canary-tts-privacy",
      callHandler: "v4_canary",
      callSessionId: "sess-nophone-02"
    });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    attachLiveSocket(ctx, runtime);
    await feedSpeechUtteranceWithEndpoint(config, ctx, runtime);
    for (const event of runtime.qualityEventsBuffer) {
      if (
        ["tts_started", "tts_completed", "playback_started", "playback_completed"].includes(
          event.eventType
        )
      ) {
        const validation = validateQualityEventInput(event);
        assert.equal(validation.ok, true, validation.errors?.join("; "));
        assert.doesNotMatch(JSON.stringify(event.payload), /\+?\d{8,}/);
      }
    }
  });
});

test("finishLiveCanaryCall clears runtime on v4 handler", () => {
  withEnv(liveCanaryEnv("qa-canary"), () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-finish", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    runtime.inboundFrameCount = 3;
    runtime.startedAt = Date.now() - 100;
    ctx.v4LiveRuntime = runtime;
    const result = finishLiveCanaryCall(config, ctx, "socket_close");
    assert.equal(result.ok, true);
    assert.equal(result.inboundFrameCount, 3);
    assert.equal(ctx.v4LiveRuntime, null);
  });
});
