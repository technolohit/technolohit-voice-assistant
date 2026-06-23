/**
 * Phase 10E/10E2/10F — live v4 TTS synthesis + AudioSocket playback with barge-in cancel.
 */

import { encodeFrame, FrameType } from "../audiosocket-protocol.js";
import { iteratePcmChunks, pcmChunkBytes } from "../audio-media.js";
import { startSilenceWriter, stopSilenceWriter } from "../media-outbound.js";
import { createTtsAdapter } from "./tts-adapter.js";
import { createOpenAiTtsSynthesizeFn, isLiveOpenAiTtsConfigured } from "./openai-tts-provider.js";
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
  buildRuntimeErrorEvent,
  buildTurnLatencyMetricsEvent
} from "./quality-events.js";
import {
  createLivePlaybackCancelSession,
  finalizeLivePlaybackAfterStream
} from "./live-barge-in-endpoint.js";
import {
  markLiveTurnLatency,
  finalizeLiveTurnLatencyMetrics
} from "./live-turn-latency.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeFrame(socket, type, payload) {
  return new Promise((resolve, reject) => {
    const frame = encodeFrame(type, payload);
    const ok = socket.write(frame);
    if (ok) return resolve();
    socket.once("drain", resolve);
    socket.once("error", reject);
  });
}

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
      live_phase: runtime?.phase ?? "phase10f_live_barge_in",
      ...payload
    }
  });
}

export function resolveLiveTtsProvider(config) {
  const configured = String(config?.v4?.ttsProvider ?? "mock").trim().toLowerCase();
  if (configured !== "openai") {
    return { provider: "mock", openaiActive: false, reason: "provider_mock" };
  }
  if (!isLiveOpenAiTtsConfigured(config)) {
    return { provider: "mock", openaiActive: false, reason: "openai_not_configured" };
  }
  return { provider: "openai", openaiActive: true, reason: "openai_live_canary" };
}

export function createLiveTtsAdapter(config, options = {}) {
  const resolved = resolveLiveTtsProvider(config);
  const voice = config?.assistant?.ttsVoice ?? "marin";
  const model = config?.assistant?.ttsModel ?? "gpt-4o-mini-tts";
  const language = config?.transcription?.language ?? "de";

  if (resolved.openaiActive) {
    return createTtsAdapter({
      provider: "openai",
      enabled: true,
      voice,
      model,
      language,
      cacheEnabled: false,
      synthesizeImplAsync:
        options.synthesizeImplAsync ??
        createOpenAiTtsSynthesizeFn(config, {
          fetchImpl: options.fetchImpl,
          execFileImpl: options.execFileImpl,
          apiKey: options.apiKey
        })
    });
  }

  return createTtsAdapter({
    provider: "mock",
    enabled: true,
    voice,
    model,
    language,
    cacheEnabled: Boolean(config?.v4?.ttsCacheEnabled)
  });
}

async function synthesizeLiveSpeech(ttsAdapter, speechText, options = {}) {
  if (typeof ttsAdapter.synthesizeSentenceChunkAsync === "function") {
    return ttsAdapter.synthesizeSentenceChunkAsync(speechText, options);
  }
  return ttsAdapter.synthesizeSentenceChunk(speechText, options);
}

export function maxLiveResponseChars(config, options = {}) {
  const override = Number(options?.maxChars ?? NaN);
  if (Number.isFinite(override) && override > 0) {
    return Math.max(80, Math.min(320, override));
  }
  return Math.max(80, Number(config?.assistant?.maxResponseChars ?? 180));
}

export function trimLiveResponseText(text, config, options = {}) {
  const maxChars = maxLiveResponseChars(config, options);
  const normalized = normalizeText(text);
  if (normalized.length <= maxChars) return normalized;

  const sentenceMatches = normalized.match(/[^.!?]+[.!?]+/g);
  if (sentenceMatches?.length) {
    let acc = "";
    for (const sentence of sentenceMatches) {
      const candidate = acc ? `${acc} ${sentence.trim()}` : sentence.trim();
      if (candidate.length <= maxChars) {
        acc = candidate;
        continue;
      }
      if (acc) return acc;
      break;
    }
    if (acc) return acc;
  }

  const slice = normalized.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > Math.floor(maxChars * 0.6)) {
    return `${slice.slice(0, lastSpace).trim()}…`;
  }
  return `${slice.trim()}…`;
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

