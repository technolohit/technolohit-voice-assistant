/**
 * Phase 10G — flush v4 live canary quality events to DB on call end (fail-safe, v4-only).
 */

import { isDbConfigured } from "../db.js";
import { buildPersistMetadata } from "./persist-metadata.js";
import {
  buildQualityEventInput,
  buildAudioSessionClosedEvent,
  validateQualityEventInput
} from "./quality-events.js";
import { createQualityEventSink } from "./quality-event-sink.js";
import {
  createDbQualityEventInsertFn,
  enrichQualityEventForPersistence
} from "./quality-persistence.js";
import { buildLiveCanaryCallQualitySummary } from "./quality-analytics.js";
import { assertNoRawPhoneInPayload } from "./privacy-sanitize.js";

function liveLogIds(ctx) {
  return `bridge_call_id=${ctx?.bridgeCallId ?? "pending"} call_session_id=${ctx?.callSessionId ?? "pending"}`;
}

export function resolveLiveCallSessionId(ctx, runtime) {
  const id =
    ctx?.callSessionId ??
    runtime?.audioSession?.callSessionId ??
    runtime?.runtimeContext?.memory?.call_session_id ??
    null;
  const trimmed = id != null ? String(id).trim() : "";
  return trimmed || null;
}

export function canFlushLiveCanaryQuality(config, ctx, runtime) {
  if (ctx?.callHandler !== "v4_canary" && !runtime?.liveCanary) {
    return { ok: false, reason: "not_v4_canary" };
  }
  const callSessionId = resolveLiveCallSessionId(ctx, runtime);
  if (!callSessionId) {
    return { ok: false, reason: "call_session_missing" };
  }
  const insertFn = resolveLiveQualityInsertFn(config, runtime);
  if (!insertFn) {
    return { ok: true, reason: "insert_fn_unavailable", callSessionId, writable: false };
  }
  if (!isDbConfigured(config)) {
    return { ok: true, reason: "db_disabled", callSessionId, writable: false };
  }
  return { ok: true, reason: "flush_ready", callSessionId, writable: true };
}

export function resolveLiveQualityInsertFn(config, runtime, options = {}) {
  if (typeof options.insertFn === "function") {
    return options.insertFn;
  }
  if (typeof runtime?.qualityInsertFn === "function") {
    return runtime.qualityInsertFn;
  }
  if (runtime?.qualitySink?.insertFn) {
    return runtime.qualitySink.insertFn;
  }
  if (options.persistQualityToDb === false) {
    return null;
  }
  if (!isDbConfigured(config)) {
    return null;
  }
  return createDbQualityEventInsertFn(config, {
    persistMetadata: runtime?.runtimeContext?.persistMetadata ?? null,
    agentConfig: runtime?.runtimeContext?.agentConfig ?? null
  });
}

function normalizeBufferedEvent(event, callSessionId) {
  if (!event?.eventType) return null;
  return {
    ...event,
    callSessionId: event.callSessionId ?? callSessionId
  };
}

function buildSummaryQualityEvent(config, ctx, runtime, events, summary, closeReason = null) {
  const agentConfig = runtime?.runtimeContext?.agentConfig ?? null;
  const callSessionId = resolveLiveCallSessionId(ctx, runtime);
  const durationMs = runtime?.startedAt ? Math.max(0, Date.now() - runtime.startedAt) : null;

  return buildQualityEventInput({
    config,
    agentConfigResult: agentConfig,
    callSessionId,
    eventType: "live_call_quality_summary",
    eventStage: "session",
    metricName: "session_duration_ms",
    metricValue: durationMs,
    payload: {
      bridge_call_id: ctx?.bridgeCallId ?? null,
      live_phase: runtime?.phase ?? "phase10g_live_quality_flush",
      close_reason: closeReason ? String(closeReason).slice(0, 80) : null,
      counters: summary?.counters ?? {},
      latencies: summary?.latencies ?? {},
      errors: summary?.errors ?? {},
      live_counters: summary?.live_counters ?? {},
      privacy_ok: summary?.privacy_ok ?? true
    }
  });
}

/**
 * Flush runtime.qualityEventsBuffer to DB when v4_canary + call_session_id + insert available.
 */
