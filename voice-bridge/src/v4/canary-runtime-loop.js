/**
 * v4 canary runtime loop — test-harness dialogue simulation (Phase 5).
 */

import { loadAgentConfig } from "./agent-config.js";
import { createRuntimeContext } from "./runtime-context.js";
import { createAudioSession } from "./audio-session.js";
import { createMediaAdaptersFromConfig, canPrepareV4CanaryMedia, createVadStateFromConfig, observeOutboundFrameForPlayback } from "./audiosocket-runtime.js";
import { createLiveSttAdapter, resetUtteranceBuffer } from "./live-stt-endpoint.js";
import { createLiveTtsAdapter } from "./live-tts-playback-endpoint.js";
import { createQualityEventSink } from "./quality-event-sink.js";
import { createDbQualityEventInsertFn, flushOrchestratorQualityEvents } from "./quality-persistence.js";
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
  const insertFn =
    input.insertFn ??
    (input.persistQualityToDb
      ? createDbQualityEventInsertFn(config, { persistMetadata: runtimeContext.persistMetadata })
      : null);
  const qualitySink = createQualityEventSink({
    v4PathActive: true,
    insertFn
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
      ragAnswerer: input.ragAnswerer ?? null,
      ragRetriever: input.ragRetriever ?? null
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

/**
 * Live AudioSocket canary runtime — Phase 10E TTS/playback on dialogue plan (no barge-in yet).
 * Requires env gates + allowlist match before audiosocket.js selects v4_canary handler.
 */
export function createLiveCanaryRuntime(config, ctx, options = {}) {
  if (!canPrepareV4CanaryMedia(config)) {
    return {
      ok: false,
      handler: "v3",
      reason: "v4_canary_prerequisites_missing"
    };
  }

  const agentConfigResult = loadAgentConfig(config);
  if (!agentConfigResult.ok) {
    return {
      ok: false,
      handler: "v3",
      reason: "agent_config_unavailable",
      error: agentConfigResult.error ?? "agent_config_unavailable"
    };
  }

  let vadState;
  try {
    vadState = createVadStateFromConfig(config);
  } catch (err) {
    return {
      ok: false,
      handler: "v3",
      reason: "vad_state_init_failed",
      error: String(err?.message ?? err)
    };
  }
  if (!vadState) {
    return { ok: false, handler: "v3", reason: "vad_state_init_failed" };
  }

  const route = {
    runtime: "v4",
    active: true,
    stub: false,
    canaryReady: true,
    bargeInReady: Boolean(config?.v4?.bargeInEnabled),
    dialogueReady: true,
    reason: "v4_live_canary_phase10e2"
  };

  const bridgeCallId = ctx?.bridgeCallId ?? ctx?.bridge_call_id ?? "live-pending";
  const callSessionId = ctx?.callSessionId ?? ctx?.call_session_id ?? null;

  const runtimeContext = createRuntimeContext(
    config,
    {
      bridgeCallId,
      callSessionId,
      liveCanary: true
    },
    route
  );

  if (!runtimeContext.agentConfig?.ok) {
    return {
      ok: false,
      handler: "v3",
      reason: "agent_config_unavailable",
      error: runtimeContext.agentConfig?.error ?? "agent_config_unavailable"
    };
  }

  const audioSession = createAudioSession({
    bridgeCallId,
    callSessionId: callSessionId ?? runtimeContext.memory?.call_session_id ?? null,
    sampleRate: config?.sampleRate ?? 8000,
    frameMs: config?.frameMs ?? 20,
    memory: runtimeContext.memory,
    stateMachine: runtimeContext.stateMachine
  });

  if (!audioSession) {
    return { ok: false, handler: "v3", reason: "audio_session_init_failed" };
  }

  const sttAdapter = options.sttAdapter ?? createLiveSttAdapter(config);
  if (!sttAdapter) {
    return { ok: false, handler: "v3", reason: "stt_adapter_init_failed" };
  }

  const ttsAdapter = options.ttsAdapter ?? createLiveTtsAdapter(config, options.liveTtsOptions ?? {});
  if (!ttsAdapter) {
    return { ok: false, handler: "v3", reason: "tts_adapter_init_failed" };
  }

  const runtime = {
    ok: true,
    handler: "v4_canary",
    active: true,
    dropCall: false,
    reason: route.reason,
    phase: "phase10e2_live_real_tts",
    liveCanary: true,
    config,
    runtimeContext,
    audioSession,
    vadState,
    sttAdapter,
    ttsAdapter,
    orchestrator: null,
    utterance: { capturing: false, frames: [], streamId: null, startedAt: null },
    lastCallerTurnCandidate: null,
    lastAssistantPlanCandidate: null,
    lastAssistantPlaybackCandidate: null,
    qualityEventsBuffer: [],
    speechStartCount: 0,
    endpointCount: 0,
    sttCompletedCount: 0,
    dialogueCompletedCount: 0,
    ttsCompletedCount: 0,
    ttsFailedCount: 0,
    playbackCompletedCount: 0,
    lastTtsPlaybackPlanKey: null,
    inboundFrameCount: 0,
    inboundBytes: 0,
    startedAt: null
  };
  resetUtteranceBuffer(runtime);
  return runtime;
}

export async function simulateInboundTranscriptTurn(runtime, transcript = "") {
  if (!runtime?.orchestrator) {
    return { ok: false, reason: "orchestrator_missing" };
  }

  startTurn(runtime.orchestrator);
  acceptUserTranscript(runtime.orchestrator, transcript);
  const action = await decideNextAction(runtime.orchestrator, { transcript });
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

export async function simulateBargeInDuringPlayback(runtime, { amplitude = 900, speechFrames = 3, callerText = "" } = {}) {
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

  const interruption = await handleInterruption(runtime.orchestrator, {
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

export async function finalizeCanaryTurn(runtime, { callerText = null } = {}) {
  if (!runtime?.orchestrator) {
    return { ok: false, reason: "orchestrator_missing" };
  }

  if (callerText != null && runtime.lastBargeIn) {
    await handleInterruption(runtime.orchestrator, { callerText });
  }

  const completed = completeTurn(runtime.orchestrator);
  return {
    ok: true,
    memory: completed.memory,
    stateMachine: completed.stateMachine,
    bufferedEvents: runtime.qualitySink?.getBufferedQualityEvents() ?? []
  };
}

export async function closeCanaryDialogueRuntime(runtime, options = {}) {
  if (!runtime?.orchestrator) {
    return { ok: false, reason: "orchestrator_missing" };
  }
  const closed = closeCall(runtime.orchestrator);
  const qualityFlush = await flushOrchestratorQualityEvents(runtime.orchestrator, {
    v4PostCallMetadata: closed.postCallHandoff?.summaryMetadata ?? null,
    forceV4: options.forceV4 ?? true
  });
  return {
    ...closed,
    qualityFlush,
    qualitySummary: qualityFlush.summary ?? null
  };
}

export function makeSpeechFrame(amplitude = 900) {
  const buf = Buffer.alloc(320);
  for (let i = 0; i < 160; i += 1) {
    buf.writeInt16LE(amplitude, i * 2);
  }
  return buf;
}

export { pcmFrameRms } from "./pcm-rms.js";
