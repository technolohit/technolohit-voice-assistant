/**
 * v4 OpenAI endpoint/batch STT — transcribe captured 8 kHz PCM at VAD endpoint (Phase 10I/10J).
 * No raw transcript logging; inject fetchImpl in tests.
 */

import { wrapPcm8kAsWav } from "./pcm-wav.js";
import {
  buildSttRequestMetadata,
  readOpenAiSttErrorResponse,
  sanitizeOpenAiErrorSnippet
} from "./openai-stt-diagnostics.js";

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

function failureResult({
  code,
  message,
  sttMs = null,
  httpStatus = null,
  errorCode = null,
  errorType = null,
  diagnostics = {}
}) {
  return {
    ok: false,
    code,
    message: sanitizeOpenAiErrorSnippet(message),
    sttMs,
    httpStatus,
    errorCode,
    errorType,
    diagnostics
  };
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
  frameCount = null,
  fetchImpl = globalThis.fetch
} = {}) {
  const requestMeta = buildSttRequestMetadata({
    pcmBuffer,
    wavBuffer: null,
    sampleRate,
    frameCount,
    model,
    language
  });

  const key = String(apiKey ?? "").trim();
  if (!key) {
    return failureResult({
      code: "openai_api_key_missing",
      message: "OPENAI_API_KEY is required",
      diagnostics: { ...requestMeta, stt_provider: "openai" }
    });
  }
  if (!pcmBuffer?.length) {
    return failureResult({
      code: "pcm_empty",
      message: "PCM input is empty",
      diagnostics: { ...requestMeta, stt_provider: "openai" }
    });
  }
  if (typeof fetchImpl !== "function") {
    return failureResult({
      code: "fetch_not_configured",
      message: "fetch implementation required",
      diagnostics: { ...requestMeta, stt_provider: "openai" }
    });
  }

  const wav = wrapPcm8kAsWav(pcmBuffer, sampleRate);
  requestMeta.wav_bytes = wav.length;
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
    const sttMs = Date.now() - startedAt;
    return failureResult({
      code: "openai_fetch_failed",
      message: String(err?.message ?? err),
      sttMs,
      diagnostics: { ...requestMeta, stt_provider: "openai", duration_ms: sttMs }
    });
  }

  const sttMs = Date.now() - startedAt;
  const diagnostics = {
    ...requestMeta,
    stt_provider: "openai",
    duration_ms: sttMs
  };

  if (!response?.ok) {
    const errInfo = await readOpenAiSttErrorResponse(response);
    return failureResult({
      code: `openai_stt_http_${errInfo.httpStatus ?? "unknown"}`,
      message: errInfo.errorMessage ?? `OpenAI STT HTTP ${errInfo.httpStatus ?? "error"}`,
      sttMs,
      httpStatus: errInfo.httpStatus,
      errorCode: errInfo.errorCode,
      errorType: errInfo.errorType,
      diagnostics: {
        ...diagnostics,
        stt_http_status: errInfo.httpStatus,
        stt_error_code: errInfo.errorCode,
        stt_error_type: errInfo.errorType,
        stt_error_message: errInfo.errorMessage,
        stt_body_snippet: errInfo.bodySnippet
      }
    });
  }

  try {
    const body = await response.json();
    const text = extractTranscriptText(body);
    if (!text) {
      return failureResult({
        code: "empty_transcript",
        message: "transcription response did not include text",
        sttMs,
        httpStatus: response.status,
        diagnostics: { ...diagnostics, stt_http_status: response.status }
      });
    }
    return {
      ok: true,
      text,
      sttMs,
      provider: "openai",
      model,
      httpStatus: response.status,
      diagnostics
    };
  } catch (err) {
    return failureResult({
      code: "openai_stt_parse_failed",
      message: String(err?.message ?? err),
      sttMs,
      httpStatus: response?.status ?? null,
      diagnostics: {
        ...diagnostics,
        stt_http_status: response?.status ?? null
      }
    });
  }
}

export function createOpenAiEndpointTranscribeFn(config, options = {}) {
  const model = config?.transcription?.model ?? "gpt-4o-mini-transcribe";
  const language = config?.transcription?.language ?? "de";
  const prompt = config?.transcription?.prompt ?? "";
  const sampleRate = config?.sampleRate ?? 8000;
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return async function transcribeEndpoint(pcmBuffer, meta = {}) {
    return transcribeOpenAiPcmUtterance8k({
      pcmBuffer,
      apiKey,
      model,
      language,
      prompt,
      sampleRate,
      frameCount: meta?.frameCount ?? meta?.frame_count ?? null,
      fetchImpl
    });
  };
}