export async function flushLiveCanaryQualityEvents(config, ctx, runtime, options = {}) {
  const closeReason = options.closeReason ?? null;
  const gate = canFlushLiveCanaryQuality(config, ctx, runtime);
  const callSessionId = gate.callSessionId ?? resolveLiveCallSessionId(ctx, runtime);
  const buffered = Array.isArray(runtime?.qualityEventsBuffer)
    ? [...runtime.qualityEventsBuffer]
    : [];

  const persistMetadata =
    options.persistMetadata ??
    runtime?.runtimeContext?.persistMetadata ??
    buildPersistMetadata(config, runtime?.runtimeContext?.agentConfig);
  const agentConfig = runtime?.runtimeContext?.agentConfig ?? null;

  if (ctx?.callHandler !== "v4_canary" && !runtime?.liveCanary) {
    return {
      ok: false,
      reason: "not_v4_canary",
      flushed: 0,
      failed: 0,
      inserted_count: 0,
      memory_only: true
    };
  }

  if (!callSessionId) {
    console.warn(`[v4-live] quality_flush_failed reason=call_session_missing ${liveLogIds(ctx)}`);
    return {
      ok: false,
      reason: "call_session_missing",
      flushed: 0,
      failed: 0,
      inserted_count: 0,
      memory_only: true
    };
  }

  const summary = buildLiveCanaryCallQualitySummary(runtime, ctx, buffered, { persistMetadata });
  const eventsToFlush = buffered
    .map((event) => normalizeBufferedEvent(event, callSessionId))
    .filter(Boolean);

  const summaryEvent = buildSummaryQualityEvent(
    config,
    ctx,
    runtime,
    eventsToFlush,
    summary,
    closeReason
  );
  const closedEvent = buildAudioSessionClosedEvent({
    config,
    agentConfigResult: agentConfig,
    callSessionId,
    metricValue: summary?.live_counters?.duration_ms ?? null,
    payload: {
      bridge_call_id: ctx?.bridgeCallId ?? null,
      live_phase: runtime?.phase ?? "phase10g_live_quality_flush",
      endpoint_count: runtime?.endpointCount ?? 0,
      turn_count: summary?.counters?.turn_count ?? 0
    }
  });

  eventsToFlush.push(summaryEvent, closedEvent);

  const insertFn = resolveLiveQualityInsertFn(config, runtime, options);
  const sink = createQualityEventSink({
    v4PathActive: true,
    insertFn: insertFn ?? null,
    maxBuffer: Math.max(64, eventsToFlush.length + 8)
  });

  for (const event of eventsToFlush) {
    const validation = validateQualityEventInput(event);
    if (!validation.ok) {
      continue;
    }
    sink.bufferQualityEvent(event);
  }

  const eventCount = sink.bufferedCount();
  console.log(
    `[v4-live] quality_flush_started event_count=${eventCount} db_enabled=${Boolean(insertFn)} ${liveLogIds(ctx)}`
  );

  if (!insertFn) {
    const memoryFlush = await sink.flushQualityEvents({
      v4PathActive: true,
      persistMetadata,
      config,
      agentConfig
    });
    if (runtime) {
      runtime.qualityEventsBuffer = [];
      runtime.lastQualityFlush = {
        ok: true,
        memory_only: true,
        inserted_count: 0,
        summary
      };
    }
    console.log(
      `[v4-live] quality_flush_completed inserted_count=0 memory_only=true event_count=${eventCount} ${liveLogIds(ctx)}`
    );
    return {
      ok: true,
      reason: "memory_only",
      flushed: 0,
      failed: 0,
      inserted_count: 0,
      memory_only: true,
      events: memoryFlush.events ?? [],
      summary
    };
  }

  try {
    const flushResult = await sink.flushQualityEvents({
      v4PathActive: true,
      persistMetadata,
      config,
      agentConfig
    });

    const insertedCount = flushResult.flushed ?? 0;
    const failedCount = flushResult.failed ?? 0;

    if (failedCount > 0) {
      const failureReason = flushResult.failures?.[0]?.reason ?? "insert_failed";
      console.warn(
        `[v4-live] quality_flush_failed reason=${String(failureReason).slice(0, 80)} inserted_count=${insertedCount} failed_count=${failedCount} ${liveLogIds(ctx)}`
      );
    } else {
      console.log(
        `[v4-live] quality_flush_completed inserted_count=${insertedCount} failed_count=${failedCount} ${liveLogIds(ctx)}`
      );
    }

    if (runtime) {
      runtime.qualityEventsBuffer = [];
      runtime.lastQualityFlush = {
        ok: failedCount === 0,
        inserted_count: insertedCount,
        failed_count: failedCount,
        summary
      };
    }

    return {
      ok: failedCount === 0,
      reason: failedCount > 0 ? "insert_failures" : "flushed",
      flushed: insertedCount,
      failed: failedCount,
      inserted_count: insertedCount,
      failures: flushResult.failures ?? [],
      memory_only: false,
      events: flushResult.events ?? [],
      summary
    };
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 120);
    console.warn(`[v4-live] quality_flush_failed reason=flush_exception error=${message} ${liveLogIds(ctx)}`);
    if (runtime) {
      runtime.qualityEventsBuffer = [];
      runtime.lastQualityFlush = { ok: false, reason: "flush_exception", error: message };
    }
    return {
      ok: false,
      reason: "flush_exception",
      error: message,
      flushed: 0,
      failed: eventCount,
      inserted_count: 0,
      memory_only: false,
      summary
    };
  }
}

export function ensureLiveQualitySink(runtime, config, options = {}) {
  if (runtime?.qualitySink) {
    return runtime.qualitySink;
  }
  const insertFn = resolveLiveQualityInsertFn(config, runtime, options);
  runtime.qualitySink = createQualityEventSink({
    v4PathActive: true,
    insertFn: insertFn ?? null
  });
  runtime.qualityInsertFn = insertFn ?? null;
  return runtime.qualitySink;
}
