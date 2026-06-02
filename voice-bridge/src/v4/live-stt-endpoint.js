/**
 * Phase 10C–10E — live v4 STT on VAD endpoint; dialogue + TTS/playback on success.
 */

import { runLiveDialogueOnCallerTranscript } from "./live-dialogue-endpoint.js";
import { runLiveTtsAndPlayback } from "./live-tts-playback-endpoint.js";

import { createSttAdapter } from "./stt-adapter.js";
import {
  createOpenAiEndpointTranscribeFn,
  isLiveOpenAiSttConfigured
} from "./openai-stt-provider.js";
import { redactPhoneLikeText } from "./redaction.js";
import {
  buildSttStartedEvent,
  buildSttCompletedEvent,
  buildSttFinalEvent,
  buildRuntimeErrorEvent
} from "./quality-events.js";

const DEFAULT_LIVE_STT_TIMEOUT_MS = 15000;

export function resolveLiveSttProvider(config) {
  const configured = String(config?.v4?.sttProvider ?? "mock").trim().toLowerCase();
  if (configured !== "openai") {
    return { provider: "mock", openaiActive: false, reason: "provider_mock" };
  }
  if (!isLiveOpenAiSttConfigured(config)) {
    return { provider: "mock", openaiActive: false, reason: "openai_not_configured" };
  }
  return { provider: "openai", openaiActive: true, reason: "openai_live_canary" };
}

export function validateLiveCanarySttProvider(config, options = {}) {
  const resolved = resolveLiveSttProvider(config);
  const provider = resolved.openaiActive ? "openai" : "mock";

  if (provider === "mock" && !options.allowMockStt) {
    return { ok: false, reason: "live_stt_mock_not_allowed", provider };
  }
  if (provider === "openai" && !options.endpointTranscribeFn && !isLiveOpenAiSttConfigured(config, options)) {
    return { ok: false, reason: "openai_stt_not_configured", provider };
  }
  return { ok: true, provider, reason: resolved.reason };
}

export function createLiveSttAdapter(config, options = {}) {
  const resolved = resolveLiveSttProvider(config);
  const provider = resolved.openaiActive ? "openai" : "mock";

  if (provider === "mock" && !options.suppressMockWarning) {
    console.warn(
      "[v4-live] stt_provider=mock live PSTN semantic QA is invalid; set VOICE_V4_STT_PROVIDER=openai for supervised QA"
    );
  } else if (provider === "openai") {
    console.log("[v4-live] stt_provider=openai endpoint_transcription=enabled");
  }

  const adapterOptions = {
    provider,
    enabled: true,
    timeoutMs: DEFAULT_LIVE_STT_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? null
  };

  if (provider === "openai") {
    adapterOptions.endpointTranscribeFn =
      options.endpointTranscribeFn ??
      createOpenAiEndpointTranscribeFn(config, {
        fetchImpl: options.fetchImpl,
        apiKey: options.apiKey
      });
  }

  return createSttAdapter(adapterOptions);
}

async function completeLiveSttTurn(sttAdapter, streamId, options = {}) {
  if (
    sttAdapter.provider === "openai" &&
    typeof sttAdapter.completeSttTurnAsync === "function"
  ) {
    return sttAdapter.completeSttTurnAsync(streamId, options);
  }
  return sttAdapter.completeSttTurn(streamId, options);
}

export function beginUtteranceCapture(runtime, ctx) {
  if (!runtime?.sttAdapter) {
    return { ok: false, reason: "stt_adapter_missing" };
  }

  const streamId = `live-stt-${ctx?.bridgeCallId ?? "pending"}-${runtime.speechStartCount ?? 0}`;
  const started = runtime.sttAdapter.startSttStream({
    streamId,
    language: runtime?.config?.transcription?.language ?? "de"
  });

  if (!started?.ok) {
    runtime.utterance = { capturing: false, frames: [], streamId: null };
    return { ok: false, reason: "stt_stream_start_failed", error: started?.error ?? null };
  }

  runtime.utterance = {
    capturing: true,
    frames: [],
    streamId: started.streamId,
    startedAt: Date.now()
  };

  return { ok: true, streamId: started.streamId };
}

