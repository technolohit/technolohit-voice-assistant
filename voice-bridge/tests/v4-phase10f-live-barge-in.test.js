import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createSttAdapter } from "../src/v4/stt-adapter.js";
import { createTtsAdapter, createTtsChunkEvent } from "../src/v4/tts-adapter.js";
import { validateQualityEventInput } from "../src/v4/quality-events.js";
import { RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { V4_STATES } from "../src/v4/state-machine.js";
import { isPlaybackCancelSpikeEnabled } from "../src/playback-session.js";
import { isInterruptionContextSpikeEnabled } from "../src/interruption-recovery.js";
import {
  selectLiveCallHandler,
  processLiveCanaryInboundFrame
} from "../src/v4/live-audiosocket-handler.js";
import { createLiveCanaryRuntime } from "../src/v4/canary-runtime-loop.js";
import {
  runLiveTtsAndPlayback,
  prepareLiveAssistantSpeechText
} from "../src/v4/live-tts-playback-endpoint.js";
import {
  isLiveV4BargeInEnabled,
  observeLiveCanaryBargeIn
} from "../src/v4/live-barge-in-endpoint.js";
import {
  ensureLiveDialogueOrchestrator,
  runLiveDialogueOnCallerTranscript
} from "../src/v4/live-dialogue-endpoint.js";
import { captureInterruptedAssistantState } from "../src/v4/interruption-context.js";
import { setSelectedProduct } from "../src/v4/call-session-memory.js";

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

function liveCanaryEnv(allowlist = "qa-canary", extra = {}) {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "true",
    VOICE_V4_LIVE_CANARY_ALLOWLIST: allowlist,
    VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED: "false",
    VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED: "false",
    ...extra
  };
}