export function prepareLiveAssistantSpeechText(config, rawText, options = {}) {
  const sanitized = sanitizeResponseText(rawText);
  const redacted = redactPhoneLikeText(sanitized);
  const safety = containsUnsafeTtsText(redacted);
  if (safety.unsafe) {
    const fallback = trimLiveResponseText(SAFE_TTS_FALLBACK, config, options);
    return {
      ok: true,
      reason: safety.reason,
      text: fallback,
      usedFallback: true,
      response_chars: fallback.length
    };
  }
  const trimmed = trimLiveResponseText(redacted, config, options);
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

function isClosingPlayback(runtime, planCandidate) {
  return (
    planCandidate?.response_type === "closing" ||
    Boolean(runtime?.runtimeContext?.memory?.call_closing) ||
    runtime?.runtimeContext?.stateMachine?.state === V4_STATES.COMPLETED
  );
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
  if (runtime.playbackInFlight) {
    return { ok: false, reason: "playback_in_flight" };
  }

  const orchestrator = runtime?.orchestrator;
  const hookText = runtime?.liveTtsHooks?.assistantText;
  const rawText =
    hookText != null
      ? String(hookText)
      : String(orchestrator?.lastAssistantText ?? orchestrator?.lastPlan?.text ?? "");

  const prepared = prepareLiveAssistantSpeechText(config, rawText, {
    maxChars: orchestrator?.lastPlan?.max_spoken_chars ?? null
  });
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
    `[v4-live] tts_started provider=${ttsAdapter.provider} response_chars=${prepared.response_chars} plan_type=${planCandidate.response_type ?? "unknown"} ${liveLogIds(ctx)}`
  );

  markLiveTurnLatency(runtime, "tts_started");

  bufferQualityEvent(
    runtime,
    buildLiveTtsQualityEvent(config, ctx, runtime, buildTtsStartedEvent, null, {
      response_type: planCandidate.response_type ?? null,
      response_chars: prepared.response_chars,
      used_fallback: prepared.usedFallback,
      tts_provider: ttsAdapter.provider
    })
  );

  const ttsStartedAt = Date.now();
  let synthResult;
  try {
    synthResult = await synthesizeLiveSpeech(ttsAdapter, speechText, {
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
  const firstChunkAt = ttsStartedAt + Math.max(0, Number(firstChunkMs) || 0);
  markLiveTurnLatency(runtime, "tts_first_chunk", firstChunkAt);
  markLiveTurnLatency(runtime, "tts_completed", ttsStartedAt + Math.max(0, Number(ttsMs) || 0));
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
    `[v4-live] tts_completed provider=${ttsAdapter.provider} tts_ms=${ttsMs} first_chunk_ms=${firstChunkMs} chunks=${synthResult.chunks.length} pcm_bytes=${synthResult.chunks.reduce((n, c) => n + (c?.audio?.length ?? 0), 0)} ${liveLogIds(ctx)}`
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
    if (!isClosingPlayback(runtime, planCandidate)) {
      ensureListeningAfterPlayback(runtime);
    }
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
    tts_provider: ttsAdapter.provider,
    atMs: Date.now()
  };

  if (!playbackResult.ok && !playbackResult.cancelled) {
    return {
      ok: false,
      reason: playbackResult.reason ?? "playback_failed",
      ttsMs,
      synthesized: true,
      candidate: runtime.lastAssistantPlaybackCandidate
    };
  }

  if (playbackResult.cancelled) {
    runtime.lastAssistantPlaybackCandidate = {
      ...runtime.lastAssistantPlaybackCandidate,
      cancelled: true,
      frames_sent: playbackResult.framesSent ?? 0,
      bytes_sent: playbackResult.bytesSent ?? 0
    };
    return {
      ok: true,
      ttsMs,
      playback: playbackResult,
      cancelled: true,
      candidate: runtime.lastAssistantPlaybackCandidate
    };
  }

  if (!isClosingPlayback(runtime, planCandidate)) {
    ensureListeningAfterPlayback(runtime);
  }

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

  const closingPlayback = isClosingPlayback(runtime, planCandidate);
  if (runtime.runtimeContext?.stateMachine && !closingPlayback) {
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
  } else if (runtime.runtimeContext?.memory && closingPlayback) {
    runtime.runtimeContext.memory = {
      ...runtime.runtimeContext.memory,
      current_state: V4_STATES.COMPLETED,
      updated_at: Date.now()
    };
    if (runtime.orchestrator) {
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

  markLiveTurnLatency(runtime, "playback_started");

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

  runtime.livePlaybackSession = createLivePlaybackCancelSession();
  runtime.playbackInFlight = true;

  const hadSilenceWriter = Boolean(ctx?.silenceTimer);
  if (hadSilenceWriter) {
    stopSilenceWriter(ctx);
    console.log(`[v4-live] silence_writer_paused reason=assistant_playback ${liveLogIds(ctx)}`);
  }

  const chunkBytes = pcmChunkBytes(config.sampleRate ?? 8000, config.frameMs ?? 20);
  const frameType = FrameType.AUDIO_SLIN16_8K;
  let framesSent = 0;
  let bytesSent = 0;

  try {
    for (const chunk of iteratePcmChunks(pcm, chunkBytes)) {
      if (!socket.writable) break;
      if (runtime.livePlaybackSession?.cancelled) break;

      await writeFrame(socket, frameType, chunk);
      framesSent += 1;
      bytesSent += chunk.length;

      const observed = observePlaybackFrameSent(playbackController, { bytes: chunk.length });
      playbackController = observed.controller;
      runtime.playback = playbackController;
      runtime.livePlaybackSession.framesSent = framesSent;
      runtime.livePlaybackSession.bytesSent = bytesSent;
      runtime.audioSession = appendOutboundFrame(runtime.audioSession, { bytes: chunk.length });

      if (runtime.livePlaybackSession?.cancelled) break;
      await sleep(config.frameMs ?? 20);
    }

    const streamOutcome = {
      frames: framesSent,
      bytes: bytesSent,
      cancelled: Boolean(runtime.livePlaybackSession?.cancelled)
    };

    const finalized = finalizeLivePlaybackAfterStream(
      config,
      ctx,
      runtime,
      playbackController,
      streamOutcome
    );

    if (!finalized.cancelled) {
      runtime.audioSession = markPlaybackCompleted(runtime.audioSession, Date.now());
      runtime.playbackCompletedCount = (runtime.playbackCompletedCount ?? 0) + 1;
      const playbackMs = Math.max(0, Date.now() - playbackStartedAt);
      markLiveTurnLatency(runtime, "playback_completed");
      const turnLatency = finalizeLiveTurnLatencyMetrics(runtime);
      if (turnLatency) {
        bufferQualityEvent(
          runtime,
          buildLiveTtsQualityEvent(
            config,
            ctx,
            runtime,
            buildTurnLatencyMetricsEvent,
            turnLatency.total_turn_response_ms,
            turnLatency
          )
        );
      }
      bufferQualityEvent(
        runtime,
        buildLiveTtsQualityEvent(config, ctx, runtime, buildPlaybackCompletedEvent, playbackMs, {
          frames_sent: finalized.framesSent,
          bytes_sent: finalized.bytesSent
        })
      );
      return {
        ok: true,
        framesSent: finalized.framesSent,
        bytesSent: finalized.bytesSent,
        playbackMs,
        playbackController: runtime.playback,
        cancelled: false
      };
    }

    return {
      ok: true,
      cancelled: true,
      framesSent: finalized.framesSent,
      bytesSent: finalized.bytesSent,
      playbackMs: Math.max(0, Date.now() - playbackStartedAt),
      playbackController: runtime.playback
    };
  } catch (err) {
    runtime.playbackInFlight = false;
    const message = String(err?.message ?? err).slice(0, 120);
    logPlaybackFailed(ctx, message);
    bufferPlaybackError(config, ctx, runtime, message, Date.now() - playbackStartedAt);
    runtime.playback = finalizePlayback(playbackController, "completed", Date.now()).controller;
    runtime.audioSession = markPlaybackCompleted(runtime.audioSession, Date.now());
    runtime.playbackInFlight = false;
    return { ok: false, reason: "playback_exception", error: message, framesSent: 0, bytesSent: 0 };
  } finally {
    runtime.playbackInFlight = false;
    if (hadSilenceWriter && socket?.writable && !ctx?.closed) {
      startSilenceWriter(config, ctx, socket);
      console.log(`[v4-live] silence_writer_resumed reason=assistant_playback_done ${liveLogIds(ctx)}`);
    }
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
