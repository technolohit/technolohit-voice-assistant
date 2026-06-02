/**
 * v4 streaming/incremental STT adapter — provider-neutral interface (Phase 3 foundation).
 * Mock provider by default; OpenAI path is placeholder-only (no live calls without injection).
 */

const STREAM_STATUS = {
  IDLE: "idle",
  ACTIVE: "active",
  COMPLETING: "completing",
  ABORTED: "aborted",
  ERROR: "error"
};

let streamCounter = 0;

export function createPartialTranscriptEvent({
  streamId,
  text,
  confidence = null,
  provider = "mock",
  timestampMs = Date.now(),
  sequence = 0
}) {
  return {
    type: "stt_partial",
    streamId: String(streamId),
    text: String(text ?? ""),
    confidence: confidence == null ? null : Number(confidence),
    isFinal: false,
    provider: String(provider),
    timestampMs: Number(timestampMs) || Date.now(),
    sequence: Number(sequence) || 0
  };
}

export function createFinalTranscriptEvent({
  streamId,
  text,
  confidence = null,
  provider = "mock",
  durationMs = null,
  timestampMs = Date.now()
}) {
  return {
    type: "stt_final",
    streamId: String(streamId),
    text: String(text ?? ""),
    confidence: confidence == null ? null : Number(confidence),
    isFinal: true,
    provider: String(provider),
    durationMs: durationMs == null ? null : Number(durationMs),
    timestampMs: Number(timestampMs) || Date.now()
  };
}

export function createSttErrorEvent({
  streamId,
  code = "stt_error",
  message = "STT failed",
  recoverable = false,
  provider = "mock"
}) {
  return {
    type: "stt_error",
    streamId: streamId ? String(streamId) : null,
    code: String(code),
    message: String(message),
    recoverable: Boolean(recoverable),
    provider: String(provider)
  };
}

