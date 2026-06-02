/**
 * Phase 10A/10B — live AudioSocket v4 canary route selection + VAD endpointing.
 * Fail closed to v3 on any gate or init failure; never drop calls.
 */

import { playGreetingAndKeepalive } from "../media-outbound.js";
import { canPrepareV4CanaryMedia } from "./audiosocket-runtime.js";
import { createLiveCanaryRuntime } from "./canary-runtime-loop.js";
import {
  appendInboundFrame,
  markSpeechStart,
  markEndpointDetected,
  getAudioSessionMetrics
} from "./audio-session.js";
import { observeAudioFrame } from "./vad-endpointing.js";
import { pcmFrameRms } from "./pcm-rms.js";
import {
  buildVadSpeechStartEvent,
  buildVadEndpointDetectedEvent
} from "./quality-events.js";
import {
  beginUtteranceCapture,
  appendUtteranceFrame,
  runLiveSttOnEndpoint,
  resetUtteranceBuffer
} from "./live-stt-endpoint.js";
import { beginLiveTurnLatency } from "./live-turn-latency.js";
import { observeLiveCanaryBargeIn } from "./live-barge-in-endpoint.js";
import { shouldRunInterruptFollowupTimeout } from "./interrupt-followup-wait.js";
import { runInterruptFollowupTimeoutClarification } from "./live-interrupt-followup-endpoint.js";
import { flushLiveCanaryQualityEvents } from "./live-quality-flush-endpoint.js";

/**
 * Parse allowlist entries from config (comma/semicolon/whitespace separated).
 * Empty list always blocks live v4.
 */
export function normalizeLiveCanaryAllowlist(config) {
  const raw = config?.v4?.liveCanaryAllowlist;
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  }
  return [];
}

/**
 * Allowlist match rules (documented for operators/tests):
 * - Empty allowlist → no match (live v4 blocked).
 * - Each entry is compared against bridge_call_id and external_call_id.
 * - Match if id equals entry, starts with entry, or contains entry (substring).
 * - Does not use caller phone fields (privacy).
 */
export function matchLiveCanaryAllowlist(ctx, allowlist) {
  const entries = Array.isArray(allowlist) ? allowlist : [];
  if (entries.length === 0) return false;

  const bridge = String(ctx?.bridgeCallId ?? "").trim();
  const external = String(ctx?.externalCallId ?? "").trim();
  if (!bridge && !external) return false;

  for (const entry of entries) {
    const needle = String(entry ?? "").trim();
    if (!needle) continue;
    for (const id of [bridge, external]) {
      if (!id) continue;
      if (id === needle || id.startsWith(needle) || id.includes(needle)) {
        return true;
      }
    }
  }
  return false;
}

export function canActivateLiveV4Canary(config, ctx) {
  const runtimeVersion = String(config?.v4?.runtimeVersion ?? "v3")
    .trim()
    .toLowerCase();
  if (runtimeVersion !== "v4") {
    return { ok: false, reason: "runtime_not_v4" };
  }
  if (!Boolean(config?.v4?.realtimeEnabled)) {
    return { ok: false, reason: "v4_realtime_disabled" };
  }
  if (!Boolean(config?.v4?.canaryEnabled)) {
    return { ok: false, reason: "v4_canary_disabled" };
  }
  if (!canPrepareV4CanaryMedia(config)) {
    return { ok: false, reason: "v4_canary_prerequisites_missing" };
  }
  if (!Boolean(config?.v4?.liveAudioSocketEnabled)) {
    return { ok: false, reason: "live_audiosocket_disabled" };
  }

  const allowlist = normalizeLiveCanaryAllowlist(config);
  if (allowlist.length === 0) {
    return { ok: false, reason: "live_canary_allowlist_empty" };
  }
  if (!matchLiveCanaryAllowlist(ctx, allowlist)) {
    return { ok: false, reason: "live_canary_allowlist_no_match" };
  }

  return { ok: true, reason: "live_canary_gates_passed" };
}

export function selectLiveCallHandler(config, ctx) {
  const gate = canActivateLiveV4Canary(config, ctx);
  if (!gate.ok) {
    return { handler: "v3", reason: gate.reason, runtime: null };
  }

  const runtime = createLiveCanaryRuntime(config, ctx);
  if (!runtime?.ok) {
    return {
      handler: "v3",
      reason: runtime?.reason ?? "live_canary_init_failed",
      runtime: null
    };
  }

  const mediaGate = validateLiveCanaryMediaRuntime(runtime);
  if (!mediaGate.ok) {
    return { handler: "v3", reason: mediaGate.reason, runtime: null };
  }

  return {
    handler: "v4_canary",
    reason: "v4_live_canary_selected",
    runtime
  };
}

export function shouldCaptureAssistantTurnAudio(ctx) {
  return ctx?.callHandler !== "v4_canary";
}

function liveLogIds(ctx) {
  return `bridge_call_id=${ctx?.bridgeCallId ?? "pending"} call_session_id=${ctx?.callSessionId ?? "pending"}`;
}

