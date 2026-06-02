import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import {
  createAudioSession,
  appendInboundFrame,
  appendOutboundFrame,
  markSpeechStart,
  markSpeechEnd,
  markEndpointDetected,
  markPlaybackStarted,
  markPlaybackCompleted,
  markInterrupted,
  closeAudioSession,
  getAudioSessionMetrics
} from "../src/v4/audio-session.js";
import { pcmFrameRms } from "../src/v4/pcm-rms.js";
import {
  createVadState,
  observeAudioFrame,
  detectSpeechStart,
  detectEndpoint,
  resetVad,
  getVadMetrics
} from "../src/v4/vad-endpointing.js";
import {
  createSttAdapter,
  createPartialTranscriptEvent,
  createFinalTranscriptEvent,
  createSttErrorEvent
} from "../src/v4/stt-adapter.js";
import { createTtsAdapter } from "../src/v4/tts-adapter.js";
import {
  createTtsPhraseCache,
  buildCacheKey,
  shouldCachePhrase
} from "../src/v4/tts-cache.js";
import {
  resolveRuntimeRoute,
  routeIncomingCallToRuntime,
  routeAudioSocketCall,
  canPrepareV4CanaryMedia
} from "../src/v4/runtime-router.js";
import { prepareCanaryMediaContext } from "../src/v4/audiosocket-runtime.js";
import {
  buildVadSpeechStartEvent,
  buildVadEndpointDetectedEvent,
  buildSttPartialEvent,
  buildSttFinalEvent,
  buildTtsFirstChunkEvent,
  buildTtsCompletedEvent,
  buildAudioSessionClosedEvent,
  validateQualityEventInput
} from "../src/v4/quality-events.js";
import { createCallSessionMemory } from "../src/v4/call-session-memory.js";
import { createStateMachine, V4_STATES } from "../src/v4/state-machine.js";

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

function makePcmFrame(amplitude, samples = 160) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(amplitude, i * 2);
  }
  return buf;
}

function feedFrames(vadState, amplitude, count, frameMs = 20) {
  let state = vadState;
  for (let i = 0; i < count; i += 1) {
    state = observeAudioFrame(state, makePcmFrame(amplitude), frameMs);
  }
  return state;
}

test("Phase 3 config defaults keep canary and media flags off", () => {
  withEnv(
    {
      VOICE_RUNTIME_VERSION: undefined,
      VOICE_V4_REALTIME_ENABLED: undefined,
      VOICE_V4_CANARY_ENABLED: undefined,
      VOICE_V4_VAD_RMS_THRESHOLD: undefined,
      VOICE_V4_TTS_CACHE_ENABLED: undefined
    },
    () => {
      const config = loadConfig();
      assert.equal(config.v4.runtimeVersion, "v3");
      assert.equal(config.v4.canaryEnabled, false);
      assert.equal(config.v4.vadRmsThreshold, 450);
      assert.equal(config.v4.endpointSilenceMs, 600);
      assert.equal(config.v4.ttsCacheEnabled, true);
      assert.equal(config.v4.sttProvider, "mock");
      assert.equal(config.v4.ttsProvider, "mock");
    }
  );
});

test("audio session tracks frames and latency metrics", () => {
  const memory = createCallSessionMemory({ bridgeCallId: "audio-1" });
  const stateMachine = createStateMachine(V4_STATES.LISTENING);
  let session = createAudioSession({
    bridgeCallId: "audio-1",
    sampleRate: 8000,
    frameMs: 20,
    memory,
    stateMachine
  });
  session = appendInboundFrame(session, { rms: 500 });
  session = appendOutboundFrame(session, { bytes: 320 });
  session = markSpeechStart(session, 1000);
  session = markEndpointDetected(session, 1800);
  session = markPlaybackStarted(session, 2000);
  session = markPlaybackCompleted(session, 3500);
  session = markInterrupted(session, 3600);
  session = closeAudioSession(session, 4000);

  const metrics = getAudioSessionMetrics(session);
  assert.equal(metrics.inbound_frames, 1);
  assert.equal(metrics.outbound_frames, 1);
  assert.equal(metrics.speech_started_at, 1000);
  assert.equal(metrics.endpoint_detected_at, 1800);
  assert.equal(metrics.latency.speech_to_endpoint_ms, 800);
  assert.equal(metrics.latency.playback_duration_ms, 1500);
  assert.equal(metrics.is_open, false);
  assert.equal(metrics.memory_state, memory.current_state);
});

