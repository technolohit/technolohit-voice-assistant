/**
 * v4 quality analytics — per-call rollups from buffered/persisted events.
 */

import { assertNoRawPhoneInPayload } from "./privacy-sanitize.js";

const LATENCY_METRICS = {
  stt_ms: "stt",
  stt_final_ms: "stt",
  tts_ms: "tts",
  tts_first_chunk_ms: "tts",
  tts_first_audio_ms: "tts",
  rag_ms: "rag",
  cancel_latency_ms: "barge_in_cancel",
  endpoint_ms: "endpointing",
  vad_speech_start_ms: "vad",
  session_duration_ms: "session",
  playback_duration_ms: "playback"
};

const ERROR_EVENT_TYPES = new Set(["runtime_error", "post_call_error"]);

export function classifyQualityError(event = {}) {
  const eventType = String(event.eventType ?? "").trim();
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const fallback = String(payload.fallback_reason ?? payload.reason ?? "").toLowerCase();

  if (eventType === "runtime_error") return "runtime_error";
  if (eventType === "post_call_error") return "post_call_error";
  if (eventType === "rag_retrieval_failed") {
    if (fallback.includes("rate_limit")) return "provider_rate_limited";
    if (fallback.includes("timeout")) return "rag_timeout";
    return "rag_unavailable";
  }
  if (eventType === "stt_completed" && payload.ok === false) return "stt_error";
  if (eventType === "tts_completed" && payload.ok === false) return "tts_error";
  if (fallback.includes("rate_limit")) return "provider_rate_limited";
  return null;
}

function metricRollup(existing, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return existing;
  if (!existing) {
    return { count: 1, sum: n, min: n, max: n, avg: n };
  }
  const count = existing.count + 1;
  const sum = existing.sum + n;
  return {
    count,
    sum,
    min: Math.min(existing.min, n),
    max: Math.max(existing.max, n),
    avg: Math.round((sum / count) * 100) / 100
  };
}

function countByKey(map, key) {
  if (!key) return map;
  map[key] = (map[key] ?? 0) + 1;
  return map;
}

export function buildCallQualitySummary(events = [], options = {}) {
  const list = Array.isArray(events) ? events : [];
  const persistMetadata = options.persistMetadata ?? {};
  const postCallMetadata = options.postCallMetadata ?? null;

  const latencies = {};
  const counters = {
    event_count: list.length,
    turn_count: 0,
    interruption_count: 0,
    rag_used_count: 0,
    rag_failed_count: 0,
    lead_created_count: 0,
    lead_skipped_count: 0
  };
  const lead_skip_reasons = {};
  const errors = {};
  let tenantId = persistMetadata.tenant_id ?? null;
  let agentId = persistMetadata.agent_id ?? null;

  for (const event of list) {
    tenantId = event.tenantId ?? tenantId;
    agentId = event.agentId ?? agentId;

    const eventType = String(event.eventType ?? "");
    if (eventType === "turn_started") counters.turn_count += 1;
    if (eventType === "barge_in_detected") counters.interruption_count += 1;
    if (eventType === "rag_retrieval_completed") counters.rag_used_count += 1;
    if (eventType === "rag_retrieval_failed") counters.rag_failed_count += 1;
    if (eventType === "lead_created") counters.lead_created_count += 1;
    if (eventType === "lead_skipped") {
      counters.lead_skipped_count += 1;
      const reason = String(event.payload?.reason ?? "unknown");
      countByKey(lead_skip_reasons, reason);
    }

    const metricName = String(event.metricName ?? "");
    const bucket = LATENCY_METRICS[metricName];
    if (bucket && Number.isFinite(Number(event.metricValue))) {
      latencies[bucket] = metricRollup(latencies[bucket], event.metricValue);
    }

    const errorClass = classifyQualityError(event);
    if (errorClass) {
      errors[errorClass] = (errors[errorClass] ?? 0) + 1;
    }
  }

  const dialogueSamples = [];
  for (const event of list) {
    if (event.eventType === "stt_completed" && Number.isFinite(Number(event.metricValue))) {
      dialogueSamples.push(Number(event.metricValue));
    }
  }
  if (dialogueSamples.length) {
    latencies.dialogue = metricRollup(
      latencies.dialogue,
      dialogueSamples.reduce((a, b) => a + b, 0) / dialogueSamples.length
    );
  }

  const lastEvent = list.length ? list[list.length - 1] : null;
  const completed = list.some((event) => event.eventType === "audio_session_closed");

  const summary = {
    tenant_id: tenantId,
    agent_id: agentId,
    runtime_version:
      postCallMetadata?.runtime_version ?? persistMetadata.runtime_version ?? null,
    agent_config_version:
      postCallMetadata?.agent_config_version ?? persistMetadata.agent_config_version ?? null,
    prompt_playbook_version:
      postCallMetadata?.prompt_playbook_version ?? persistMetadata.prompt_playbook_version ?? null,
    knowledge_version:
      postCallMetadata?.knowledge_version ?? persistMetadata.knowledge_version ?? null,
    counters,
    latencies,
    errors,
    lead_skip_reasons,
    conversion: {
      lead_created: counters.lead_created_count,
      lead_skipped: counters.lead_skipped_count,
      callback_ready: Boolean(postCallMetadata?.callback_ready),
      next_action: postCallMetadata?.next_action ?? null
    },
    drop_off: {
      call_completed: completed,
      last_event_type: lastEvent?.eventType ?? null
    },
    privacy_ok: assertNoRawPhoneInPayload({
      counters,
      latencies,
      errors,
      lead_skip_reasons,
      conversion: { next_action: postCallMetadata?.next_action ?? null }
    })
  };

  return summary;
}