export function appendUtteranceFrame(runtime, payload) {
  if (!runtime?.utterance?.capturing || !payload?.length) {
    return { ok: false, reason: "not_capturing" };
  }

  const frame = Buffer.from(payload);
  runtime.utterance.frames.push(frame);

  if (runtime.sttAdapter && runtime.utterance.streamId) {
    runtime.sttAdapter.appendAudio(runtime.utterance.streamId, frame);
  }

  return { ok: true, frameCount: runtime.utterance.frames.length };
}

function buildLiveSttQualityEvent(config, ctx, runtime, builder, metricValue, payload = {}) {
  return builder({
    config,
    agentConfigResult: runtime?.runtimeContext?.agentConfig ?? null,
    callSessionId: ctx?.callSessionId ?? runtime?.audioSession?.callSessionId ?? null,
    metricValue,
    payload: {
      bridge_call_id: ctx?.bridgeCallId ?? null,
      live_phase: runtime?.phase ?? "phase10c_live_stt",
      ...payload
    }
  });
}

function safeTranscriptPreview(text, maxLen = 48) {
  const redacted = redactPhoneLikeText(text);
  if (!redacted) return "";
  if (redacted.length <= maxLen) return redacted;
  return `${redacted.slice(0, maxLen)}…`;
}

function bufferQualityEvent(runtime, event) {
  if (!runtime || !event) return;
  if (!Array.isArray(runtime.qualityEventsBuffer)) {
    runtime.qualityEventsBuffer = [];
  }
  runtime.qualityEventsBuffer.push(event);
}

/**
 * Finalize utterance at VAD endpoint and run STT once (fail-closed).
 */
