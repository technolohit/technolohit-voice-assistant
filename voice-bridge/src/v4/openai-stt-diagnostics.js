/**
 * Safe OpenAI STT error/metadata helpers (Phase 10J) — no secrets, transcript, or raw audio.
 */

import { redactPhoneLikeText } from "./redaction.js";

const SECRET_PATTERNS = [
  /Bearer\s+\S+/gi,
  /sk-[a-zA-Z0-9_-]{8,}/gi,
  /OPENAI_API_KEY[=:]\s*\S+/gi,
  /api[_-]?key[=:]\s*\S+/gi
];

export function sanitizeOpenAiErrorSnippet(text, maxLen = 200) {
  let value = redactPhoneLikeText(String(text ?? "").trim());
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, "[redacted]");
  }
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…`;
}

export function parseOpenAiErrorBody(bodyText) {
  const raw = String(bodyText ?? "").trim();
  if (!raw) {
    return { errorCode: null, errorType: null, errorMessage: null, bodySnippet: null };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      errorCode: null,
      errorType: null,
      errorMessage: null,
      bodySnippet: sanitizeOpenAiErrorSnippet(raw)
    };
  }

  const errObj = parsed?.error && typeof parsed.error === "object" ? parsed.error : parsed;
  return {
    errorCode: errObj?.code ? String(errObj.code).slice(0, 80) : null,
    errorType: errObj?.type ? String(errObj.type).slice(0, 80) : null,
    errorMessage: sanitizeOpenAiErrorSnippet(errObj?.message ?? ""),
    bodySnippet: null
  };
}

export async function readOpenAiSttErrorResponse(response) {
  const httpStatus = Number(response?.status) || null;
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }
  const parsed = parseOpenAiErrorBody(bodyText);
  return {
    httpStatus,
    errorCode: parsed.errorCode,
    errorType: parsed.errorType,
    errorMessage: parsed.errorMessage || parsed.bodySnippet || `HTTP ${httpStatus ?? "error"}`,
    bodySnippet: parsed.bodySnippet
  };
}

export function buildSttRequestMetadata({
  pcmBuffer = null,
  wavBuffer = null,
  sampleRate = 8000,
  frameCount = null,
  model = null,
  language = null
} = {}) {
  const pcmBytes = pcmBuffer?.length ?? 0;
  const wavBytes = wavBuffer?.length ?? 0;
  const bytesPerSample = 2;
  const utteranceDurationMs =
    sampleRate > 0 && pcmBytes > 0
      ? Math.max(0, Math.round((pcmBytes / bytesPerSample / sampleRate) * 1000))
      : null;

  return {
    model: model ? String(model).slice(0, 80) : null,
    language: language ? String(language).slice(0, 16) : null,
    pcm_bytes: pcmBytes,
    wav_bytes: wavBytes,
    sample_rate: Number(sampleRate) || 8000,
    frame_count: frameCount == null ? null : Number(frameCount),
    utterance_duration_ms: utteranceDurationMs
  };
}

export function mergeSttFailureDiagnostics(base = {}, extra = {}) {
  return {
    ...base,
    ...extra,
    stt_provider: extra.stt_provider ?? base.stt_provider ?? "openai"
  };
}
