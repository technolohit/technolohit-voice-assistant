import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import {
  createPlaybackController,
  startPlayback,
  observePlaybackFrameSent,
  requestPlaybackCancel,
  shouldStopPlayback,
  finalizePlayback,
  getPlaybackMetrics
} from "../src/v4/playback-controller.js";
import {
  createBargeInDetector,
  observeInboundDuringPlayback,
  shouldCancelPlaybackForSpeech,
  markBargeInTriggered,
  resetBargeInDetector,
  getBargeInMetrics
} from "../src/v4/barge-in-detector.js";
import {
  captureInterruptedAssistantState,
  detectTopicOrProductSwitch,
  resolveInterruptionRecovery,
  clearInterruptionAfterRecovery,
  hasStaleProductAfterSwitch
} from "../src/v4/interruption-context.js";
import {
  resolveRuntimeRoute,
  routeIncomingCallToRuntime,
  routeAudioSocketCall,
  routeBargeInTestContext,
  canPrepareV4BargeIn
} from "../src/v4/runtime-router.js";
import {
  createBargeInRuntimeContext,
  maybeCancelPlaybackFromInboundSpeech,
  observeOutboundFrameForPlayback,
  finalizeBargeInAttempt
} from "../src/v4/audiosocket-runtime.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";
import { createStateMachine, V4_STATES } from "../src/v4/state-machine.js";
import {
  buildPlaybackStartedEvent,
  buildPlaybackCancelRequestedEvent,
  buildPlaybackCancelledEvent,
  buildPlaybackCompletedEvent,
  buildBargeInDetectedEvent,
  buildInterruptionContextCapturedEvent,
  buildTopicSwitchDetectedEvent,
  buildInterruptionRecoveredEvent,
  validateQualityEventInput
} from "../src/v4/quality-events.js";
import { isPlaybackCancelSpikeEnabled } from "../src/playback-session.js";
import { isInterruptionContextSpikeEnabled } from "../src/interruption-recovery.js";

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

function bargeInEnv(overrides = {}) {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_V4_BARGE_IN_ENABLED: "true",
    VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED: "false",
    VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED: "false",
    VOICE_AGENT_CONFIG_PATH: undefined,
    ...overrides
  };
}

function feedSpeechDuringPlayback(detector, playback, frames, amplitude = 900, atMs = 200) {
  let nextDetector = detector;
  for (let i = 0; i < frames; i += 1) {
    nextDetector = observeInboundDuringPlayback(nextDetector, amplitude, playback, atMs + i * 20);
  }
  return nextDetector;
}

test("Phase 4 config defaults keep barge-in off", () => {
  withEnv(
    {
      VOICE_V4_BARGE_IN_ENABLED: undefined,
      VOICE_V4_BARGE_IN_RMS_THRESHOLD: undefined,
      VOICE_V4_BARGE_IN_MIN_PLAYBACK_MS: undefined
    },
    () => {
      const config = loadConfig();
      assert.equal(config.v4.bargeInEnabled, false);
      assert.equal(config.v4.bargeInRmsThreshold, config.v4.vadRmsThreshold);
      assert.equal(config.v4.bargeInSpeechFrames, config.v4.vadSpeechFrames);
      assert.equal(config.v4.bargeInMinPlaybackMs, 120);
      assert.equal(config.v4.bargeInCancelTimeoutMs, 400);
    }
  );
});

test("default production route remains v3", () => {
  withEnv({ VOICE_RUNTIME_VERSION: undefined, VOICE_V4_BARGE_IN_ENABLED: undefined }, () => {
    const config = loadConfig();
    assert.equal(resolveRuntimeRoute(config).runtime, "v3");
    assert.equal(routeIncomingCallToRuntime(config).handler, "v3");
    assert.equal(routeAudioSocketCall(config).handler, "v3");
    assert.equal(routeAudioSocketCall(config).dropCall, false);
  });
});

test("canary without harnessExplicit still returns v3", () => {
  withEnv(bargeInEnv(), () => {
    const config = loadConfig();
    const route = routeAudioSocketCall(config, { bridgeCallId: "live-1" });
    assert.equal(route.handler, "v3");
    assert.equal(route.dropCall, false);
    assert.equal(route.bargeInReady, true);
    assert.equal(route.mediaContext, null);
  });
});