test("pcmFrameRms computes expected amplitude", () => {
  const rms = pcmFrameRms(makePcmFrame(1000));
  assert.ok(Math.abs(rms - 1000) < 1);
});

test("VAD silence does not trigger speech start", () => {
  const base = createVadState({ rmsThreshold: 450, speechFramesRequired: 3 });
  const after = feedFrames(base, 0, 20);
  assert.equal(after.speechActive, false);
  assert.equal(detectSpeechStart(after), false);
});

test("VAD speech frames trigger speech start", () => {
  const base = createVadState({ rmsThreshold: 450, speechFramesRequired: 3 });
  const after = feedFrames(base, 800, 3);
  assert.equal(after.speechActive, true);
  assert.ok(after.speechStartedAt != null);
});

test("VAD silence after speech triggers endpoint", () => {
  let state = createVadState({
    rmsThreshold: 450,
    speechFramesRequired: 3,
    endpointSilenceMs: 600,
    minSpeechMs: 240,
    frameMs: 20
  });
  state = feedFrames(state, 800, 15, 20);
  state = feedFrames(state, 0, 30, 20);
  assert.equal(state.speechActive, false);
  assert.ok(state.endpointDetectedAt != null);
});

test("VAD short noise is ignored", () => {
  let state = createVadState({ rmsThreshold: 450, speechFramesRequired: 3 });
  state = feedFrames(state, 900, 2);
  state = feedFrames(state, 0, 10);
  assert.equal(state.speechActive, false);
});

test("VAD slower speaker is not cut too early", () => {
  let state = createVadState({
    rmsThreshold: 450,
    speechFramesRequired: 3,
    endpointSilenceMs: 600,
    minSpeechMs: 240,
    frameMs: 20
  });
  state = feedFrames(state, 800, 5, 20);
  state = feedFrames(state, 0, 30, 20);
  assert.equal(state.speechActive, true);
  assert.equal(state.endpointDetectedAt, null);
});

test("resetVad clears speech state", () => {
  let state = feedFrames(createVadState({ speechFramesRequired: 2 }), 800, 5);
  state = resetVad(state);
  assert.equal(state.speechActive, false);
  assert.equal(getVadMetrics(state).total_speech_frames, 0);
});

test("STT adapter emits partial and final event shapes", () => {
  const adapter = createSttAdapter({ provider: "mock", enabled: true });
  const partials = [];
  const finals = [];
  const started = adapter.startSttStream({
    onPartial: (e) => partials.push(e),
    onFinal: (e) => finals.push(e)
  });
  assert.equal(started.ok, true);

  adapter.appendAudio(started.streamId, makePcmFrame(100));
  adapter.appendAudio(started.streamId, makePcmFrame(100));
  const completed = adapter.completeSttTurn(started.streamId);

  assert.equal(completed.ok, true);
  assert.equal(completed.event.type, "stt_final");
  assert.equal(completed.event.isFinal, true);
  assert.equal(partials.length, 2);
  assert.equal(partials[0].type, "stt_partial");
  assert.equal(partials[0].isFinal, false);
  assert.equal(finals.length, 1);
});

test("STT adapter fail-closed when disabled", () => {
  const adapter = createSttAdapter({ enabled: false });
  const started = adapter.startSttStream();
  assert.equal(started.ok, false);
  assert.equal(started.error.type, "stt_error");
  assert.equal(started.error.recoverable, false);
});

test("TTS openai provider fails closed without synthesize impl", () => {
  const adapter = createTtsAdapter({ provider: "openai", enabled: true });
  const result = adapter.synthesizeSentenceChunk("Hallo");
  assert.equal(result.ok, false);
  assert.equal(result.code, "openai_not_configured");
});