export function createSttAdapter({
  provider = "mock",
  enabled = false,
  maxBufferedFrames = 500,
  timeoutMs = 15000,
  fetchImpl = null,
  endpointTranscribeFn = null
} = {}) {
  const resolvedProvider = String(provider ?? "mock").trim().toLowerCase();
  const streams = new Map();
  const metrics = {
    streams_started: 0,
    streams_completed: 0,
    streams_aborted: 0,
    streams_errored: 0,
    partial_events: 0,
    final_events: 0,
    backpressure_waits: 0
  };

  return {
    provider: resolvedProvider,
    enabled: Boolean(enabled),
    phase: "phase3_stt_adapter",
    metrics,
    startSttStream(options = {}) {
      if (!this.enabled) {
        return {
          ok: false,
          error: createSttErrorEvent({
            code: "stt_disabled",
            message: "STT adapter disabled",
            recoverable: false,
            provider: resolvedProvider
          })
        };
      }

      streamCounter += 1;
      const streamId = String(options.streamId ?? `stt-${streamCounter}`);
      const startedAt = Date.now();
      const stream = {
        streamId,
        status: STREAM_STATUS.ACTIVE,
        startedAt,
        frames: [],
        partialText: "",
        onPartial: typeof options.onPartial === "function" ? options.onPartial : null,
        onFinal: typeof options.onFinal === "function" ? options.onFinal : null,
        onError: typeof options.onError === "function" ? options.onError : null,
        language: options.language ?? "de",
        maxBufferedFrames: Math.max(10, Number(maxBufferedFrames) || 500)
      };
      streams.set(streamId, stream);
      metrics.streams_started += 1;

      return {
        ok: true,
        streamId,
        provider: resolvedProvider,
        metadata: {
          language: stream.language,
          timeout_ms: timeoutMs
        }
      };
    },
    appendAudio(streamId, frame) {
      const stream = streams.get(String(streamId));
      if (!stream || stream.status !== STREAM_STATUS.ACTIVE) {
        return {
          ok: false,
          error: createSttErrorEvent({
            streamId,
            code: "stream_not_active",
            message: "STT stream is not active",
            recoverable: false,
            provider: resolvedProvider
          })
        };
      }

      if (stream.frames.length >= stream.maxBufferedFrames) {
        metrics.backpressure_waits += 1;
        return {
          ok: false,
          backpressure: true,
          error: createSttErrorEvent({
            streamId,
            code: "backpressure",
            message: "STT buffer full",
            recoverable: true,
            provider: resolvedProvider
          })
        };
      }

      stream.frames.push(frame ?? null);
      if (resolvedProvider === "mock") {
        const partial = createPartialTranscriptEvent({
          streamId,
          text: `[partial:${stream.frames.length}]`,
          provider: "mock",
          sequence: stream.frames.length
        });
        stream.partialText = partial.text;
        metrics.partial_events += 1;
        stream.onPartial?.(partial);
        return { ok: true, partial };
      }

      if (resolvedProvider === "openai") {
        if (!fetchImpl && typeof endpointTranscribeFn !== "function") {
          const err = createSttErrorEvent({
            streamId,
            code: "openai_not_configured",
            message: "OpenAI STT requires endpointTranscribeFn or injected fetchImpl",
            recoverable: false,
            provider: "openai"
          });
          stream.status = STREAM_STATUS.ERROR;
          metrics.streams_errored += 1;
          stream.onError?.(err);
          return { ok: false, error: err };
        }
      }

      return { ok: true, bufferedFrames: stream.frames.length };
    },
    completeSttTurn(streamId, options = {}) {
      if (resolvedProvider === "openai") {
        return {
          ok: false,
          error: createSttErrorEvent({
            streamId,
            code: "use_complete_async",
            message: "OpenAI STT requires completeSttTurnAsync",
            recoverable: false,
            provider: resolvedProvider
          })
        };
      }
      return this._finalizeSttTurn(streamId, options);
    },
    async completeSttTurnAsync(streamId, options = {}) {
      const stream = streams.get(String(streamId));
      if (!stream) {
        return {
          ok: false,
          error: createSttErrorEvent({
            streamId,
            code: "stream_not_found",
            message: "STT stream not found",
            recoverable: false,
            provider: resolvedProvider
          })
        };
      }
      if (stream.status === STREAM_STATUS.ABORTED) {
        return {
          ok: false,
          error: createSttErrorEvent({
            streamId,
            code: "stream_aborted",
            message: "STT stream was aborted",
            recoverable: false,
            provider: resolvedProvider
          })
        };
      }

      if (resolvedProvider === "openai") {
        const transcribe = endpointTranscribeFn;
        if (typeof transcribe !== "function") {
          const err = createSttErrorEvent({
            streamId,
            code: "openai_not_configured",
            message: "OpenAI endpoint STT requires endpointTranscribeFn",
            recoverable: false,
            provider: "openai"
          });
          stream.status = STREAM_STATUS.ERROR;
          metrics.streams_errored += 1;
          stream.onError?.(err);
          return { ok: false, error: err };
        }

        stream.status = STREAM_STATUS.COMPLETING;
        const pcm = Buffer.concat(
          stream.frames.filter((f) => f?.length).map((f) => (Buffer.isBuffer(f) ? f : Buffer.from(f)))
        );
        const frameCount = stream.frames.length;
        const result = await transcribe(pcm, {
          language: stream.language,
          streamId,
          frameCount,
          frame_count: frameCount
        });
        if (!result?.ok) {
          const err = createSttErrorEvent({
            streamId,
            code: result?.code ?? "stt_failed",
            message: result?.message ?? "OpenAI STT failed",
            recoverable: false,
            provider: "openai"
          });
          stream.status = STREAM_STATUS.ERROR;
          metrics.streams_errored += 1;
          stream.onError?.(err);
          streams.delete(String(streamId));
          return {
            ok: false,
            error: err,
            sttMs: result?.sttMs ?? null,
            diagnostics: {
              ...(result?.diagnostics ?? {}),
              stt_error_code: result?.errorCode ?? result?.diagnostics?.stt_error_code ?? result?.code ?? null,
              stt_http_status: result?.httpStatus ?? result?.diagnostics?.stt_http_status ?? null,
              stt_error_type: result?.errorType ?? result?.diagnostics?.stt_error_type ?? null,
              utterance_frames: frameCount
            }
          };
        }

        const durationMs = result.sttMs ?? Date.now() - stream.startedAt;
        const finalEvent = createFinalTranscriptEvent({
          streamId,
          text: options.finalText ?? result.text,
          provider: "openai",
          durationMs,
          confidence: options.confidence ?? null
        });
        metrics.final_events += 1;
        metrics.streams_completed += 1;
        stream.onFinal?.(finalEvent);
        streams.delete(String(streamId));
        return { ok: true, event: finalEvent, sttMs: durationMs };
      }

      return this._finalizeSttTurn(streamId, options);
    },
    _finalizeSttTurn(streamId, options = {}) {
      const stream = streams.get(String(streamId));
      if (!stream) {
        return {
          ok: false,
          error: createSttErrorEvent({
            streamId,
            code: "stream_not_found",
            message: "STT stream not found",
            recoverable: false,
            provider: resolvedProvider
          })
        };
      }
      if (stream.status === STREAM_STATUS.ABORTED) {
        return {
          ok: false,
          error: createSttErrorEvent({
            streamId,
            code: "stream_aborted",
            message: "STT stream was aborted",
            recoverable: false,
            provider: resolvedProvider
          })
        };
      }

      stream.status = STREAM_STATUS.COMPLETING;
      const durationMs = Date.now() - stream.startedAt;
      const finalText =
        options.finalText ??
        (resolvedProvider === "mock"
          ? `mock-final-${stream.frames.length}-frames`
          : "");
      const finalEvent = createFinalTranscriptEvent({
        streamId,
        text: finalText,
        provider: resolvedProvider,
        durationMs,
        confidence: options.confidence ?? null
      });
      metrics.final_events += 1;
      metrics.streams_completed += 1;
      stream.onFinal?.(finalEvent);
      streams.delete(String(streamId));
      return { ok: true, event: finalEvent, sttMs: durationMs };
    },
    abortSttStream(streamId, reason = "aborted") {
      const stream = streams.get(String(streamId));
      if (!stream) {
        return { ok: true, alreadyAborted: true };
      }
      stream.status = STREAM_STATUS.ABORTED;
      metrics.streams_aborted += 1;
      streams.delete(String(streamId));
      return { ok: true, streamId: String(streamId), reason: String(reason) };
    },
    getSttMetrics() {
      return {
        provider: resolvedProvider,
        enabled: Boolean(enabled),
        active_streams: [...streams.values()].filter((s) => s.status === STREAM_STATUS.ACTIVE)
          .length,
        ...metrics
      };
    }
  };
}

export function isStreamingSttEnabled(config) {
  return Boolean(config?.v4?.streamingSttEnabled);
}

/** @deprecated Phase 1 alias */
export function createSttAdapterStub(options = {}) {
  return createSttAdapter({ ...options, provider: options.provider ?? "mock" });
}