test("v4 canary without barge-in flag stays media stub only", () => {
  withEnv(bargeInEnv({ VOICE_V4_BARGE_IN_ENABLED: "false" }), () => {
    const config = loadConfig();
    assert.equal(canPrepareV4BargeIn(config), false);
    assert.equal(resolveRuntimeRoute(config).reason, "v4_canary_media_stub_phase3");
  });
});

test("barge-in detector ignores noise below threshold", () => {
  const playback = startPlayback(
    createPlaybackController({ enabled: true, bridgeCallId: "b1", turnIndex: 1 }),
    1000
  ).controller;
  let detector = createBargeInDetector({ rmsThreshold: 450, speechFramesRequired: 3, minPlaybackMs: 0 });
  detector = feedSpeechDuringPlayback(detector, playback, 5, 100, 1000);
  assert.equal(shouldCancelPlaybackForSpeech(detector, playback, 1100), false);
});

test("barge-in detector cancels on consecutive speech after min playback", () => {
  let playback = startPlayback(
    createPlaybackController({ enabled: true, bridgeCallId: "b2", turnIndex: 2 }),
    1000
  ).controller;
  let detector = createBargeInDetector({ rmsThreshold: 450, speechFramesRequired: 3, minPlaybackMs: 120 });
  detector = feedSpeechDuringPlayback(detector, playback, 2, 900, 1050);
  assert.equal(shouldCancelPlaybackForSpeech(detector, playback, 1090), false);
  detector = feedSpeechDuringPlayback(detector, playback, 3, 900, 1150);
  assert.equal(shouldCancelPlaybackForSpeech(detector, playback, 1210), true);
});

test("barge-in delayed speech triggers after min playback window", () => {
  let playback = startPlayback(createPlaybackController({ enabled: true }), 1000).controller;
  let detector = createBargeInDetector({ minPlaybackMs: 120, speechFramesRequired: 3, rmsThreshold: 450 });
  detector = observeInboundDuringPlayback(detector, 900, playback, 1080);
  assert.equal(detector.consecutiveSpeechFrames, 0);
  detector = feedSpeechDuringPlayback(detector, playback, 3, 900, 1300);
  assert.equal(shouldCancelPlaybackForSpeech(detector, playback, 1360), true);
});

test("resetBargeInDetector clears trigger state", () => {
  let detector = createBargeInDetector();
  detector = markBargeInTriggered(detector, startPlayback(createPlaybackController({ enabled: true }), 1).controller, 50);
  detector = resetBargeInDetector(detector);
  assert.equal(getBargeInMetrics(detector).barge_in_triggered, false);
});

test("playback controller records cancel latency and frames", () => {
  let controller = createPlaybackController({ enabled: true, bridgeCallId: "pb-1", turnIndex: 3 });
  controller = startPlayback(controller, 1000).controller;
  controller = observePlaybackFrameSent(controller, { bytes: 320 }, 1020).controller;
  controller = observePlaybackFrameSent(controller, { bytes: 320 }, 1040).controller;
  const cancel = requestPlaybackCancel(controller, "barge_in", 1150);
  controller = finalizePlayback(cancel.controller, "cancelled", 1160).controller;
  const metrics = getPlaybackMetrics(controller);
  assert.equal(metrics.frames_sent, 2);
  assert.equal(metrics.bytes_sent, 640);
  assert.equal(metrics.cancel_reason, "barge_in");
  assert.equal(metrics.cancel_latency_ms, 150);
  assert.equal(metrics.stopped_by_barge_in, true);
  assert.equal(shouldStopPlayback(controller), true);
});

