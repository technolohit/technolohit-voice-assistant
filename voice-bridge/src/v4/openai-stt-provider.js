/**
 * v4 OpenAI endpoint/batch STT — transcribe captured 8 kHz PCM at VAD endpoint (Phase 10I).
 * No raw transcript logging; inject fetchImpl in tests.
 */

import { wrapPcm8kAsWav } from "./pcm-wav.js";

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";

export function isLiveOpenAiSttConfigured(config, options = {}) {
  const apiKey = String(options.apiKey ?? process.env.OPENAI_API_KEY ?? "").trim();
  return apiKey.length > 0;
}

function extractTranscriptText(body) {
  if (typeof body === "string") return body.trim();
  if (body?.text) return String(body.text).trim();
  return "";
}

/**
 * Build multipart/form-data body for OpenAI transcriptions (Node 20+ Blob/FormData).
 */
export function buildOpenAiTranscriptionFormData({
  wavBuffer,
  model = "gpt-4o-mini-transcribe",
  language = "de",
  prompt = ""
} = {}) {
  const form = new FormData();
  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  form.append("file", blob, "utterance.wav");
  form.append("model", String(model ?? "gpt-4o-mini-transcribe").trim());
  form.append("language", String(language ?? "de").trim());
  form.append("response_format", "json");
  if (String(prompt ?? "").trim()) {
    form.append("prompt", String(prompt).trim());
  }
  return form;
}

/**
 * Transcribe concatenated 8 kHz PCM frames via OpenAI audio/transcriptions.
 */
export async function transcribeOpenAiPcmUtterance8k({
  pcmBuffer,
  apiKey,
  model = "gpt-4o-mini-transcribe",
  language = "de",
  prompt = "",
  sampleRate = 8000,
  fetchImpl = globalThis.fetch
} = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) {
    return { ok: false, code: "openai_api_key_missing", message: "OPENAI_API_KEY is required" };
  }
  if (!pcmBuffer?.length) {
    return { ok: false, code: "pcm_empty", message: "PCM input is empty" };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, code: "fetch_not_configured", message: "fetch implementation required" };
  }

  const wav = wrapPcm8kAsWav(pcmBuffer, sampleRate);
  const form = buildOpenAiTranscriptionFormData({ wavBuffer: wav, model, language, prompt });
  const startedAt = Date.now();

  let response;
  try {
    response = await fetchImpl(OPENAI_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form
    });
  } catch (err) {
    return {
      ok: false,
      code: "openai_fetch_failed",
      message: String(err?.message ?? err).slice(0, 200),
      sttMs: Date.now() - startedAt
    };
  }

  const sttMs = Date.now() - startedAt;
  if (!response?.ok) {
    return {
      ok: false,
      code: `openai_stt_http_${response?.status ?? "unknown"}`,
      message: `OpenAI STT HTTP ${response?.status ?? "error"}`,
      sttMs
    };
  }

  try {
    const body = await response.json();
    const text = extractTranscriptText(body);
    if (!text) {
      return {
        ok: false,
        code: "empty_transcript",
        message: "transcription response did not include text",
        sttMs
      };
    }
    return { ok: true, text, sttMs, provider: "openai", model };
  } catch (err) {
    return {
      ok: false,
      code: "openai_stt_parse_failed",
      message: String(err?.message ?? err).slice(0, 200),
      sttMs
    };
  }
}

export function createOpenAiEndpointTranscribeFn(config, options = {}) {
  const model = config?.transcription?.model ?? "gpt-4o-mini-transcribe";
  const language = config?.transcription?.language ?? "de";
  const prompt = config?.transcription?.prompt ?? "";
  const sampleRate = config?.sampleRate ?? 8000;
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return async function transcribeEndpoint(pcmBuffer) {
    return transcribeOpenAiPcmUtterance8k({
      pcmBuffer,
      apiKey,
      model,
      language,
      prompt,
      sampleRate,
      fetchImpl
    });
  };
}