export async function runLiveSttOnEndpoint(config, ctx, runtime) {
  const utterance = runtime?.utterance;
  if (!utterance?.capturing) {
    return { ok: false, reason: "utterance_not_capturing" };
  }

  utterance.capturing = false;
  const frameCount = utterance.frames?.length ?? 0;
  const streamId = utterance.streamId;
  const sttStartedAt = Date.now();

  if (!runtime.sttAdapter || !streamId) {
    logSttFailed(ctx, "stt_adapter_unavailable", 0, frameCount);
    resetUtteranceBuffer(runtime);
    return { ok: false, reason: "stt_adapter_unavailable" };
  }

  if (frameCount === 0) {
    runtime.sttAdapter.abortSttStream(streamId, "no_audio");
    logSttFailed(ctx, "no_utterance_audio", 0, frameCount);
    bufferSttErrorEvent(config, ctx, runtime, "no_utterance_audio", 0);
    resetUtteranceBuffer(runtime);
    return { ok: false, reason: "no_utterance_audio" };
  }

  const sttProvider = runtime.sttAdapter.provider ?? "mock";

  bufferQualityEvent(
    runtime,
    buildLiveSttQualityEvent(config, ctx, runtime, buildSttStartedEvent, null, {
      utterance_frames: frameCount,
      stt_provider: sttProvider
    })
  );

  console.log(
    `[v4-live] stt_started stt_provider=${sttProvider} utterance_frames=${frameCount} ${liveLogIds(ctx)}`
  );

  let completed;
  try {
    completed = await completeLiveSttTurn(runtime.sttAdapter, streamId, {
      finalText: undefined
    });
  } catch (err) {
    completed = {
      ok: false,
      error: { code: "stt_exception", message: String(err?.message ?? err) }
    };
  }

  const sttMs = Math.max(0, completed?.sttMs ?? Date.now() - sttStartedAt);

  if (!completed?.ok || !completed?.event) {
    const code = completed?.error?.code ?? "stt_failed";
    logSttFailed(ctx, code, sttMs, frameCount);
    bufferSttErrorEvent(config, ctx, runtime, code, sttMs);
    resetUtteranceBuffer(runtime);
    return { ok: false, reason: code, sttMs };
  }

  const rawText = String(completed.event.text ?? "");
  const redacted = redactPhoneLikeText(rawText);
  const transcriptChars = redacted.length;

  runtime.lastCallerTurnCandidate = {
    ok: true,
    transcript: redacted,
    transcriptChars,
    provider: completed.event.provider ?? runtime.sttAdapter.provider,
    sttMs,
    endpointIndex: runtime.endpointCount ?? 0,
    atMs: Date.now()
  };
  runtime.sttCompletedCount = (runtime.sttCompletedCount ?? 0) + 1;

  bufferQualityEvent(
    runtime,
    buildLiveSttQualityEvent(config, ctx, runtime, buildSttCompletedEvent, sttMs, {
      transcript_chars: transcriptChars,
      utterance_frames: frameCount,
      stt_provider: completed.event.provider ?? sttProvider,
      stt_ok: true
    })
  );
  const transcriptPreview =
    config?.assistant?.logTranscriptPreview === true
      ? { transcript_preview: safeTranscriptPreview(redacted) }
      : {};
  bufferQualityEvent(
    runtime,
    buildLiveSttQualityEvent(config, ctx, runtime, buildSttFinalEvent, sttMs, {
      transcript_chars: transcriptChars,
      stt_provider: completed.event.provider ?? sttProvider,
      ...transcriptPreview
    })
  );

  console.log(
    `[v4-live] stt_completed stt_provider=${completed.event.provider ?? sttProvider} stt_ms=${sttMs} transcript_chars=${transcriptChars} utterance_frames=${frameCount} ${liveLogIds(ctx)}`
  );

  resetUtteranceBuffer(runtime);

  let dialogue = { ok: false, reason: "not_run" };
  try {
    dialogue = await runLiveDialogueOnCallerTranscript(
      config,
      ctx,
      runtime,
      runtime.lastCallerTurnCandidate
    );
  } catch (err) {
    console.warn(
      `[v4-live] dialogue_endpoint_error ${liveLogIds(ctx)} error=${String(err?.message ?? err).slice(0, 120)}`
    );
    dialogue = { ok: false, reason: "dialogue_exception" };
  }

  let playback = { ok: false, reason: "not_run" };
  if (dialogue?.ok) {
    try {
      playback = await runLiveTtsAndPlayback(config, ctx, runtime, dialogue);
    } catch (err) {
      console.warn(
        `[v4-live] tts_playback_endpoint_error ${liveLogIds(ctx)} error=${String(err?.message ?? err).slice(0, 120)}`
      );
      playback = { ok: false, reason: "tts_playback_exception" };
    }
  }

  return {
    ok: true,
    sttMs,
    transcriptChars,
    candidate: runtime.lastCallerTurnCandidate,
    dialogue,
    playback
  };
}

export function resetUtteranceBuffer(runtime) {
  if (!runtime) return;
  runtime.utterance = {
    capturing: false,
    frames: [],
    streamId: null,
    startedAt: null
  };
}

function logSttFailed(ctx, reason, sttMs, frameCount) {
  console.warn(
    `[v4-live] stt_failed reason=${reason} stt_ms=${sttMs} utterance_frames=${frameCount} ${liveLogIds(ctx)}`
  );
}

function bufferSttErrorEvent(config, ctx, runtime, reason, sttMs) {
  bufferQualityEvent(
    runtime,
    buildLiveSttQualityEvent(config, ctx, runtime, buildRuntimeErrorEvent, sttMs, {
      error_class: "stt_failed",
      message: String(reason).slice(0, 120),
      event_subtype: "stt_error",
      stt_provider: runtime?.sttAdapter?.provider ?? "unknown",
      stt_ok: false,
      transcript_chars: 0
    })
  );
}

function liveLogIds(ctx) {
  return `bridge_call_id=${ctx?.bridgeCallId ?? "pending"} call_session_id=${ctx?.callSessionId ?? "pending"}`;
}