export function buildLiveCanaryCallQualitySummary(runtime = {}, ctx = {}, events = [], options = {}) {
  const persistMetadata =
    options.persistMetadata ?? runtime?.runtimeContext?.persistMetadata ?? {};
  const base = buildCallQualitySummary(events, { persistMetadata });

  const sttEvents = events.filter((e) =>
    ["stt_started", "stt_completed", "stt_final"].includes(String(e.eventType ?? ""))
  );
  const ttsEvents = events.filter((e) =>
    ["tts_started", "tts_completed", "tts_first_chunk"].includes(String(e.eventType ?? ""))
  );
  const playbackEvents = events.filter((e) =>
    ["playback_started", "playback_completed", "playback_cancelled"].includes(String(e.eventType ?? ""))
  );

  const live_counters = {
    endpoint_count: Number(runtime?.endpointCount ?? 0),
    speech_start_count: Number(runtime?.speechStartCount ?? 0),
    stt_completed_count: Number(runtime?.sttCompletedCount ?? 0),
    dialogue_completed_count: Number(runtime?.dialogueCompletedCount ?? 0),
    tts_completed_count: Number(runtime?.ttsCompletedCount ?? 0),
    tts_failed_count: Number(runtime?.ttsFailedCount ?? 0),
    playback_completed_count: Number(runtime?.playbackCompletedCount ?? 0),
    barge_in_count: Number(runtime?.bargeInCount ?? 0),
    inbound_frame_count: Number(runtime?.inboundFrameCount ?? 0),
    duration_ms: runtime?.startedAt ? Math.max(0, Date.now() - runtime.startedAt) : null,
    stt_event_count: sttEvents.length,
    tts_event_count: ttsEvents.length,
    playback_event_count: playbackEvents.length
  };

  const counters = {
    ...base.counters,
    ...live_counters
  };

  const summary = {
    ...base,
    counters,
    live_counters,
    privacy_ok: assertNoRawPhoneInPayload({
      counters,
      latencies: base.latencies,
      errors: base.errors,
      live_counters
    })
  };

  return summary;
}

export function summarizeCanaryCloseQuality(runtime = {}, flushResult = {}) {
  const events = flushResult.events ?? runtime.qualitySink?.getBufferedQualityEvents?.() ?? [];
  return buildCallQualitySummary(events, {
    persistMetadata: runtime.runtimeContext?.persistMetadata ?? null,
    postCallMetadata: flushResult.summary?.conversion
      ? {
          callback_ready: flushResult.summary.conversion.callback_ready,
          next_action: flushResult.summary.conversion.next_action,
          runtime_version: flushResult.summary.runtime_version,
          agent_config_version: flushResult.summary.agent_config_version,
          prompt_playbook_version: flushResult.summary.prompt_playbook_version,
          knowledge_version: flushResult.summary.knowledge_version
        }
      : runtime.orchestrator?.postCallHandoff?.summaryMetadata ?? null
  });
}