function makeCtx(overrides = {}) {
  const ctx = {
    bridgeCallId: overrides.bridgeCallId ?? randomUUID(),
    audiosocketUuid: overrides.audiosocketUuid ?? randomUUID(),
    callSessionId: overrides.callSessionId ?? randomUUID(),
    callHandler: overrides.callHandler ?? "v4_canary",
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

function createLargePcmTtsAdapter(frameCount = 80) {
  const bigPcm = Buffer.alloc(320 * frameCount);
  const adapter = createTtsAdapter({ provider: "mock", enabled: true });
  adapter.synthesizeSentenceChunk = (text, options = {}) => ({
    ok: true,
    synthesisId: "test-large-pcm",
    fromCache: false,
    chunks: [
      createTtsChunkEvent({
        synthesisId: "test-large-pcm",
        chunkIndex: 0,
        audio: bigPcm,
        sampleRate: 8000,
        isFirst: true,
        isFinal: true,
        provider: "mock"
      })
    ],
    firstChunkMs: 1
  });
  return adapter;
}

async function waitForCondition(fn, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitForCondition_timeout");
}

async function feedSpeechDuringPlayback(config, ctx, runtime, speechFrames = 5) {
  for (let i = 0; i < speechFrames; i += 1) {
    await processLiveCanaryInboundFrame(config, ctx, runtime, makePcmFrame(900));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function setupPlaybackInFlight(config, ctx, runtime, { pcmFrames = 25 } = {}) {
  ensureLiveDialogueOrchestrator(config, ctx, runtime);
  runtime.lastAssistantPlanCandidate = {
    ok: true,
    response_type: RESPONSE_TYPES.GREETING,
    turn_index: 1,
    endpoint_index: 1,
    atMs: Date.now()
  };
  runtime.orchestrator.lastAssistantText = prepareLiveAssistantSpeechText(
    config,
    "Willkommen bei TechnoloHit. Wobei kann ich Ihnen helfen?"
  ).text;
  runtime.ttsAdapter = createLargePcmTtsAdapter(pcmFrames);
  attachLiveSocket(ctx, runtime);
  return runLiveTtsAndPlayback(config, ctx, runtime, { ok: true });
}

async function runPlaybackWithBargeIn(config, ctx, runtime) {
  const playbackPromise = setupPlaybackInFlight(config, ctx, runtime);
  const started = Date.now();
  let sawPlayback = false;
  while (Date.now() - started < 5000) {
    const playing =
      runtime.playbackInFlight === true || runtime.playback?.status === "playing";
    if (playing) {
      sawPlayback = true;
      await feedSpeechDuringPlayback(config, ctx, runtime, 1);
      if ((runtime.bargeInCount ?? 0) > 0) break;
    } else if (sawPlayback) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return playbackPromise;
}

test("10F: default production route remains v3 without barge-in env", () => {
  withEnv(
    {
      VOICE_RUNTIME_VERSION: undefined,
      VOICE_V4_BARGE_IN_ENABLED: undefined
    },
    () => {
      const config = loadConfig();
      assert.equal(config.v4.bargeInEnabled, false);
      const selected = selectLiveCallHandler(config, makeCtx());
      assert.equal(selected.handler, "v3");
      assert.equal(isLiveV4BargeInEnabled(config), false);
    }
  );
});

test("10F: live barge-in uses VOICE_V4_BARGE_IN_ENABLED not spike flags", () => {
  return withEnv(
    liveCanaryEnv("qa-canary", {
      VOICE_V4_BARGE_IN_ENABLED: "true",
      VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED: "true",
      VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED: "true"
    }),
    () => {
      const config = loadConfig();
      assert.equal(isLiveV4BargeInEnabled(config), true);
      assert.equal(isPlaybackCancelSpikeEnabled(config), true);
      assert.equal(isInterruptionContextSpikeEnabled(config), true);
      const runtime = createLiveCanaryRuntime(config, makeCtx({ bridgeCallId: "qa-canary-barge-flag" }));
      assert.equal(runtime.phase, "phase10f_live_barge_in");
    }
  );
});

test("10F: barge-in disabled does not cancel playback", async () => {
  return withEnv(
    liveCanaryEnv("qa-canary", { VOICE_V4_BARGE_IN_ENABLED: "false" }),
    async () => {
      const config = loadConfig();
      const ctx = makeCtx({ bridgeCallId: "qa-canary-barge-off" });
      const runtime = createLiveCanaryRuntime(config, ctx);
      ctx.v4LiveRuntime = runtime;
      const playbackPromise = setupPlaybackInFlight(config, ctx, runtime);
      await waitForCondition(() => runtime.playbackInFlight === true);
      await feedSpeechDuringPlayback(config, ctx, runtime, 6);
      const result = await playbackPromise;
      assert.equal(result.cancelled, undefined);
      assert.equal(runtime.bargeInCount ?? 0, 0);
      assert.equal(runtime.lastAssistantPlaybackCandidate?.cancelled, undefined);
      assert.ok((runtime.lastAssistantPlaybackCandidate?.frames_sent ?? 0) > 0);
    }
  );
});

test("10F: barge-in enabled cancels playback after inbound speech frames", async () => {
  return withEnv(
    liveCanaryEnv("qa-canary", {
      VOICE_V4_BARGE_IN_ENABLED: "true",
      VOICE_V4_BARGE_IN_MIN_PLAYBACK_MS: "0",
      VOICE_V4_BARGE_IN_RMS_THRESHOLD: "400",
      VOICE_V4_BARGE_IN_SPEECH_FRAMES: "3"
    }),
    async () => {
      const config = loadConfig();
      const ctx = makeCtx({
        bridgeCallId: "qa-canary-barge-on",
        callSessionId: "sess-barge-01"
      });
      const runtime = createLiveCanaryRuntime(config, ctx);
      ctx.v4LiveRuntime = runtime;
      const result = await runPlaybackWithBargeIn(config, ctx, runtime, 5);
      assert.equal(result.cancelled, true);
      assert.ok((runtime.bargeInCount ?? 0) >= 1);
      assert.ok(runtime.interruptionContext);
      assert.equal(runtime.pendingInterruptionRecovery, true);
      assert.ok((runtime.interruptionContext.playback_frames_sent ?? 0) >= 0);
      const cancelEvents = runtime.qualityEventsBuffer.filter((e) =>
        ["barge_in_detected", "playback_cancel_requested", "playback_cancelled"].includes(
          e.eventType
        )
      );
      assert.ok(cancelEvents.length >= 2);
      for (const event of cancelEvents) {
        const validation = validateQualityEventInput(event);
        assert.equal(validation.ok, true, validation.errors?.join("; "));
        assert.doesNotMatch(JSON.stringify(event.payload), /\+?\d{8,}/);
        const payloadJson = JSON.stringify(event.payload);
        assert.doesNotMatch(payloadJson, /Willkommen/i);
      }
    }
  );
});

test("10F: cancel metrics recorded on interruption context", async () => {
  return withEnv(
    liveCanaryEnv("qa-canary", {
      VOICE_V4_BARGE_IN_ENABLED: "true",
      VOICE_V4_BARGE_IN_MIN_PLAYBACK_MS: "0"
    }),
    async () => {
      const config = loadConfig();
      const ctx = makeCtx({ bridgeCallId: "qa-canary-barge-metrics" });
      const runtime = createLiveCanaryRuntime(config, ctx);
      ctx.v4LiveRuntime = runtime;
      await runPlaybackWithBargeIn(config, ctx, runtime, 4);
      assert.ok(runtime.interruptionContext);
      assert.ok(
        runtime.interruptionContext.cancel_latency_ms != null ||
          runtime.interruptionContext.playback_frames_sent != null
      );
      const cancelledEvent = runtime.qualityEventsBuffer.find(
        (e) => e.eventType === "playback_cancelled"
      );
      assert.ok(cancelledEvent);
      assert.ok(cancelledEvent.payload?.frames_sent_before_cancel != null);
    }
  );
});

test("10F: next caller turn after interruption can switch product", async () => {
  return withEnv(liveCanaryEnv("qa-canary", { VOICE_V4_BARGE_IN_ENABLED: "true" }), async () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-barge-switch" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    ensureLiveDialogueOrchestrator(config, ctx, runtime);
    runtime.runtimeContext.memory = setSelectedProduct(
      runtime.runtimeContext.memory,
      "smart_website"
    );
    runtime.interruptionContext = captureInterruptedAssistantState({
      memory: runtime.runtimeContext.memory,
      stateMachine: runtime.runtimeContext.stateMachine,
      playback: { enabled: true, status: "cancelled", playbackId: "pb-test" },
      assistantText: "Antwort zu Smart Website.",
      turnIndex: 1
    });
    runtime.pendingInterruptionRecovery = true;
    runtime.highPriorityInterruptionTurn = true;

    const candidate = {
      ok: true,
      transcript: "Stopp, ich meine Botinteg",
      transcriptChars: 24,
      endpointIndex: 2,
      dialogueProcessed: false
    };
    const dialogue = await runLiveDialogueOnCallerTranscript(config, ctx, runtime, candidate);
    assert.equal(dialogue.ok, true);
    assert.equal(runtime.runtimeContext.memory.selected_product_id, "botinteg");
    assert.equal(runtime.pendingInterruptionRecovery, false);
    assert.equal(
      runtime.lastAssistantPlanCandidate?.response_type,
      RESPONSE_TYPES.INTERRUPTION_RECOVERY
    );
  });
});

test("10F: observeLiveCanaryBargeIn errors do not throw to caller", () => {
  return withEnv(
    liveCanaryEnv("qa-canary", { VOICE_V4_BARGE_IN_ENABLED: "true" }),
    () => {
      const config = loadConfig();
      const ctx = makeCtx();
      const runtime = { playback: null, bargeInDetector: null };
      const result = observeLiveCanaryBargeIn(config, ctx, runtime, makePcmFrame(900));
      assert.equal(result.ok, true);
      assert.equal(result.cancelled, false);
    }
  );
});

test("10F: 10E2 TTS failure handling still passes with barge-in enabled", async () => {
  return withEnv(
    liveCanaryEnv("qa-canary", {
      VOICE_V4_BARGE_IN_ENABLED: "true",
      VOICE_V4_TTS_PROVIDER: "mock"
    }),
    async () => {
      const config = loadConfig();
      const ctx = makeCtx({ bridgeCallId: "qa-canary-barge-tts-fail" });
      const ttsAdapter = createTtsAdapter({ provider: "mock", enabled: true });
      ttsAdapter.synthesizeSentenceChunk = () => ({
        ok: false,
        code: "tts_timeout",
        message: "timeout"
      });
      const runtime = createLiveCanaryRuntime(config, ctx, { ttsAdapter });
      ctx.v4LiveRuntime = runtime;
      runtime.lastAssistantPlanCandidate = {
        ok: true,
        response_type: "greeting",
        turn_index: 1,
        endpoint_index: 1,
        atMs: Date.now()
      };
      ensureLiveDialogueOrchestrator(config, ctx, runtime);
      runtime.orchestrator.lastAssistantText = "Kurze Antwort.";
      attachLiveSocket(ctx, runtime);
      const result = await runLiveTtsAndPlayback(config, ctx, runtime, { ok: true });
      assert.equal(result.ok, false);
      const errors = runtime.qualityEventsBuffer.filter((e) => e.eventType === "runtime_error");
      assert.ok(errors.some((e) => e.payload?.event_subtype === "tts_error"));
      await processLiveCanaryInboundFrame(config, ctx, runtime, makePcmFrame(0));
      assert.ok(runtime.inboundFrameCount >= 1);
    }
  );
});
