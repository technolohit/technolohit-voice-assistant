/**
 * Phase 10E — live v4 TTS synthesis + AudioSocket playback (no barge-in cancel yet).
 */

import { streamPcmToSocket } from "../media-outbound.js";
import { pcmChunkBytes } from "../audio-media.js";
import { createTtsAdapter } from "./tts-adapter.js";
import { sanitizeResponseText } from "./transcript-intent.js";
import { normalizeText, redactPhoneLikeText } from "./redaction.js";
import { V4_STATES, transitionState } from "./state-machine.js";
import {
  markPlaybackStarted,
  markPlaybackCompleted,
  appendOutboundFrame
} from "./audio-session.js";
import {
  createPlaybackController,
  startPlayback,
  observePlaybackFrameSent,
  finalizePlayback
} from "./playback-controller.js";
import {
  buildTtsStartedEvent,
  buildTtsFirstChunkEvent,
  buildTtsCompletedEvent,
  buildPlaybackStartedEvent,
  buildPlaybackCompletedEvent,
  buildRuntimeErrorEvent
} from "./quality-events.js";

const PHONE_LIKE = /\b(\+?\d[\d\s\-()/]{5,}\d)\b/;
const SAFE_TTS_FALLBACK =
  "Entschuldigung, das habe ich nicht verstanden. Können Sie das bitte kurz wiederholen?";

function liveLogIds(ctx) {
  return `bridge_call_id=${ctx?.bridgeCallId ?? "pending"} call_session_id=${ctx?.callSessionId ?? "pending"}`;
}

function bufferQualityEvent(runtime, event) {
  if (!runtime || !event) return;
  if (!Array.isArray(runtime.qualityEventsBuffer)) {
    runtime.qualityEventsBuffer = [];
  }
  runtime.qualityEventsBuffer.push(event);
}

function buildLiveTtsQualityEvent(config, ctx, runtime, builder, metricValue, payload = {}) {
  return builder({
    config,
    agentConfigResult: runtime?.runtimeContext?.agentConfig ?? null,
    callSessionId: ctx?.callSessionId ?? runtime?.audioSession?.callSessionId ?? null,
    metricValue,
    payload: {
      bridge_call_id: ctx?.bridgeCallId ?? null,
      live_phase: runtime?.phase ?? "phase10e_live_tts_playback",
      ...payload
    }
  });
}

export function createLiveTtsAdapter(config) {
  return createTtsAdapter({
    provider: "mock",
    enabled: true,
    voice: config?.assistant?.ttsVoice ?? "marin",
    model: config?.assistant?.ttsModel ?? "gpt-4o-mini-tts",
    language: config?.transcription?.language ?? "de",
    cacheEnabled: Boolean(config?.v4?.ttsCacheEnabled)
  });
}

export function maxLiveResponseChars(config) {
  return Math.max(80, Number(config?.assistant?.maxResponseChars ?? 180));
}

