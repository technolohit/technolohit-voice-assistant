/**
 * v4 AudioSocket canary runtime — Phase 3 media + Phase 4 barge-in foundation.
 * Production calls always route to v3 unless harnessExplicit opt-in.
 */

import { createAudioSession, markInterrupted, markPlaybackStarted, markPlaybackCompleted } from "./audio-session.js";
import { createVadState } from "./vad-endpointing.js";
import { createSttAdapter } from "./stt-adapter.js";
import { createTtsAdapter } from "./tts-adapter.js";
import { createRuntimeContext } from "./runtime-context.js";
import {
  createPlaybackController,
  startPlayback,
  observePlaybackFrameSent,
  requestPlaybackCancel,
  shouldStopPlayback,
  finalizePlayback,
  getPlaybackMetrics
} from "./playback-controller.js";
import {
  createBargeInDetectorFromConfig,
  observeInboundDuringPlayback,
  shouldCancelPlaybackForSpeech,
  markBargeInTriggered,
  resetBargeInDetector,
  getBargeInMetrics
} from "./barge-in-detector.js";
import {
  captureInterruptedAssistantState,
  resolveInterruptionRecovery
} from "./interruption-context.js";
import {
  buildBargeInDetectedEvent,
  buildPlaybackCancelRequestedEvent,
  buildPlaybackCancelledEvent,
  buildInterruptionContextCapturedEvent
} from "./quality-events.js";

export function isV4CanaryEnabled(config) {
  return Boolean(config?.v4?.canaryEnabled);
}

export function isV4BargeInEnabled(config) {
  return Boolean(config?.v4?.bargeInEnabled);
}

export function canPrepareV4CanaryMedia(config) {
  const runtimeVersion = String(config?.v4?.runtimeVersion ?? "v3")
    .trim()
    .toLowerCase();
  return (
    runtimeVersion === "v4" &&
    Boolean(config?.v4?.realtimeEnabled) &&
    isV4CanaryEnabled(config)
  );
}

export function canPrepareV4BargeIn(config) {
  return canPrepareV4CanaryMedia(config) && isV4BargeInEnabled(config);
}

export function createVadStateFromConfig(config) {
  const v4 = config?.v4 ?? {};
  return createVadState({
    rmsThreshold: v4.vadRmsThreshold,
    speechFramesRequired: v4.vadSpeechFrames,
    endpointSilenceMs: v4.endpointSilenceMs,
    minSpeechMs: v4.endpointMinSpeechMs,
    frameMs: config?.frameMs ?? 20,
    sampleRate: config?.sampleRate ?? 8000
  });
}

export function createMediaAdaptersFromConfig(config) {
  const v4 = config?.v4 ?? {};
  return {
    stt: createSttAdapter({
      provider: v4.sttProvider ?? "mock",
      enabled: Boolean(v4.streamingSttEnabled)
    }),
    tts: createTtsAdapter({
      provider: v4.ttsProvider ?? "mock",
      enabled: Boolean(v4.streamingTtsEnabled),
      voice: config?.assistant?.ttsVoice ?? "marin",
      model: config?.assistant?.ttsModel ?? "gpt-4o-mini-tts",
      language: config?.transcription?.language ?? "de",
      cacheEnabled: Boolean(v4.ttsCacheEnabled)
    })
  };
}

function buildCanaryRoute(reason) {
  return {
    runtime: "v4",
    active: false,
    stub: true,
    canaryReady: true,
    bargeInReady: reason.includes("barge_in"),
    reason
  };
}

export function prepareCanaryMediaContext(config, input = {}) {
  if (!canPrepareV4CanaryMedia(config)) {
    return {
      ok: false,
      active: false,
      handler: "v3",
      reason: isV4CanaryEnabled(config) ? "v4_canary_prerequisites_missing" : "v4_canary_disabled"
    };
  }

  if (!input.harnessExplicit) {
    return {
      ok: false,
      active: false,
      handler: "v3",
      reason: "canary_stub_not_active_for_production",
      canaryReady: true
    };
  }

  const route = buildCanaryRoute("v4_canary_media_context_test_harness");
  const runtimeContext = createRuntimeContext(config, input, route);
  const audioSession = createAudioSession({
    bridgeCallId: input.bridgeCallId ?? input.bridge_call_id ?? "canary-pending",
    callSessionId: runtimeContext.memory?.call_session_id ?? null,
    sampleRate: config?.sampleRate ?? 8000,
    frameMs: config?.frameMs ?? 20,
    memory: runtimeContext.memory,
    stateMachine: runtimeContext.stateMachine
  });
  const vadState = createVadStateFromConfig(config);
  const adapters = createMediaAdaptersFromConfig(config);

  return {
    ok: true,
    active: false,
    handler: "v4_canary_stub",
    reason: route.reason,
    canaryReady: true,
    runtimeContext,
    audioSession,
    vadState,
    adapters,
    phase: "phase3_canary_media_stub"
  };
}