export function validateLiveCanaryMediaRuntime(runtime) {
  if (!runtime?.audioSession) {
    return { ok: false, reason: "live_canary_audio_session_missing" };
  }
  if (!runtime?.vadState) {
    return { ok: false, reason: "live_canary_vad_state_missing" };
  }
  if (!runtime?.sttAdapter) {
    return { ok: false, reason: "live_canary_stt_adapter_missing" };
  }
  return { ok: true, reason: "live_canary_media_ready" };
}

function bufferQualityEvent(runtime, event) {
  if (!runtime || !event) return;
  if (!Array.isArray(runtime.qualityEventsBuffer)) {
    runtime.qualityEventsBuffer = [];
  }
  runtime.qualityEventsBuffer.push(event);
}

function buildLiveVadQualityEvent(config, ctx, runtime, builder, metricValue, payload = {}) {
  return builder({
    config,
    agentConfigResult: runtime?.runtimeContext?.agentConfig ?? null,
    callSessionId: ctx?.callSessionId ?? runtime?.audioSession?.callSessionId ?? null,
    metricValue,
    payload: {
      bridge_call_id: ctx?.bridgeCallId ?? null,
      live_phase: runtime?.phase ?? "phase10b_live_vad",
      ...payload
    }
  });
}

/**
 * Process one inbound PCM frame for v4_canary (Phase 10B VAD + Phase 10C STT on endpoint).
 */
export async function processLiveCanaryInboundFrame(config, ctx, runtime, payload) {
  if (!runtime?.audioSession || !runtime?.vadState) {
    return { ok: false, reason: "live_canary_media_not_initialized" };
  }

  const frameBytes = payload?.length ?? 0;
  runtime.inboundFrameCount = (runtime.inboundFrameCount ?? 0) + 1;
  runtime.inboundBytes = (runtime.inboundBytes ?? 0) + frameBytes;

  try {
    observeLiveCanaryBargeIn(config, ctx, runtime, payload);
  } catch (err) {
    console.warn(
      `[v4-live] barge_in_observe_error ${liveLogIds(ctx)} error=${String(err?.message ?? err).slice(0, 120)}`
    );
  }

  if (shouldRunInterruptFollowupTimeout(runtime)) {
    try {
      await runInterruptFollowupTimeoutClarification(config, ctx, runtime);
    } catch (err) {
      console.warn(
        `[v4-live] interrupt_followup_timeout_error ${liveLogIds(ctx)} error=${String(err?.message ?? err).slice(0, 120)}`
      );
    }
  }

  const rms = pcmFrameRms(payload);
  const prevVad = runtime.vadState;
  const prevSpeechActive = Boolean(prevVad.speechActive);
  const prevEndpointAt = prevVad.endpointDetectedAt ?? null;
  const frameMs = Number(config?.frameMs ?? 20);
  let endpointTriggered = false;

  runtime.audioSession = appendInboundFrame(runtime.audioSession, { rms });
  runtime.vadState = observeAudioFrame(prevVad, payload, frameMs);
  const vad = runtime.vadState;

  if (!prevSpeechActive && vad.speechActive && vad.speechStartedAt) {
    runtime.speechStartCount = (runtime.speechStartCount ?? 0) + 1;
    runtime.audioSession = markSpeechStart(runtime.audioSession, vad.speechStartedAt);
    const speechStartMs = Math.max(0, vad.speechStartedAt - (runtime.startedAt ?? vad.speechStartedAt));

    console.log(
      `[v4-live] vad_speech_started speech_start_count=${runtime.speechStartCount} speech_start_ms=${speechStartMs} last_rms=${Math.round(rms)} ${liveLogIds(ctx)}`
    );

    bufferQualityEvent(
      runtime,
      buildLiveVadQualityEvent(config, ctx, runtime, buildVadSpeechStartEvent, speechStartMs, {
        last_rms: Math.round(rms)
      })
    );

    beginUtteranceCapture(runtime, ctx);
    appendUtteranceFrame(runtime, payload);
  } else if (runtime.utterance?.capturing) {
    appendUtteranceFrame(runtime, payload);
  }

  if (vad.endpointDetectedAt && vad.endpointDetectedAt !== prevEndpointAt) {
    endpointTriggered = true;
    runtime.endpointCount = (runtime.endpointCount ?? 0) + 1;
    runtime.audioSession = markEndpointDetected(runtime.audioSession, vad.endpointDetectedAt);
    const endpointMs =
      runtime.audioSession?.latency?.speech_to_endpoint_ms ??
      Math.max(0, vad.endpointDetectedAt - (vad.speechStartedAt ?? vad.endpointDetectedAt));

    console.log(
      `[v4-live] vad_endpoint_detected endpoint_count=${runtime.endpointCount} endpoint_ms=${endpointMs} last_rms=${Math.round(vad.lastRms ?? rms)} ${liveLogIds(ctx)}`
    );

    bufferQualityEvent(
      runtime,
      buildLiveVadQualityEvent(config, ctx, runtime, buildVadEndpointDetectedEvent, endpointMs, {
        last_rms: Math.round(vad.lastRms ?? rms)
      })
    );

    beginLiveTurnLatency(runtime, runtime.endpointCount ?? 0);

    try {
      await runLiveSttOnEndpoint(config, ctx, runtime);
    } catch (err) {
      console.error(
        `[v4-live] stt_endpoint_error ${liveLogIds(ctx)} error=${String(err?.message ?? err).slice(0, 120)}`
      );
      resetUtteranceBuffer(runtime);
    }
  }

  const n = runtime.inboundFrameCount;
  const every = Math.max(1, Number(config?.inboundLogEvery) || 50);
  if (n === 1 || n % every === 0) {
    console.log(
      `[v4-live] inbound_frame_count=${n} inbound_bytes=${runtime.inboundBytes} speech_active=${Boolean(vad.speechActive)} capturing_utterance=${Boolean(runtime.utterance?.capturing)} ${liveLogIds(ctx)}`
    );
  }

  return {
    ok: true,
    inboundFrameCount: runtime.inboundFrameCount,
    speechStartCount: runtime.speechStartCount ?? 0,
    endpointCount: runtime.endpointCount ?? 0,
    speechActive: Boolean(vad.speechActive),
    endpointTriggered,
    sttCompletedCount: runtime.sttCompletedCount ?? 0
  };
}