export function trimLiveResponseText(text, config) {
  const maxChars = maxLiveResponseChars(config);
  const normalized = normalizeText(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trim()}…`;
}

export function containsUnsafeTtsText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return { unsafe: true, reason: "empty_text" };
  if (/\[phone_redacted\]/i.test(normalized)) {
    return { unsafe: true, reason: "phone_redacted_marker" };
  }
  if (PHONE_LIKE.test(normalized)) {
    return { unsafe: true, reason: "phone_like_text" };
  }
  const redacted = redactPhoneLikeText(normalized);
  if (redacted !== normalized) {
    return { unsafe: true, reason: "phone_like_text" };
  }
  return { unsafe: false, reason: null };
}

export function prepareLiveAssistantSpeechText(config, rawText) {
  const sanitized = sanitizeResponseText(rawText);
  const redacted = redactPhoneLikeText(sanitized);
  const safety = containsUnsafeTtsText(redacted);
  if (safety.unsafe) {
    const fallback = trimLiveResponseText(SAFE_TTS_FALLBACK, config);
    return {
      ok: true,
      reason: safety.reason,
      text: fallback,
      usedFallback: true,
      response_chars: fallback.length
    };
  }
  const trimmed = trimLiveResponseText(redacted, config);
  if (!trimmed) {
    return { ok: false, reason: "empty_text", text: null, usedFallback: false, response_chars: 0 };
  }
  return {
    ok: true,
    reason: null,
    text: trimmed,
    usedFallback: false,
    response_chars: trimmed.length
  };
}

function playbackPlanKey(planCandidate) {
  if (!planCandidate) return null;
  return `${planCandidate.endpoint_index ?? "na"}:${planCandidate.turn_index ?? "na"}:${planCandidate.atMs ?? "na"}`;
}

function resolveLiveSocket(ctx, runtime) {
  return ctx?.v4LiveSocket ?? runtime?.liveSocket ?? null;
}

/**
 * Synthesize and play assistant response for a successful dialogue plan (v4_canary only).
 */
export async function runLiveTtsAndPlayback(config, ctx, runtime, dialogueResult = {}) {
  const planCandidate = runtime?.lastAssistantPlanCandidate;
  if (!dialogueResult?.ok || !planCandidate?.ok) {
    return { ok: false, reason: "no_dialogue_plan" };
  }
  if (planCandidate.ttsPlaybackProcessed) {
    return { ok: false, reason: "duplicate_playback" };
  }

  const planKey = playbackPlanKey(planCandidate);
  if (planKey && runtime.lastTtsPlaybackPlanKey === planKey) {
    return { ok: false, reason: "duplicate_playback" };
  }

  const orchestrator = runtime?.orchestrator;
  const hookText = runtime?.liveTtsHooks?.assistantText;
  const rawText =
    hookText != null
      ? String(hookText)
      : String(orchestrator?.lastAssistantText ?? orchestrator?.lastPlan?.text ?? "");

  const prepared = prepareLiveAssistantSpeechText(config, rawText);
  if (!prepared.ok) {
    logTtsFailed(ctx, prepared.reason ?? "unsafe_text");
    bufferQualityEvent(
      runtime,
      buildLiveTtsQualityEvent(config, ctx, runtime, buildRuntimeErrorEvent, null, {
        error_class: "tts_failed",
        message: String(prepared.reason ?? "unsafe_text").slice(0, 120),
        event_subtype: "tts_error"
      })
    );
    planCandidate.ttsPlaybackProcessed = true;
    return { ok: false, reason: prepared.reason ?? "unsafe_text" };
  }

  const speechText = prepared.text;
  if (!speechText) {
    logTtsFailed(ctx, "empty_speech_text");
    planCandidate.ttsPlaybackProcessed = true;
    return { ok: false, reason: "empty_speech_text" };
  }

  if (prepared.usedFallback) {
    console.warn(
      `[v4-live] tts_text_fallback reason=${prepared.reason ?? "unsafe"} response_chars=${prepared.response_chars} ${liveLogIds(ctx)}`
    );
  }

  const ttsAdapter = runtime.ttsAdapter ?? createLiveTtsAdapter(config);
  runtime.ttsAdapter = ttsAdapter;

  if (!ttsAdapter.enabled) {
    logTtsFailed(ctx, "tts_disabled");
    bufferTtsError(config, ctx, runtime, "tts_disabled", null);
    planCandidate.ttsPlaybackProcessed = true;
    return { ok: false, reason: "tts_disabled" };
  }

  console.log(
    `[v4-live] tts_started response_chars=${prepared.response_chars} plan_type=${planCandidate.response_type ?? "unknown"} ${liveLogIds(ctx)}`
  );

  bufferQualityEvent(
    runtime,
    buildLiveTtsQualityEvent(config, ctx, runtime, buildTtsStartedEvent, null, {
      response_type: planCandidate.response_type ?? null,
      response_chars: prepared.response_chars,
      used_fallback: prepared.usedFallback
    })
  );

  const ttsStartedAt = Date.now();
  let synthResult;
  try {
    synthResult = ttsAdapter.synthesizeSentenceChunk(speechText, {
      category: null,
      synthesisId: `live-tts-${planCandidate.turn_index ?? 0}-${runtime.ttsCompletedCount ?? 0}`
    });
  } catch (err) {
    synthResult = {
      ok: false,
      code: "tts_exception",
      message: String(err?.message ?? err)
    };
  }

  const ttsMs = Math.max(0, Date.now() - ttsStartedAt);

  if (!synthResult?.ok || !synthResult?.chunks?.length) {
    const code = synthResult?.code ?? synthResult?.message ?? "tts_failed";
    logTtsFailed(ctx, code);
    bufferTtsError(config, ctx, runtime, code, ttsMs);
    planCandidate.ttsPlaybackProcessed = true;
    runtime.ttsFailedCount = (runtime.ttsFailedCount ?? 0) + 1;
    return { ok: false, reason: code, ttsMs };
  }

  const firstChunkMs = synthResult.firstChunkMs ?? ttsMs;
  bufferQualityEvent(
    runtime,
    buildLiveTtsQualityEvent(config, ctx, runtime, buildTtsFirstChunkEvent, firstChunkMs, {
      from_cache: Boolean(synthResult.fromCache),
      chunk_count: synthResult.chunks.length
    })
  );

  bufferQualityEvent(
    runtime,
    buildLiveTtsQualityEvent(config, ctx, runtime, buildTtsCompletedEvent, ttsMs, {
      from_cache: Boolean(synthResult.fromCache),
      chunk_count: synthResult.chunks.length
    })
  );

  runtime.ttsCompletedCount = (runtime.ttsCompletedCount ?? 0) + 1;
  console.log(
    `[v4-live] tts_completed tts_ms=${ttsMs} first_chunk_ms=${firstChunkMs} chunks=${synthResult.chunks.length} ${liveLogIds(ctx)}`
  );

  const socket = resolveLiveSocket(ctx, runtime);
  if (!socket?.writable) {
    logPlaybackFailed(ctx, "socket_not_writable");
    bufferPlaybackError(config, ctx, runtime, "socket_not_writable", null);
    planCandidate.ttsPlaybackProcessed = true;
    runtime.lastTtsPlaybackPlanKey = planKey;
    runtime.lastAssistantPlaybackCandidate = {
      ok: false,
      reason: "socket_not_writable",
      response_type: planCandidate.response_type ?? null,
      response_chars: prepared.response_chars,
      turn_index: planCandidate.turn_index ?? null,
      tts_ms: ttsMs,
      used_fallback: prepared.usedFallback,
      atMs: Date.now()
    };
    ensureListeningAfterPlayback(runtime);
    return { ok: false, reason: "socket_not_writable", ttsMs, synthesized: true };
  }

  const playbackResult = await streamLiveAssistantPlayback(
    config,
    ctx,
    runtime,
    socket,
    synthResult.chunks,
    planCandidate
  );

  planCandidate.ttsPlaybackProcessed = true;
  runtime.lastTtsPlaybackPlanKey = planKey;

  runtime.lastAssistantPlaybackCandidate = {
    ok: playbackResult.ok,
    reason: playbackResult.reason ?? null,
    response_type: planCandidate.response_type ?? null,
    response_chars: prepared.response_chars,
    turn_index: planCandidate.turn_index ?? null,
    endpoint_index: planCandidate.endpoint_index ?? null,
    tts_ms: ttsMs,
    first_chunk_ms: firstChunkMs,
    frames_sent: playbackResult.framesSent ?? 0,
    bytes_sent: playbackResult.bytesSent ?? 0,
    playback_ms: playbackResult.playbackMs ?? null,
    used_fallback: prepared.usedFallback,
    atMs: Date.now()
  };

  if (!playbackResult.ok) {
    return {
      ok: false,
      reason: playbackResult.reason ?? "playback_failed",
      ttsMs,
      synthesized: true,
      candidate: runtime.lastAssistantPlaybackCandidate
    };
  }

  ensureListeningAfterPlayback(runtime);

  console.log(
    `[v4-live] playback_completed frames=${playbackResult.framesSent ?? 0} bytes=${playbackResult.bytesSent ?? 0} playback_ms=${playbackResult.playbackMs ?? 0} state=${runtime.runtimeContext?.stateMachine?.state ?? "unknown"} ${liveLogIds(ctx)}`
  );

  return {
    ok: true,
    ttsMs,
    playback: playbackResult,
    candidate: runtime.lastAssistantPlaybackCandidate
  };
}

async function streamLiveAssistantPlayback(config, ctx, runtime, socket, chunks, planCandidate) {
  const bridgeCallId = runtime?.runtimeContext?.memory?.bridge_call_id ?? ctx?.bridgeCallId ?? "pending";
  let playbackController = startPlayback(
    createPlaybackController({
      enabled: true,
      bridgeCallId,
      turnIndex: planCandidate?.turn_index ?? null,
      label: planCandidate?.response_type ?? "assistant_response"
    }),
    Date.now()
  ).controller;

  runtime.playback = playbackController;
  const playbackStartedAt = Date.now();
  runtime.audioSession = markPlaybackStarted(runtime.audioSession, playbackStartedAt);

  if (runtime.runtimeContext?.stateMachine) {
    runtime.runtimeContext.stateMachine = transitionState(
      runtime.runtimeContext.stateMachine,
      V4_STATES.SPEAKING,
      "live_tts_playback"
    );
    runtime.runtimeContext.memory = {
      ...runtime.runtimeContext.memory,
      current_state: V4_STATES.SPEAKING,
      updated_at: Date.now()
    };
    if (runtime.orchestrator) {
      runtime.orchestrator.stateMachine = runtime.runtimeContext.stateMachine;
      runtime.orchestrator.memory = runtime.runtimeContext.memory;
    }
  }

  bufferQualityEvent(
    runtime,
    buildLiveTtsQualityEvent(config, ctx, runtime, buildPlaybackStartedEvent, null, {
      response_type: planCandidate?.response_type ?? null
    })
  );

  console.log(
    `[v4-live] playback_started plan_type=${planCandidate?.response_type ?? "unknown"} ${liveLogIds(ctx)}`
  );

  const pcmParts = [];
  for (const chunk of chunks) {
    if (chunk?.audio?.length) {
      pcmParts.push(Buffer.isBuffer(chunk.audio) ? chunk.audio : Buffer.from(chunk.audio));
    }
  }
  const pcm = Buffer.concat(pcmParts);

  if (!pcm.length) {
    logPlaybackFailed(ctx, "empty_pcm");
    bufferPlaybackError(config, ctx, runtime, "empty_pcm", null);
    runtime.playback = finalizePlayback(playbackController, "completed", Date.now()).controller;
    return { ok: false, reason: "empty_pcm", framesSent: 0, bytesSent: 0 };
  }

  try {
    const streamResult = await streamPcmToSocket(socket, pcm, config, "v4_live_assistant");
    const chunkBytes = pcmChunkBytes(config.sampleRate ?? 8000, config.frameMs ?? 20);
    const frameEstimate = Math.max(1, Math.ceil(pcm.length / chunkBytes));
    const framesSent = streamResult?.frames ?? frameEstimate;
    const bytesSent = streamResult?.bytes ?? pcm.length;

    for (let i = 0; i < framesSent; i += 1) {
      const observed = observePlaybackFrameSent(playbackController, { bytes: chunkBytes });
      playbackController = observed.controller;
      runtime.audioSession = appendOutboundFrame(runtime.audioSession, { bytes: chunkBytes });
    }

    playbackController = finalizePlayback(playbackController, "completed", Date.now()).controller;
    runtime.playback = playbackController;
    runtime.audioSession = markPlaybackCompleted(runtime.audioSession, Date.now());
    runtime.playbackCompletedCount = (runtime.playbackCompletedCount ?? 0) + 1;

    const playbackMs = Math.max(0, Date.now() - playbackStartedAt);
    bufferQualityEvent(
      runtime,
      buildLiveTtsQualityEvent(config, ctx, runtime, buildPlaybackCompletedEvent, playbackMs, {
        frames_sent: framesSent,
        bytes_sent: bytesSent
      })
    );

    return {
      ok: true,
      framesSent,
      bytesSent,
      playbackMs,
      playbackController
    };
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 120);
    logPlaybackFailed(ctx, message);
    bufferPlaybackError(config, ctx, runtime, message, Date.now() - playbackStartedAt);
    runtime.playback = finalizePlayback(playbackController, "completed", Date.now()).controller;
    runtime.audioSession = markPlaybackCompleted(runtime.audioSession, Date.now());
    return { ok: false, reason: "playback_exception", error: message, framesSent: 0, bytesSent: 0 };
  }
}

function ensureListeningAfterPlayback(runtime) {
  if (!runtime?.runtimeContext?.stateMachine) return;
  runtime.runtimeContext.stateMachine = transitionState(
    runtime.runtimeContext.stateMachine,
    V4_STATES.LISTENING,
    "playback_complete"
  );
  runtime.runtimeContext.memory = {
    ...runtime.runtimeContext.memory,
    current_state: V4_STATES.LISTENING,
    updated_at: Date.now()
  };
  if (runtime.orchestrator) {
    runtime.orchestrator.stateMachine = runtime.runtimeContext.stateMachine;
    runtime.orchestrator.memory = runtime.runtimeContext.memory;
  }
}

function logTtsFailed(ctx, reason) {
  console.warn(`[v4-live] tts_failed reason=${String(reason).slice(0, 120)} ${liveLogIds(ctx)}`);
}

function logPlaybackFailed(ctx, reason) {
  console.warn(`[v4-live] playback_failed reason=${String(reason).slice(0, 120)} ${liveLogIds(ctx)}`);
}

function bufferTtsError(config, ctx, runtime, reason, ttsMs) {
  bufferQualityEvent(
    runtime,
    buildLiveTtsQualityEvent(config, ctx, runtime, buildRuntimeErrorEvent, ttsMs, {
      error_class: "tts_failed",
      message: String(reason).slice(0, 120),
      event_subtype: "tts_error"
    })
  );
}

function bufferPlaybackError(config, ctx, runtime, reason, metricValue) {
  bufferQualityEvent(
    runtime,
    buildLiveTtsQualityEvent(config, ctx, runtime, buildRuntimeErrorEvent, metricValue, {
      error_class: "playback_failed",
      message: String(reason).slice(0, 120),
      event_subtype: "playback_error"
    })
  );
}
