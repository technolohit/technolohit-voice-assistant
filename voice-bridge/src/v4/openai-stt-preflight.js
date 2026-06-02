/**
 * OpenAI STT preflight — container-safe gate before live PSTN canary (Phase 10J).
 */

import { generateTestTonePcm } from "../audio-media.js";
import { transcribeOpenAiPcmUtterance8k } from "./openai-stt-provider.js";

const DEFAULT_PREFLIGHT_MS = 400;

export function buildOpenAiSttPreflightPcm(config, durationMs = DEFAULT_PREFLIGHT_MS) {
  const sampleRate = config?.sampleRate ?? 8000;
  return generateTestTonePcm(sampleRate, durationMs, 440);
}

/**
 * Run one minimal transcription request. Returns safe fields only (no secrets/transcript).
 */
export async function runOpenAiSttPreflight(config, options = {}) {
  const model = options.model ?? config?.transcription?.model ?? "gpt-4o-mini-transcribe";
  const language = options.language ?? config?.transcription?.language ?? "de";
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const pcm = options.pcmBuffer ?? buildOpenAiSttPreflightPcm(config, options.durationMs ?? DEFAULT_PREFLIGHT_MS);

  const startedAt = Date.now();
  const result = await transcribeOpenAiPcmUtterance8k({
    pcmBuffer: pcm,
    apiKey,
    model,
    language,
    sampleRate: config?.sampleRate ?? 8000,
    frameCount: null,
    fetchImpl
  });
  const latencyMs = Math.max(0, result?.sttMs ?? Date.now() - startedAt);

  if (result?.ok) {
    return {
      ok: true,
      model,
      httpStatus: result.httpStatus ?? 200,
      errorCode: null,
      latencyMs
    };
  }

  // The preflight uses a synthetic tone, not speech. Some transcription models
  // validly return a 2xx response with no transcript for that input. Treat that
  // as API/model/connectivity success; live-call semantic QA still validates
  // real speech separately.
  const status = result?.httpStatus ?? result?.diagnostics?.stt_http_status ?? null;
  const code = result?.errorCode ?? result?.diagnostics?.stt_error_code ?? result?.code ?? "";
  if (String(code) === "empty_transcript" && Number(status) >= 200 && Number(status) < 300) {
    return {
      ok: true,
      model,
      httpStatus: status,
      errorCode: "empty_transcript_on_tone",
      latencyMs
    };
  }

  return {
    ok: false,
    model,
    httpStatus: status,
    errorCode: code || "preflight_failed",
    latencyMs
  };
}

export function formatOpenAiSttPreflightLines(result) {
  const lines = [
    `openai_stt_preflight=${result?.ok ? "pass" : "fail"}`,
    `model=${result?.model ?? "unknown"}`,
    `http_status=${result?.httpStatus ?? "none"}`,
    `error_code=${result?.errorCode ?? "none"}`,
    `latency_ms=${result?.latencyMs ?? 0}`
  ];
  return lines.join("\n");
}
