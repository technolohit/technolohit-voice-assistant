/**
 * v4 AudioSocket canary runtime skeleton — Phase 3 foundation only.
 * Does not take over production call handling; test harness must opt in explicitly.
 */

import { createAudioSession } from "./audio-session.js";
import { createVadState } from "./vad-endpointing.js";
import { createSttAdapter } from "./stt-adapter.js";
import { createTtsAdapter } from "./tts-adapter.js";
import { createRuntimeContext } from "./runtime-context.js";

export function isV4CanaryEnabled(config) {
  return Boolean(config?.v4?.canaryEnabled);
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

/**
 * Prepare canary media context. Blocked for production calls unless harnessExplicit=true.
 */
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

  const route = {
    runtime: "v4",
    active: false,
    stub: true,
    canaryReady: true,
    reason: "v4_canary_media_context_test_harness"
  };
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
    reason: "v4_canary_media_context_test_harness",
    canaryReady: true,
    runtimeContext,
    audioSession,
    vadState,
    adapters,
    phase: "phase3_canary_media_stub"
  };
}

/**
 * Route AudioSocket call — always safe for production (delegates to v3 unless harness explicit).
 */
export function routeAudioSocketCall(config, input = {}) {
  const canary = canPrepareV4CanaryMedia(config);

  if (!canary) {
    return {
      handler: "v3",
      active: true,
      dropCall: false,
      reason: isV4CanaryEnabled(config) ? "v4_canary_prerequisites_missing" : "default_v3",
      mediaContext: null
    };
  }

  if (!input.harnessExplicit) {
    return {
      handler: "v3",
      active: true,
      dropCall: false,
      reason: "v4_canary_stub_production_safe",
      canaryReady: true,
      mediaContext: null
    };
  }

  const media = prepareCanaryMediaContext(config, input);
  return {
    handler: "v4_canary_stub",
    active: false,
    dropCall: false,
    reason: media.reason,
    canaryReady: true,
    mediaContext: media
  };
}