export async function startLiveCanaryCall(config, ctx, socket, runtime) {
  ctx.callHandler = "v4_canary";
  ctx.v4LiveRuntime = runtime;
  ctx.v4LiveSocket = socket;
  runtime.liveSocket = socket;
  runtime.startedAt = Date.now();

  console.log(`[v4-live] call_start handler=v4_canary phase=${runtime.phase ?? "phase10f"} ${liveLogIds(ctx)}`);

  try {
    await playGreetingAndKeepalive(config, ctx, socket, { skipAssistant: true });
  } catch (err) {
    console.error(
      `[v4-live] greeting_failed ${liveLogIds(ctx)} error=${String(err?.message ?? err).slice(0, 120)}`
    );
    throw err;
  }
}

export function handleLiveCanaryInboundFrame(config, ctx, _socket, payload) {
  if (ctx?.callHandler !== "v4_canary") return;

  const runtime = ctx.v4LiveRuntime;
  if (!runtime) return;

  void processLiveCanaryInboundFrame(config, ctx, runtime, payload).catch((err) => {
    console.error(
      `[v4-live] inbound_frame_error ${liveLogIds(ctx)} error=${String(err?.message ?? err).slice(0, 120)}`
    );
  });
}

export async function finishLiveCanaryCall(config, ctx, reason = "unknown", options = {}) {
  if (ctx?.callHandler !== "v4_canary") {
    return { ok: false, reason: "not_v4_canary_handler" };
  }

  const runtime = ctx.v4LiveRuntime;
  const frameCount = runtime?.inboundFrameCount ?? 0;
  const durationMs = runtime?.startedAt ? Math.max(0, Date.now() - runtime.startedAt) : null;
  const sessionMetrics = runtime?.audioSession ? getAudioSessionMetrics(runtime.audioSession) : null;

  let qualityFlush = { ok: false, reason: "not_run", inserted_count: 0, memory_only: true };
  if (runtime) {
    try {
      qualityFlush = await flushLiveCanaryQualityEvents(config, ctx, runtime, {
        insertFn: options.insertFn,
        persistQualityToDb: options.persistQualityToDb,
        closeReason: reason
      });
    } catch (err) {
      const message = String(err?.message ?? err).slice(0, 120);
      console.warn(
        `[v4-live] quality_flush_failed reason=finish_exception error=${message} ${liveLogIds(ctx)}`
      );
      qualityFlush = {
        ok: false,
        reason: "finish_exception",
        error: message,
        inserted_count: 0,
        memory_only: false
      };
    }
  }

  console.log(
    `[v4-live] call_end reason=${reason} inbound_frame_count=${frameCount} speech_start_count=${runtime?.speechStartCount ?? 0} endpoint_count=${runtime?.endpointCount ?? 0} stt_completed_count=${runtime?.sttCompletedCount ?? 0} dialogue_completed_count=${runtime?.dialogueCompletedCount ?? 0} tts_completed_count=${runtime?.ttsCompletedCount ?? 0} playback_completed_count=${runtime?.playbackCompletedCount ?? 0} barge_in_count=${runtime?.bargeInCount ?? 0} quality_inserted=${qualityFlush.inserted_count ?? 0} duration_ms=${durationMs ?? "unknown"} ${liveLogIds(ctx)}`
  );

  ctx.v4LiveRuntime = null;
  return {
    ok: true,
    reason,
    inboundFrameCount: frameCount,
    speechStartCount: runtime?.speechStartCount ?? 0,
    endpointCount: runtime?.endpointCount ?? 0,
    sttCompletedCount: runtime?.sttCompletedCount ?? 0,
    dialogueCompletedCount: runtime?.dialogueCompletedCount ?? 0,
    ttsCompletedCount: runtime?.ttsCompletedCount ?? 0,
    playbackCompletedCount: runtime?.playbackCompletedCount ?? 0,
    bargeInCount: runtime?.bargeInCount ?? 0,
    durationMs,
    sessionMetrics,
    qualityFlush
  };
}