export function createBargeInRuntimeContext(config, input = {}) {
  if (!canPrepareV4BargeIn(config)) {
    return {
      ok: false,
      active: false,
      handler: "v3",
      reason: isV4BargeInEnabled(config) ? "v4_barge_in_prerequisites_missing" : "v4_barge_in_disabled"
    };
  }

  if (!input.harnessExplicit) {
    return {
      ok: false,
      active: false,
      handler: "v3",
      reason: "barge_in_stub_not_active_for_production",
      canaryReady: true,
      bargeInReady: true
    };
  }

  const route = buildCanaryRoute("v4_canary_barge_in_test_harness");
  const runtimeContext = createRuntimeContext(config, input, route);
  const bridgeCallId = input.bridgeCallId ?? input.bridge_call_id ?? "canary-barge-in";
  const turnIndex = input.turnIndex ?? input.turn_index ?? 1;

  let audioSession = createAudioSession({
    bridgeCallId,
    callSessionId: runtimeContext.memory?.call_session_id ?? null,
    sampleRate: config?.sampleRate ?? 8000,
    frameMs: config?.frameMs ?? 20,
    memory: runtimeContext.memory,
    stateMachine: runtimeContext.stateMachine
  });

  const playbackSeed = createPlaybackController({
    enabled: true,
    bridgeCallId,
    turnIndex,
    label: input.label ?? "assistant_response"
  });
  const playbackStarted = startPlayback(playbackSeed, input.playbackStartedAt ?? Date.now());
  let playback = playbackStarted.controller;
  audioSession = markPlaybackStarted(audioSession, playback.startedAt);

  const stateMachine = {
    ...runtimeContext.stateMachine,
    state: input.initialState ?? "speaking"
  };

  return {
    ok: true,
    active: false,
    handler: "v4_canary_barge_in_stub",
    reason: route.reason,
    canaryReady: true,
    bargeInReady: true,
    phase: "phase4_canary_barge_in_stub",
    config,
    runtimeContext: {
      ...runtimeContext,
      stateMachine
    },
    audioSession,
    vadState: createVadStateFromConfig(config),
    adapters: createMediaAdaptersFromConfig(config),
    playback,
    bargeInDetector: createBargeInDetectorFromConfig(config),
    qualityEvents: [],
    interruptionContext: null
  };
}

export function observeOutboundFrameForPlayback(ctx, frameMeta = {}, atMs = Date.now()) {
  if (!ctx?.playback) return { ctx, ok: false, reason: "playback_missing" };
  const observed = observePlaybackFrameSent(ctx.playback, frameMeta, atMs);
  return {
    ok: observed.ok,
    ctx: { ...ctx, playback: observed.controller },
    shouldStop: shouldStopPlayback(observed.controller)
  };
}

export function observeInboundFrameForBargeIn(ctx, frameOrRms, atMs = Date.now()) {
  if (!ctx?.bargeInDetector || !ctx?.playback) {
    return { ctx, ok: false, reason: "barge_in_context_missing" };
  }
  const detector = observeInboundDuringPlayback(ctx.bargeInDetector, frameOrRms, ctx.playback, atMs);
  return {
    ok: true,
    ctx: { ...ctx, bargeInDetector: detector },
    shouldCancel: shouldCancelPlaybackForSpeech(detector, ctx.playback, atMs)
  };
}