test("interruption context switches Smart Website to Digitale Rezeption", () => {
  withEnv({ VOICE_AGENT_CONFIG_PATH: undefined }, () => {
    const config = loadConfig();
    const agent = loadAgentConfig(config);
    let memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "i1" }), "smart_website");
    const stateMachine = createStateMachine(V4_STATES.SPEAKING);
    const playback = finalizePlayback(
      requestPlaybackCancel(
        observePlaybackFrameSent(startPlayback(createPlaybackController({ enabled: true, turnIndex: 2 }), 1).controller, {
          bytes: 160
        }).controller,
        "barge_in",
        200
      ).controller,
      "cancelled",
      210
    ).controller;

    const captured = captureInterruptedAssistantState({
      memory,
      stateMachine,
      playback,
      assistantText: "Smart Website erklärt..."
    });
    const recovery = resolveInterruptionRecovery({
      agentConfig: agent,
      memory,
      stateMachine,
      context: captured,
      callerText: "Stopp, erzählen Sie mir bitte über die Digitale Rezeption"
    });

    assert.equal(recovery.recoveryAction, "product_switch");
    assert.equal(recovery.memory.selected_product_id, "voice_agent");
    assert.equal(recovery.context.topic_switch_detected, true);
    assert.equal(hasStaleProductAfterSwitch(recovery.memory, "voice_agent"), false);
  });
});

test("interruption context switches Digitale Rezeption to Smart Website", () => {
  withEnv({ VOICE_AGENT_CONFIG_PATH: undefined }, () => {
    const config = loadConfig();
    const agent = loadAgentConfig(config);
    const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "i2" }), "voice_agent");
    const playback = finalizePlayback(
      requestPlaybackCancel(startPlayback(createPlaybackController({ enabled: true, turnIndex: 2 }), 1).controller, "barge_in").controller,
      "cancelled"
    ).controller;
    const recovery = resolveInterruptionRecovery({
      agentConfig: agent,
      memory,
      stateMachine: createStateMachine(V4_STATES.SPEAKING),
      context: captureInterruptedAssistantState({
        memory,
        stateMachine: createStateMachine(V4_STATES.SPEAKING),
        playback,
        turnIndex: 2
      }),
      callerText: "Ich meine Smart Website"
    });
    assert.equal(recovery.memory.selected_product_id, "smart_website");
    assert.equal(recovery.recoveryAction, "product_switch");
  });
});

test("Stopp ich meine phrase triggers product switch", () => {
  withEnv({ VOICE_AGENT_CONFIG_PATH: undefined }, () => {
    const agent = loadAgentConfig(loadConfig());
    const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "i3" }), "voice_agent");
    const switchInfo = detectTopicOrProductSwitch(agent, "Stopp, ich meine Smart Website", "voice_agent");
    assert.equal(switchInfo.recoveryAction, "product_switch");
    assert.equal(switchInfo.detectedProductId, "smart_website");
  });
});

test("caller continues same topic without stale product switch", () => {
  withEnv({ VOICE_AGENT_CONFIG_PATH: undefined }, () => {
    const agent = loadAgentConfig(loadConfig());
    const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "i4" }), "smart_website");
    const switchInfo = detectTopicOrProductSwitch(agent, "Was kostet das ungefähr?", "smart_website");
    assert.equal(switchInfo.topicSwitchDetected, false);
    assert.equal(switchInfo.recoveryAction, "continue_same_topic");
    const recovery = resolveInterruptionRecovery({
      agentConfig: agent,
      memory,
      stateMachine: createStateMachine(V4_STATES.SPEAKING),
      context: createInterruptionContextFromMemory(memory),
      callerText: "Was kostet das ungefähr?"
    });
    assert.equal(recovery.memory.selected_product_id, "smart_website");
  });
});

test("clearInterruptionAfterRecovery clears context", () => {
  const memory = createCallSessionMemory({ bridgeCallId: "i5" });
  const interrupted = resolveInterruptionRecovery({
    agentConfig: loadAgentConfig(loadConfig()),
    memory: setSelectedProduct(memory, "smart_website"),
    stateMachine: createStateMachine(V4_STATES.SPEAKING),
    context: {
      turn_index: 1,
      interrupted_product_id: "smart_website",
      cancel_reason: "barge_in",
      assistant_text_preview: "Hallo"
    },
    callerText: "Stop"
  });
  const cleared = clearInterruptionAfterRecovery(interrupted.memory, interrupted.stateMachine);
  assert.equal(cleared.memory.interruption_context, null);
});

