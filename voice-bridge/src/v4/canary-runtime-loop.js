/**
 * v4 canary runtime loop — test-harness dialogue simulation (Phase 5).
 */

import { createRuntimeContext } from "./runtime-context.js";
import { createAudioSession } from "./audio-session.js";
import { createMediaAdaptersFromConfig, canPrepareV4CanaryMedia, observeOutboundFrameForPlayback } from "./audiosocket-runtime.js";
import { createQualityEventSink } from "./quality-event-sink.js";
import {
  createDialogueOrchestrator,
  startCall,
  startTurn,
  acceptUserTranscript,
  decideNextAction,
  prepareAssistantResponse,
  recordAssistantResponse,
  handleInterruption,
  completeTurn,
  closeCall
} from "./dialogue-orchestrator.js";
import {
  createBargeInDetectorFromConfig,
  observeInboundDuringPlayback,
  shouldCancelPlaybackForSpeech,
  markBargeInTriggered
} from "./barge-in-detector.js";
import {
  requestPlaybackCancel,
  finalizePlayback
} from "./playback-controller.js";

export function canPrepareV4Dialogue(config) {
  return canPrepareV4CanaryMedia(config);
}

export function createCanaryDialogueRuntime(config, input = {}) {
  if (!canPrepareV4Dialogue(config)) {
    return {
      ok: false,
      handler: "v3",
      reason: "v4_dialogue_prerequisites_missing"
    };
  }

  if (!input.harnessExplicit) {
    return {
      ok: false,
      handler: "v3",
      reason: "dialogue_harness_not_active_for_production",
      canaryReady: true
    };
  }

  const route = {
    runtime: "v4",
    active: false,
    stub: true,
    canaryReady: true,
    dialogueReady: true,
    reason: "v4_canary_dialogue_test_harness"
  };

  const runtimeContext = createRuntimeContext(config, input, route);
  const qualitySink = createQualityEventSink({
    v4PathActive: true,
    insertFn: input.insertFn ?? null
  });

  const orchestrator = createDialogueOrchestrator({
    config,
    runtimeContext,
    audioSession: createAudioSession({
      bridgeCallId: input.bridgeCallId ?? input.bridge_call_id ?? "canary-dialogue",
      callSessionId: runtimeContext.memory.call_session_id,
      memory: runtimeContext.memory,
      stateMachine: runtimeContext.stateMachine
    }),
    memory: runtimeContext.memory,
    stateMachine: runtimeContext.stateMachine,
    agentConfig: runtimeContext.agentConfig,
    adapters: {
      ...createMediaAdaptersFromConfig(config),
      ragAnswerer: input.ragAnswerer ?? null
    },
    qualitySink,
    v4PathActive: true
  });

  const started = startCall(orchestrator);

  return {
    ok: true,
    handler: "v4_canary_dialogue_stub",
    active: false,
    dropCall: false,
    reason: route.reason,
    canaryReady: true,
    dialogueReady: true,
    phase: "phase5_canary_dialogue",
    config,
    orchestrator,
    runtimeContext,
    qualitySink,
    startResult: started
  };
}

export function simulateInboundTranscriptTurn(runtime, transcript = "") {
  if (!runtime?.orchestrator) {
    return { ok: false, reason: "orchestrator_missing" };
  }

  startTurn(runtime.orchestrator);
  acceptUserTranscript(runtime.orchestrator, transcript);
  const action = decideNextAction(runtime.orchestrator, { transcript });
  const prepared = prepareAssistantResponse(runtime.orchestrator, action.plan);
  const recorded = recordAssistantResponse(
    runtime.orchestrator,
    prepared.text,
    action.plan
  );

  return {
    ok: true,
    plan: action.plan,
    text: recorded.text,
    memory: recorded.memory,
    stateMachine: recorded.stateMachine,
    playback: recorded.playback
  };
}

export function simulateAssistantPlayback(runtime, { frames = 5, bytesPerFrame = 320, atMs = Date.now() } = {}) {
  if (!runtime?.orchestrator?.playback) {
    return { ok: false, reason: "no_active_playback" };
  }

  let ctx = {
    playback: runtime.orchestrator.playback,
    bargeInDetector: runtime.bargeInDetector ?? createBargeInDetectorFromConfig(runtime.config),
    config: runtime.config
  };

  for (let i = 0; i < frames; i += 1) {
    const observed = observeOutboundFrameForPlayback(ctx, { bytes: bytesPerFrame }, atMs + i * 20);
    ctx = observed.ctx;
  }

  runtime.orchestrator.playback = ctx.playback;
  runtime.bargeInDetector = ctx.bargeInDetector;

  return { ok: true, playback: ctx.playback, framesSent: ctx.playback.framesSent };
}

export function simulateBargeInDuringPlayback(runtime, { amplitude = 900, speechFrames = 3, callerText = "" } = {}) {
  if (!runtime?.orchestrator?.playback) {
    return { ok: false, reason: "orchestrator_missing" };
  }

  let detector = runtime.bargeInDetector ?? createBargeInDetectorFromConfig(runtime.config);
  const playback = runtime.orchestrator.playback;
  const minPlaybackMs = detector.minPlaybackMs ?? 0;
  const atBase = Math.max(Date.now(), (playback.startedAt ?? Date.now()) + minPlaybackMs + 1);

  for (let i = 0; i < speechFrames; i += 1) {
    detector = observeInboundDuringPlayback(
      detector,
      makeSpeechFrame(amplitude),
      playback,
      atBase + i * 20
    );
  }

  if (!shouldCancelPlaybackForSpeech(detector, playback, atBase + speechFrames * 20)) {
    return { ok: false, reason: "barge_in_not_triggered" };
  }

  detector = markBargeInTriggered(detector, playback, atBase + speechFrames * 20);
  const cancelledPlayback = finalizePlayback(
    requestPlaybackCancel(playback, "barge_in", atBase + speechFrames * 20).controller,
    "cancelled",
    atBase + speechFrames * 20 + 1
  ).controller;

  runtime.orchestrator.playback = cancelledPlayback;
  runtime.bargeInDetector = detector;

  const interruption = handleInterruption(runtime.orchestrator, {
    callerText,
    playback: cancelledPlayback
  });

  return {
    ok: true,
    cancelled: true,
    interruption,
    detector
  };
}

export function finalizeCanaryTurn(runtime, { callerText = null } = {}) {
  if (!runtime?.orchestrator) {
    return { ok: false, reason: "orchestrator_missing" };
  }

  if (callerText != null && runtime.lastBargeIn) {
    handleInterruption(runtime.orchestrator, { callerText });
  }

  const completed = completeTurn(runtime.orchestrator);
  return {
    ok: true,
    memory: completed.memory,
    stateMachine: completed.stateMachine,
    bufferedEvents: runtime.qualitySink?.getBufferedQualityEvents() ?? []
  };
}

export function closeCanaryDialogueRuntime(runtime) {
  if (!runtime?.orchestrator) {
    return { ok: false, reason: "orchestrator_missing" };
  }
  return closeCall(runtime.orchestrator);
}

export function makeSpeechFrame(amplitude = 900) {
  const buf = Buffer.alloc(320);
  for (let i = 0; i < 160; i += 1) {
    buf.writeInt16LE(amplitude, i * 2);
  }
  return buf;
}

export { pcmFrameRms } from "./pcm-rms.js";
