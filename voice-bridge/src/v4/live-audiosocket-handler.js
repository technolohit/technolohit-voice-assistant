/**
 * Phase 10A — live AudioSocket v4 canary route selection (lifecycle logging only).
 * Fail closed to v3 on any gate or init failure; never drop calls.
 */

import { playGreetingAndKeepalive } from "../media-outbound.js";
import { canPrepareV4CanaryMedia } from "./audiosocket-runtime.js";
import { createLiveCanaryRuntime } from "./canary-runtime-loop.js";

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

export async function startLiveCanaryCall(config, ctx, socket, runtime) {
  ctx.callHandler = "v4_canary";
  ctx.v4LiveRuntime = runtime;
  runtime.startedAt = Date.now();

  console.log(`[v4-live] call_start handler=v4_canary phase=${runtime.phase ?? "phase10a"} ${liveLogIds(ctx)}`);

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

  try {
    const runtime = ctx.v4LiveRuntime;
    if (!runtime) return;

    runtime.inboundFrameCount = (runtime.inboundFrameCount ?? 0) + 1;
    runtime.inboundBytes = (runtime.inboundBytes ?? 0) + (payload?.length ?? 0);

    const n = runtime.inboundFrameCount;
    const every = Math.max(1, Number(config?.inboundLogEvery) || 50);
    if (n === 1 || n % every === 0) {
      console.log(
        `[v4-live] inbound_frame_count=${n} inbound_bytes=${runtime.inboundBytes} ${liveLogIds(ctx)}`
      );
    }
  } catch (err) {
    console.error(
      `[v4-live] inbound_frame_error ${liveLogIds(ctx)} error=${String(err?.message ?? err).slice(0, 120)}`
    );
  }
}

export function finishLiveCanaryCall(config, ctx, reason = "unknown") {
  if (ctx?.callHandler !== "v4_canary") {
    return { ok: false, reason: "not_v4_canary_handler" };
  }

  const runtime = ctx.v4LiveRuntime;
  const frameCount = runtime?.inboundFrameCount ?? 0;
  const durationMs = runtime?.startedAt ? Math.max(0, Date.now() - runtime.startedAt) : null;

  console.log(
    `[v4-live] call_end reason=${reason} inbound_frame_count=${frameCount} duration_ms=${durationMs ?? "unknown"} ${liveLogIds(ctx)}`
  );

  ctx.v4LiveRuntime = null;
  return { ok: true, reason, inboundFrameCount: frameCount, durationMs };
}