function createInterruptionContextFromMemory(memory) {
  return {
    turn_index: 1,
    interrupted_product_id: memory.selected_product_id,
    cancel_reason: "barge_in",
    assistant_text_preview: "Preview"
  };
}

test("canary barge-in harness creates runtime context", () => {
  withEnv(bargeInEnv(), () => {
    const config = loadConfig();
    const routed = routeBargeInTestContext(config, { harnessExplicit: true, bridgeCallId: "canary-barge" });
    assert.equal(routed.handler, "v4_canary_barge_in_stub");
    assert.equal(routed.dropCall, false);
    assert.ok(routed.context.ok);
    assert.ok(routed.context.playback);
    assert.ok(routed.context.bargeInDetector);
  });
});

test("maybeCancelPlaybackFromInboundSpeech cancels and captures context", () => {
  withEnv(bargeInEnv({ VOICE_V4_BARGE_IN_MIN_PLAYBACK_MS: "0" }), () => {
    const config = loadConfig();
    let ctx = createBargeInRuntimeContext(config, {
      harnessExplicit: true,
      bridgeCallId: "h1",
      playbackStartedAt: 1000
    });
    ctx = observeOutboundFrameForPlayback(ctx, { bytes: 320 }, 1100).ctx;
    ctx = observeOutboundFrameForPlayback(ctx, { bytes: 320 }, 1120).ctx;

    let cancel = { cancelled: false, ctx };
    for (let i = 0; i < 3; i += 1) {
      cancel = maybeCancelPlaybackFromInboundSpeech(ctx, makePcmFrame(900), 1300 + i * 20);
      ctx = cancel.ctx;
    }
    assert.equal(cancel.cancelled, true);
    assert.ok(cancel.interruptionContext);
    assert.ok(cancel.ctx.qualityEvents.length >= 2);

    const finalized = finalizeBargeInAttempt(cancel.ctx, {
      callerText: "Stopp, ich meine Smart Website",
      atMs: 1400,
      config
    });
    assert.equal(finalized.ok, true);
    assert.equal(finalized.ctx.recoveryAction, "product_switch");
  });
});

test("Phase 4 path does not require Phase 0B/0C spike flags", () => {
  withEnv(bargeInEnv(), () => {
    const config = loadConfig();
    assert.equal(isPlaybackCancelSpikeEnabled(config), false);
    assert.equal(isInterruptionContextSpikeEnabled(config), false);
    assert.equal(canPrepareV4BargeIn(config), true);
  });
});

test("playback and interruption quality events redact sensitive fields", () => {
  withEnv({ VOICE_AGENT_CONFIG_PATH: undefined }, () => {
    const config = loadConfig();
    const partial = buildPlaybackCancelRequestedEvent({
      config,
      metricValue: 120,
      payload: { caller_phone: "+491701234567", cancel_reason: "barge_in" }
    });
    assert.equal(partial.payload.caller_phone, "[redacted]");

    const captured = buildInterruptionContextCapturedEvent({
      config,
      payload: {
        caller_utterance: "01715551234",
        interrupted_product_id: "smart_website"
      }
    });
    assert.doesNotMatch(String(captured.payload.caller_utterance ?? ""), /5551234/);

    const bargeIn = buildBargeInDetectedEvent({ config, payload: { transcript: "secret" } });
    assert.equal(bargeIn.payload.transcript, "[redacted]");

    for (const event of [
      buildPlaybackStartedEvent({ config, payload: { turn_index: 1 } }),
      partial,
      buildPlaybackCancelledEvent({ config, metricValue: 130, payload: { frames_sent: 4 } }),
      buildPlaybackCompletedEvent({ config, metricValue: 900 }),
      bargeIn,
      captured,
      buildTopicSwitchDetectedEvent({
        config,
        payload: { from_product: "smart_website", to_product: "voice_agent" }
      }),
      buildInterruptionRecoveredEvent({ config, payload: { recovery_action: "product_switch" } })
    ]) {
      assert.equal(validateQualityEventInput(event).ok, true);
    }
  });
});
