/**
 * v4 streaming/low-latency TTS adapter — sentence-chunk foundation (Phase 3).
 */

import {
  buildCacheKey,
  createTtsPhraseCache,
  shouldCachePhrase
} from "./tts-cache.js";

const TTS_STATUS = {
  IDLE: "idle",
  SYNTHESIZING: "synthesizing",
  STREAMING: "streaming",
  ABORTED: "aborted",
  ERROR: "error"
};

let synthCounter = 0;

export function createTtsChunkEvent({
  synthesisId,
  chunkIndex,
  audio,
  sampleRate = 8000,
  isFirst = false,
  isFinal = false,
  provider = "mock"
}) {
  return {
    type: "tts_chunk",
    synthesisId: String(synthesisId),
    chunkIndex: Number(chunkIndex) || 0,
    audio: audio ?? null,
    sampleRate: Number(sampleRate) || 8000,
    isFirst: Boolean(isFirst),
    isFinal: Boolean(isFinal),
    provider: String(provider)
  };
}

export function createTtsAdapter({
  provider = "mock",
  enabled = false,
  voice = "marin",
  model = "gpt-4o-mini-tts",
  language = "de",
  cache = null,
  cacheEnabled = true,
  synthesizeImpl = null
} = {}) {
  const resolvedProvider = String(provider ?? "mock").trim().toLowerCase();
  const phraseCache = cache ?? createTtsPhraseCache();
  const metrics = {
    syntheses_started: 0,
    syntheses_completed: 0,
    syntheses_aborted: 0,
    cache_hits: 0,
    cache_misses: 0,
    first_chunk_ms_total: 0,
    first_chunk_count: 0
  };
  let activeSynth = null;

  return {
    provider: resolvedProvider,
    enabled: Boolean(enabled),
    voice,
    model,
    language,
    phase: "phase3_tts_adapter",
    cache: phraseCache,
    metrics,
    synthesizeSentenceChunk(text, options = {}) {
      if (!this.enabled) {
        return {
          ok: false,
          code: "tts_disabled",
          message: "TTS adapter disabled"
        };
      }

      synthCounter += 1;
      const synthesisId = String(options.synthesisId ?? `tts-${synthCounter}`);
      const category = options.category ?? null;
      const normalizedText = String(text ?? "").trim();
      if (!normalizedText) {
        return { ok: false, code: "empty_text", message: "TTS text required" };
      }

      metrics.syntheses_started += 1;
      activeSynth = { synthesisId, status: TTS_STATUS.SYNTHESIZING, startedAt: Date.now() };

      const cacheKeyParts = {
        voice: options.voice ?? voice,
        model: options.model ?? model,
        language: options.language ?? language,
        text: normalizedText
      };
      const cacheDecision = shouldCachePhrase(normalizedText, category);
      if (cacheEnabled && cacheDecision.cacheable) {
        const cached = phraseCache.getCachedPhrase(cacheKeyParts);
        if (cached?.audio) {
          metrics.cache_hits += 1;
          metrics.syntheses_completed += 1;
          activeSynth = null;
          return {
            ok: true,
            synthesisId,
            fromCache: true,
            chunks: [
              createTtsChunkEvent({
                synthesisId,
                chunkIndex: 0,
                audio: cached.audio,
                sampleRate: cached.sample_rate,
                isFirst: true,
                isFinal: true,
                provider: resolvedProvider
              })
            ]
          };
        }
        metrics.cache_misses += 1;
      }

      if (resolvedProvider === "openai" && !synthesizeImpl) {
        activeSynth = null;
        return {
          ok: false,
          code: "openai_not_configured",
          message: "OpenAI TTS requires injected synthesizeImpl in tests"
        };
      }

      const started = Date.now();
      const chunkAudio = synthesizeImpl
        ? synthesizeImpl(normalizedText, options)
        : Buffer.from(`mock-tts:${normalizedText.length}`, "utf8");
      const firstChunkMs = Date.now() - started;
      metrics.first_chunk_ms_total += firstChunkMs;
      metrics.first_chunk_count += 1;

      const chunk = createTtsChunkEvent({
        synthesisId,
        chunkIndex: 0,
        audio: chunkAudio,
        isFirst: true,
        isFinal: true,
        provider: resolvedProvider
      });

      if (cacheEnabled && cacheDecision.cacheable) {
        phraseCache.putCachedPhrase(cacheKeyParts, { audio: chunkAudio, sampleRate: 8000 }, {
          text: normalizedText,
          category
        });
      }

      metrics.syntheses_completed += 1;
      activeSynth = null;
      return {
        ok: true,
        synthesisId,
        fromCache: false,
        firstChunkMs,
        chunks: [chunk]
      };
    },
    async *streamTtsChunks(text, options = {}) {
      const result = this.synthesizeSentenceChunk(text, options);
      if (!result.ok) {
        yield { ok: false, error: result };
        return;
      }
      for (const chunk of result.chunks ?? []) {
        yield { ok: true, chunk, fromCache: result.fromCache ?? false };
      }
    },
    abortTts(reason = "aborted") {
      if (!activeSynth) {
        return { ok: true, aborted: false, reason: "no_active_synthesis" };
      }
      const synthesisId = activeSynth.synthesisId;
      activeSynth.status = TTS_STATUS.ABORTED;
      metrics.syntheses_aborted += 1;
      activeSynth = null;
      return { ok: true, aborted: true, synthesisId, reason: String(reason) };
    },
    getTtsMetrics() {
      const avgFirstChunkMs =
        metrics.first_chunk_count > 0
          ? Math.round(metrics.first_chunk_ms_total / metrics.first_chunk_count)
          : null;
      return {
        provider: resolvedProvider,
        enabled: Boolean(enabled),
        cache_enabled: Boolean(cacheEnabled),
        cache_size: phraseCache.size?.() ?? 0,
        avg_first_chunk_ms: avgFirstChunkMs,
        ...metrics
      };
    }
  };
}

export function isStreamingTtsEnabled(config) {
  return Boolean(config?.v4?.streamingTtsEnabled);
}

/** @deprecated Phase 1 alias */
export function createTtsAdapterStub(options = {}) {
  return createTtsAdapter({ ...options, provider: options.provider ?? "mock" });
}

export { buildCacheKey, shouldCachePhrase, createTtsPhraseCache };
