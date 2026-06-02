/**
 * v4 OpenAI TTS provider — fetch WAV + convert to 8 kHz PCM (Phase 10E2 live canary).
 * No transcript logging; inject fetch/ffmpeg in tests.
 */

import { convertWavBufferToPcm8k } from "./tts-pcm-convert.js";

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const DEFAULT_INSTRUCTIONS =
  "Speak German with a warm, calm, professional business receptionist tone. Natural pacing, clear pronunciation, friendly and concise.";

export function clampTtsSpeed(speed) {
  return Math.min(1.15, Math.max(0.75, Number(speed) || 1.0));
}

/**
 * Fetch OpenAI speech as WAV (inject fetchImpl in tests — no live network in unit tests).
 */
export async function fetchOpenAiSpeechWav({
  apiKey,
  model = "gpt-4o-mini-tts",
  voice = "marin",
  text = "",
  speed = 1.0,
  instructions = DEFAULT_INSTRUCTIONS,
  fetchImpl = globalThis.fetch
} = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) {
    return { ok: false, code: "openai_api_key_missing", message: "OPENAI_API_KEY is required" };
  }

  const input = String(text ?? "").trim();
  if (!input) {
    return { ok: false, code: "empty_text", message: "TTS text required" };
  }

  if (typeof fetchImpl !== "function") {
    return { ok: false, code: "fetch_not_configured", message: "fetch implementation required" };
  }

  const startedAt = Date.now();
  let response;
  try {
    response = await fetchImpl(OPENAI_SPEECH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: String(model ?? "gpt-4o-mini-tts").trim(),
        voice: String(voice ?? "marin").trim(),
        input,
        speed: clampTtsSpeed(speed),
        instructions: String(instructions ?? DEFAULT_INSTRUCTIONS),
        response_format: "wav"
      })
    });
  } catch (err) {
    return {
      ok: false,
      code: "openai_fetch_failed",
      message: String(err?.message ?? err).slice(0, 200),
      latencyMs: Date.now() - startedAt
    };
  }

  const latencyMs = Date.now() - startedAt;
  if (!response?.ok) {
    return {
      ok: false,
      code: `openai_tts_http_${response?.status ?? "unknown"}`,
      message: `OpenAI TTS HTTP ${response?.status ?? "error"}`,
      latencyMs
    };
  }

  try {
    const wav = Buffer.from(await response.arrayBuffer());
    if (!wav.length) {
      return { ok: false, code: "openai_wav_empty", message: "OpenAI TTS returned empty audio", latencyMs };
    }
    return { ok: true, wav, latencyMs };
  } catch (err) {
    return {
      ok: false,
      code: "openai_body_read_failed",
      message: String(err?.message ?? err).slice(0, 200),
      latencyMs
    };
  }
}

/**
 * End-to-end OpenAI TTS → 8 kHz PCM for v4 live canary.
 */
export async function synthesizeOpenAiSpeechPcm8k({
  config,
  text,
  fetchImpl,
  execFileImpl,
  apiKey = process.env.OPENAI_API_KEY
} = {}) {
  const wavResult = await fetchOpenAiSpeechWav({
    apiKey,
    model: config?.assistant?.ttsModel,
    voice: config?.assistant?.ttsVoice,
    text,
    speed: config?.assistant?.ttsSpeed,
    fetchImpl
  });

  if (!wavResult.ok) {
    return wavResult;
  }

  const convertStarted = Date.now();
  const pcmResult = await convertWavBufferToPcm8k(wavResult.wav, execFileImpl);
  const convertMs = Math.max(0, Date.now() - convertStarted);

  if (!pcmResult.ok) {
    return {
      ...pcmResult,
      openai_latency_ms: wavResult.latencyMs ?? null,
      convert_ms: convertMs
    };
  }

  return {
    ok: true,
    pcm: pcmResult.pcm,
    sampleRate: pcmResult.sampleRate ?? 8000,
    openai_latency_ms: wavResult.latencyMs ?? null,
    convert_ms: convertMs,
    first_chunk_ms: (wavResult.latencyMs ?? 0) + convertMs
  };
}

/**
 * Factory for createTtsAdapter synthesizeImplAsync (returns Buffer PCM).
 */
export function createOpenAiTtsSynthesizeFn(config, deps = {}) {
  const { fetchImpl, execFileImpl, apiKey } = deps;
  return async (text) => {
    const result = await synthesizeOpenAiSpeechPcm8k({
      config,
      text,
      fetchImpl,
      execFileImpl,
      apiKey
    });
    if (!result.ok) {
      const err = new Error(result.message ?? result.code ?? "openai_tts_failed");
      err.code = result.code;
      throw err;
    }
    return result.pcm;
  };
}

export function isLiveOpenAiTtsConfigured(config) {
  const provider = String(config?.v4?.ttsProvider ?? "mock").trim().toLowerCase();
  const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
  return provider === "openai" && Boolean(apiKey);
}