test("STT openai provider fails closed without fetchImpl", () => {
  const adapter = createSttAdapter({ provider: "openai", enabled: true });
  const started = adapter.startSttStream();
  assert.equal(started.ok, true);
  const appended = adapter.appendAudio(started.streamId, makePcmFrame(100));
  assert.equal(appended.ok, false);
  assert.equal(appended.error.code, "openai_not_configured");
});

test("STT abort returns safe result", () => {
  const adapter = createSttAdapter({ provider: "mock", enabled: true });
  const started = adapter.startSttStream();
  const aborted = adapter.abortSttStream(started.streamId);
  assert.equal(aborted.ok, true);
  const completed = adapter.completeSttTurn(started.streamId);
  assert.equal(completed.ok, false);
  assert.equal(completed.error.code, "stream_not_found");
});

test("STT error event shape is stable", () => {
  const err = createSttErrorEvent({ streamId: "s1", code: "timeout", recoverable: true });
  assert.equal(err.type, "stt_error");
  assert.equal(err.streamId, "s1");
  assert.equal(err.recoverable, true);
});

test("TTS cache key includes voice model language text hash", () => {
  const a = buildCacheKey({
    voice: "marin",
    model: "gpt-4o-mini-tts",
    language: "de",
    text: "Guten Tag"
  });
  const b = buildCacheKey({
    voice: "marin",
    model: "gpt-4o-mini-tts",
    language: "de",
    text: "Guten Tag"
  });
  const c = buildCacheKey({
    voice: "marin",
    model: "gpt-4o-mini-tts",
    language: "de",
    text: "Auf Wiedersehen"
  });
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, c.key);
});

test("TTS cache refuses phone-like text", () => {
  const decision = shouldCachePhrase("Bitte rufen Sie mich an 0171 5551234", "greeting");
  assert.equal(decision.cacheable, false);
  assert.equal(decision.reason, "phone_like_text");
});

test("TTS cache allows static closing phrase", () => {
  const decision = shouldCachePhrase("Vielen Dank für Ihren Anruf.", "closing");
  assert.equal(decision.cacheable, true);
  const cache = createTtsPhraseCache();
  const put = cache.putCachedPhrase(
    buildCacheKey({ voice: "v", model: "m", language: "de", text: "Vielen Dank für Ihren Anruf." }),
    { audio: Buffer.from("audio"), sampleRate: 8000 },
    { text: "Vielen Dank für Ihren Anruf.", category: "closing" }
  );
  assert.equal(put.ok, true);
});

test("TTS adapter abort returns safe result", () => {
  const adapter = createTtsAdapter({ provider: "mock", enabled: true });
  const idleAbort = adapter.abortTts();
  assert.equal(idleAbort.ok, true);
  assert.equal(idleAbort.aborted, false);
});

test("TTS synthesize uses cache on second call", () => {
  const adapter = createTtsAdapter({ provider: "mock", enabled: true, cacheEnabled: true });
  const text = "Willkommen bei TechnoloHit.";
  const first = adapter.synthesizeSentenceChunk(text, { category: "greeting" });
  const second = adapter.synthesizeSentenceChunk(text, { category: "greeting" });
  assert.equal(first.ok, true);
  assert.equal(first.fromCache, false);
  assert.equal(second.ok, true);
  assert.equal(second.fromCache, true);
  assert.equal(adapter.getTtsMetrics().cache_hits, 1);
});

test("default production route remains v3", () => {
  withEnv({ VOICE_RUNTIME_VERSION: undefined, VOICE_V4_REALTIME_ENABLED: undefined }, () => {
    const config = loadConfig();
    assert.equal(resolveRuntimeRoute(config).runtime, "v3");
    assert.equal(routeIncomingCallToRuntime(config).handler, "v3");
    const audioRoute = routeAudioSocketCall(config, { bridgeCallId: "prod-1" });
    assert.equal(audioRoute.handler, "v3");
    assert.equal(audioRoute.dropCall, false);
  });
});

