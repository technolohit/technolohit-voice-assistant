/**
 * Minimal fail-safe quality telemetry shared by v3 and v4 live calls.
 */

import { insertCallQualityEvent } from "./db.js";
import { redactQualityPayload } from "./v4/quality-events.js";

function runtimeSelected(config, ctx) {
  if (ctx?.callHandler === "v4_canary") return "v4";
  return "v3";
}

function counters(ctx) {
  if (!ctx.liveQualityCounters) {
    ctx.liveQualityCounters = {
      response_count: 0,
      turn_count: 0
    };
  }
  return ctx.liveQualityCounters;
}

async function insertSafe(config, ctx, eventType, payload = {}, deps = {}) {
  if (!ctx?.callSessionId) return null;
  const insertFn = deps.insertFn ?? insertCallQualityEvent;
  try {
    return await insertFn(config, {
      tenantId: config?.v4?.tenantId ?? "technolohit",
      agentId: config?.v4?.agentId ?? "main_voice_sales",
      callSessionId: ctx.callSessionId,
      eventType,
      eventStage: "live_runtime",
      payload: redactQualityPayload(payload)
    });
  } catch (err) {
    console.warn(
      `[voice-quality] insert_failed event_type=${eventType} reason=${err?.message ?? String(err)}`
    );
    return null;
  }
}

export async function recordLiveHandlerSelected(config, ctx, selection = {}, deps = {}) {
  counters(ctx);
  return insertSafe(config, ctx, "live_runtime_selected", {
    runtime_selected: runtimeSelected(config, ctx),
    handler_selected: selection.handler ?? ctx.callHandler ?? "unknown",
    route_reason: selection.reason ?? "unknown"
  }, deps);
}

export async function recordLiveAssistantResponse(config, ctx, info = {}, deps = {}) {
  const count = counters(ctx);
  count.response_count += 1;
  count.turn_count = Math.max(count.turn_count, Number(info.turnIndex ?? 0));
  return insertSafe(config, ctx, "live_response_created", {
    runtime_selected: runtimeSelected(config, ctx),
    handler_selected: ctx.callHandler ?? "unknown",
    response_type: info.detectedIntent ?? "unknown",
    response_template: info.finalResponseTemplate ?? "unknown",
    current_product_context: info.productInterest ?? null,
    response_count: count.response_count,
    turn_count: count.turn_count
  }, deps);
}

export async function recordLiveCallSummary(config, ctx, closeReason = "socket_close", deps = {}) {
  const count = counters(ctx);
  return insertSafe(config, ctx, "live_runtime_summary", {
    runtime_selected: runtimeSelected(config, ctx),
    handler_selected: ctx.callHandler ?? "unknown",
    close_reason: String(closeReason || "socket_close").slice(0, 80),
    current_product_context: ctx?.assistantTurn?.product?.selectedProduct ?? null,
    counters: {
      response_count: count.response_count,
      turn_count: count.turn_count,
      inbound_audio_frames: Number(ctx.inboundAudioFrames ?? 0)
    }
  }, deps);
}