export function maybeCancelPlaybackFromInboundSpeech(ctx, frameOrRms, atMs = Date.now()) {
  const observed = observeInboundFrameForBargeIn(ctx, frameOrRms, atMs);
  if (!observed.ok || !observed.shouldCancel) {
    return { ...observed, cancelled: false };
  }

  const triggeredDetector = markBargeInTriggered(observed.ctx.bargeInDetector, observed.ctx.playback, atMs);
  const cancelResult = requestPlaybackCancel(observed.ctx.playback, "barge_in", atMs);
  let nextCtx = {
    ...observed.ctx,
    bargeInDetector: triggeredDetector,
    playback: cancelResult.controller
  };

  const qualityEvents = [...(nextCtx.qualityEvents ?? [])];
  qualityEvents.push(
    buildBargeInDetectedEvent({
      config: nextCtx.config,
      payload: {
        bridge_call_id: nextCtx.playback.bridgeCallId,
        turn_index: nextCtx.playback.turnIndex,
        ...getBargeInMetrics(triggeredDetector)
      }
    }),
    buildPlaybackCancelRequestedEvent({
      config: nextCtx.config,
      payload: getPlaybackMetrics(cancelResult.controller)
    })
  );

  let audioSession = markInterrupted(nextCtx.audioSession, atMs);
  const interruptionContext = captureInterruptedAssistantState({
    memory: nextCtx.runtimeContext.memory,
    stateMachine: nextCtx.runtimeContext.stateMachine,
    playback: cancelResult.controller,
    assistantText: nextCtx.assistantText ?? "",
    turnIndex: nextCtx.playback.turnIndex
  });

  nextCtx = {
    ...nextCtx,
    audioSession,
    qualityEvents,
    interruptionContext
  };

  return {
    ok: true,
    ctx: nextCtx,
    cancelled: true,
    shouldCancel: true,
    cancelResult,
    interruptionContext
  };
}

export function finalizeBargeInAttempt(ctx, { callerText = "", atMs = Date.now(), config = null } = {}) {
  if (!ctx?.playback) {
    return { ok: false, reason: "playback_missing", ctx };
  }

  const finalized = finalizePlayback(
    ctx.playback,
    ctx.playback.status === "cancel_requested" ? "cancelled" : "completed",
    atMs
  );
  let nextCtx = { ...ctx, playback: finalized.controller, config: config ?? ctx.config };

  const qualityEvents = [...(nextCtx.qualityEvents ?? [])];
  if (finalized.controller.status === "cancelled") {
    qualityEvents.push(
      buildPlaybackCancelledEvent({
        config: nextCtx.config,
        metricValue: finalized.controller.cancelLatencyMs,
        payload: getPlaybackMetrics(finalized.controller)
      })
    );
    nextCtx.audioSession = markPlaybackCompleted(nextCtx.audioSession, atMs);
  }

  if (nextCtx.interruptionContext) {
    const recovery = resolveInterruptionRecovery({
      agentConfig: nextCtx.runtimeContext.agentConfig,
      memory: nextCtx.runtimeContext.memory,
      stateMachine: nextCtx.runtimeContext.stateMachine,
      context: nextCtx.interruptionContext,
      callerText
    });
    nextCtx = {
      ...nextCtx,
      runtimeContext: {
        ...nextCtx.runtimeContext,
        memory: recovery.memory,
        stateMachine: recovery.stateMachine
      },
      interruptionContext: recovery.context,
      recoveryAction: recovery.recoveryAction,
      qualityEvents: [
        ...qualityEvents,
        buildInterruptionContextCapturedEvent({
          config: nextCtx.config,
          payload: {
            recovery_action: recovery.recoveryAction,
            topic_switch_detected: recovery.context.topic_switch_detected,
            detected_product_id: recovery.context.detected_product_id,
            interrupted_product_id: recovery.context.interrupted_product_id
          }
        })
      ]
    };
  } else {
    nextCtx.qualityEvents = qualityEvents;
  }

  nextCtx.bargeInDetector = resetBargeInDetector(nextCtx.bargeInDetector);
  return { ok: true, ctx: nextCtx };
}

export function routeAudioSocketCall(config, input = {}) {
  const canary = canPrepareV4CanaryMedia(config);
  const bargeIn = canPrepareV4BargeIn(config);

  if (!canary) {
    return {
      handler: "v3",
      active: true,
      dropCall: false,
      reason: isV4CanaryEnabled(config) ? "v4_canary_prerequisites_missing" : "default_v3",
      mediaContext: null,
      bargeInReady: false
    };
  }

  if (!input.harnessExplicit) {
    return {
      handler: "v3",
      active: true,
      dropCall: false,
      reason: bargeIn ? "v4_barge_in_stub_production_safe" : "v4_canary_stub_production_safe",
      canaryReady: true,
      bargeInReady: bargeIn,
      mediaContext: null
    };
  }

  const media = bargeIn
    ? createBargeInRuntimeContext(config, input)
    : prepareCanaryMediaContext(config, input);

  return {
    handler: bargeIn ? "v4_canary_barge_in_stub" : "v4_canary_stub",
    active: false,
    dropCall: false,
    reason: media.reason,
    canaryReady: true,
    bargeInReady: bargeIn,
    mediaContext: media
  };
}
