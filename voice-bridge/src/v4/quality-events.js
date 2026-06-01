/**
 * v4 quality event builders — redaction-safe payloads for future persistence.
 */

import { redactPhoneLikeText, sanitizeCustomFields } from "./redaction.js";
import { stateToQualityEvent } from "./state-machine.js";

const SENSITIVE_KEYS = new Set([
  "phone",
  "phone_number",
  "caller_phone",
  "caller_phone_raw",
  "caller_phone_normalized",
  "email",
  "transcript",
  "assistant_text",
  "user_utterance"
]);

export function redactQualityPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SENSITIVE_KEYS.has(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string") {
      out[key] = redactPhoneLikeText(value);
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      out[key] = redactQualityPayload(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function buildQualityEventInput({
  config,
  agentConfigResult = null,
  callSessionId = null,
  eventType,
  eventStage = null,
  metricName = null,
  metricValue = null,
  payload = {}
}) {
  const event_type = String(eventType ?? "").trim();
  if (!event_type) {
    throw new Error("eventType is required");
  }

  const tenantId = String(
    agentConfigResult?.config?.tenant_id ?? config?.v4?.tenantId ?? "technolohit"
  ).trim();
  const agentId = String(
    agentConfigResult?.config?.agent_id ?? config?.v4?.agentId ?? "main_voice_sales"
  ).trim();

  return {
    tenantId,
    agentId,
    callSessionId: callSessionId ? String(callSessionId).trim() : null,
    eventType: event_type,
    eventStage: eventStage ? String(eventStage).trim() : null,
    metricName: metricName ? String(metricName).trim() : null,
    metricValue: Number.isFinite(Number(metricValue)) ? Number(metricValue) : null,
    payload: redactQualityPayload(payload)
  };
}

export function validateQualityEventInput(input) {
  const errors = [];
  if (!String(input?.eventType ?? "").trim()) errors.push("eventType required");
  if (!String(input?.tenantId ?? "").trim()) errors.push("tenantId required");
  if (!String(input?.agentId ?? "").trim()) errors.push("agentId required");
  const serialized = JSON.stringify(input?.payload ?? {});
  if (/\b\+?\d{8,}\b/.test(serialized)) {
    errors.push("payload must not contain raw phone numbers");
  }
  return { ok: errors.length === 0, errors };
}

function typedBuilder(eventType, defaults = {}) {
  return ({ config, agentConfigResult, callSessionId, eventStage, metricName, metricValue, payload } = {}) =>
    buildQualityEventInput({
      config,
      agentConfigResult,
      callSessionId,
      eventType,
      eventStage: eventStage ?? defaults.eventStage ?? null,
      metricName: metricName ?? defaults.metricName ?? null,
      metricValue: metricValue ?? defaults.metricValue ?? null,
      payload: { ...defaults.payload, ...(payload ?? {}) }
    });
}

export const buildCallStartedEvent = typedBuilder("call_started", { eventStage: "session" });
export const buildTurnStartedEvent = typedBuilder("turn_started", { eventStage: "dialogue" });
export const buildSttStartedEvent = typedBuilder("stt_started", { eventStage: "stt" });
export const buildSttCompletedEvent = typedBuilder("stt_completed", {
  eventStage: "stt",
  metricName: "stt_ms"
});
export const buildTtsStartedEvent = typedBuilder("tts_started", { eventStage: "tts" });
export const buildTtsFirstAudioEvent = typedBuilder("tts_first_audio", {
  eventStage: "tts",
  metricName: "tts_first_audio_ms"
});
export const buildTtsCompletedEvent = typedBuilder("tts_completed", {
  eventStage: "tts",
  metricName: "tts_ms"
});
export const buildBargeInDetectedEvent = typedBuilder("barge_in_detected", { eventStage: "playback" });
export const buildPlaybackStartedEvent = typedBuilder("playback_started", { eventStage: "playback" });
export const buildPlaybackCancelRequestedEvent = typedBuilder("playback_cancel_requested", {
  eventStage: "playback",
  metricName: "cancel_latency_ms"
});
export const buildPlaybackCancelledEvent = typedBuilder("playback_cancelled", {
  eventStage: "playback",
  metricName: "cancel_latency_ms"
});
export const buildPlaybackCompletedEvent = typedBuilder("playback_completed", {
  eventStage: "playback",
  metricName: "playback_duration_ms"
});
export const buildInterruptionContextCapturedEvent = typedBuilder("interruption_context_captured", {
  eventStage: "dialogue"
});
export const buildTopicSwitchDetectedEvent = typedBuilder("topic_switch_detected", {
  eventStage: "dialogue"
});
export const buildInterruptionRecoveredEvent = typedBuilder("interruption_recovered", {
  eventStage: "dialogue"
});
export const buildRagRetrievalStartedEvent = typedBuilder("rag_retrieval_started", {
  eventStage: "rag"
});
export const buildRagRetrievalCompletedEvent = typedBuilder("rag_retrieval_completed", {
  eventStage: "rag",
  metricName: "rag_ms"
});
export const buildLeadCreatedEvent = typedBuilder("lead_created", { eventStage: "lead" });
export const buildLeadSkippedEvent = typedBuilder("lead_skipped", { eventStage: "lead" });
export const buildRuntimeErrorEvent = typedBuilder("runtime_error", { eventStage: "runtime" });

export const buildVadSpeechStartEvent = typedBuilder("vad_speech_start", {
  eventStage: "vad",
  metricName: "vad_speech_start_ms"
});
export const buildVadEndpointDetectedEvent = typedBuilder("vad_endpoint_detected", {
  eventStage: "vad",
  metricName: "endpoint_ms"
});
export const buildSttPartialEvent = typedBuilder("stt_partial", { eventStage: "stt" });
export const buildSttFinalEvent = typedBuilder("stt_final", {
  eventStage: "stt",
  metricName: "stt_final_ms"
});
export const buildTtsFirstChunkEvent = typedBuilder("tts_first_chunk", {
  eventStage: "tts",
  metricName: "tts_first_chunk_ms"
});
export const buildAudioSessionClosedEvent = typedBuilder("audio_session_closed", {
  eventStage: "session",
  metricName: "session_duration_ms"
});

export function buildQualityEventFromState(state, base = {}) {
  return buildQualityEventInput({
    ...base,
    eventType: stateToQualityEvent(state),
    payload: { state, ...(base.payload ?? {}) }
  });
}

export function sanitizeQualityCustomFields(fields) {
  return sanitizeCustomFields(fields);
}