test("v4 realtime without canary stays on v3 handler", () => {
  withEnv(
    { VOICE_RUNTIME_VERSION: "v4", VOICE_V4_REALTIME_ENABLED: "true", VOICE_V4_CANARY_ENABLED: "false" },
    () => {
      const config = loadConfig();
      const route = resolveRuntimeRoute(config);
      assert.equal(route.runtime, "v4");
      assert.equal(route.active, false);
      assert.equal(route.canaryReady, false);
      assert.equal(route.reason, "v4_canary_disabled");
      assert.equal(routeIncomingCallToRuntime(config).handler, "v3");
      assert.equal(canPrepareV4CanaryMedia(config), false);
    }
  );
});

test("v4 canary on creates media context only with harness explicit", () => {
  withEnv(
    {
      VOICE_RUNTIME_VERSION: "v4",
      VOICE_V4_REALTIME_ENABLED: "true",
      VOICE_V4_CANARY_ENABLED: "true"
    },
    () => {
      const config = loadConfig();
      assert.equal(canPrepareV4CanaryMedia(config), true);
      const blocked = routeAudioSocketCall(config, { bridgeCallId: "canary-1" });
      assert.equal(blocked.handler, "v3");
      assert.equal(blocked.dropCall, false);
      assert.equal(blocked.mediaContext, null);
      assert.equal(blocked.canaryReady, true);

      const harness = prepareCanaryMediaContext(config, {
        bridgeCallId: "canary-harness",
        harnessExplicit: true
      });
      assert.equal(harness.ok, true);
      assert.equal(harness.audioSession.bridgeCallId, "canary-harness");
      assert.ok(harness.vadState);
      assert.ok(harness.adapters.stt);
      assert.ok(harness.adapters.tts);
    }
  );
});

test("media quality events redact sensitive payload fields", () => {
  withEnv({ VOICE_AGENT_CONFIG_PATH: undefined }, () => {
    const config = loadConfig();
    const sessionMetrics = getAudioSessionMetrics(
      closeAudioSession(createAudioSession({ bridgeCallId: "q-1" }), 5000)
    );
    const partial = buildSttPartialEvent({
      config,
      payload: { transcript: "secret", caller_phone: "+491701234567" }
    });
    assert.equal(partial.payload.caller_phone, "[redacted]");
    assert.equal(partial.payload.transcript, "[redacted]");
    assert.equal(validateQualityEventInput(partial).ok, true);

    const final = buildSttFinalEvent({ config, metricValue: 900, payload: { text: "01715551234" } });
    assert.doesNotMatch(String(final.payload.text ?? ""), /5551234/);
    assert.equal(validateQualityEventInput(final).ok, true);

    const vadStart = buildVadSpeechStartEvent({ config, metricValue: 12, payload: { rms: 800 } });
    assert.equal(vadStart.eventType, "vad_speech_start");
    assert.equal(validateQualityEventInput(vadStart).ok, true);

    const endpoint = buildVadEndpointDetectedEvent({
      config,
      metricValue: 640,
      payload: { silence_ms: 600 }
    });
    assert.equal(endpoint.eventType, "vad_endpoint_detected");
    assert.equal(validateQualityEventInput(endpoint).ok, true);

    const ttsFirst = buildTtsFirstChunkEvent({ config, metricValue: 120, payload: { chunk_index: 0 } });
    assert.equal(ttsFirst.eventType, "tts_first_chunk");
    assert.equal(validateQualityEventInput(ttsFirst).ok, true);

    const ttsDone = buildTtsCompletedEvent({ config, metricValue: 800 });
    assert.equal(ttsDone.eventType, "tts_completed");
    assert.equal(validateQualityEventInput(ttsDone).ok, true);

    const closed = buildAudioSessionClosedEvent({
      config,
      metricValue: 5000,
      payload: { inbound_frames: sessionMetrics.inbound_frames }
    });
    assert.equal(closed.eventType, "audio_session_closed");
    assert.equal(validateQualityEventInput(closed).ok, true);
  });
});

test("partial and final STT standalone event shapes", () => {
  const partial = createPartialTranscriptEvent({ streamId: "x", text: "hallo" });
  const final = createFinalTranscriptEvent({ streamId: "x", text: "hallo welt", durationMs: 400 });
  assert.equal(partial.provider, "mock");
  assert.equal(final.isFinal, true);
  assert.equal(final.durationMs, 400);
});
