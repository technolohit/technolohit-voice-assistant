/**
 * Idempotent AudioSocket call teardown — v4 finish + persist.onCallEnded (Phase 10I/10J).
 */

import * as persist from "./persist.js";
import { stopSilenceWriter } from "./media-outbound.js";
import { finishLiveCanaryCall } from "./v4/live-audiosocket-handler.js";
import { runPostCallProcessing } from "./post-call.js";
import {
  unregisterActiveCall,
  listActiveCalls,
  getActiveCallRegistrySize
} from "./active-call-registry.js";
import { recordLiveCallSummary } from "./live-call-quality.js";

function callFinishLogLabel(ctx) {
  return `bridge_call_id=${ctx?.bridgeCallId ?? "pending"} call_session_id=${ctx?.callSessionId ?? "pending"} handler=${ctx?.callHandler ?? "unknown"}`;
}

export async function finalizeAudioSocketCall(config, ctx, reason, deps = {}) {
  if (ctx.closed || ctx.finishInProgress) {
    console.log(
      `[voice-bridge] call_finish_skipped_already_finalized close_reason=${reason} ${callFinishLogLabel(ctx)} active_call_registry_size=${getActiveCallRegistrySize()}`
    );
    return { ok: false, reason: "already_finalized" };
  }

  console.log(
    `[voice-bridge] call_finish_started close_reason=${reason} ${callFinishLogLabel(ctx)} active_call_registry_size=${getActiveCallRegistrySize()}`
  );

  ctx.finishInProgress = true;
  ctx.closed = true;
  stopSilenceWriter(ctx);

  const finishLive = deps.finishLiveCanaryCall ?? finishLiveCanaryCall;
  const onCallEnded = deps.onCallEnded ?? persist.onCallEnded.bind(persist);
  const triggerPostCall = deps.runPostCallProcessing ?? runPostCallProcessing;

  let v4FinishResult = null;
  if (ctx.callHandler === "v4_canary") {
    try {
      v4FinishResult = await finishLive(config, ctx, reason, deps.finishLiveOptions ?? {});
    } catch (err) {
      console.error(`[v4-live] call_end_error error=${err?.message ?? String(err)}`);
      v4FinishResult = { ok: false, reason: "finish_exception", error: String(err?.message ?? err) };
    }
  }

  if (!ctx.callEndedPersisted) {
    ctx.callEndedPersisted = true;
    try {
      await onCallEnded(config, ctx, {
        closeReason: reason,
        framesReceived: ctx.framesReceived,
        bytesReceived: ctx.bytesReceived
      });
    } catch (err) {
      console.error(
        `[voice-bridge] call_end_persist_failed ${persist.callLogLabel(ctx)} error=${err?.message ?? String(err)}`
      );
    }
  }

  await recordLiveCallSummary(config, ctx, reason);

  unregisterActiveCall(ctx);

  console.log(
    `[voice-bridge] call_finish_persisted close_reason=${reason} call_ended_persisted=${ctx.callEndedPersisted} ${callFinishLogLabel(ctx)} active_call_registry_size=${getActiveCallRegistrySize()}`
  );

  if (v4FinishResult && ctx.callHandler === "v4_canary") {
    console.log(
      `[v4-live] call_finish_persisted close_reason=${reason} call_session_id=${ctx.callSessionId ?? "pending"} quality_flush_ok=${Boolean(v4FinishResult?.ok)}`
    );
  }

  let postCallTriggeredNow = false;
  if (!ctx.postCallTriggered) {
    ctx.postCallTriggered = true;
    postCallTriggeredNow = true;
    console.log(
      `[post-call] trigger start call_session_id=${ctx.callSessionId ?? ""} external_call_id=${ctx.externalCallId ?? ""} reason=${reason}`
    );
    void triggerPostCall(config, ctx).catch((err) => {
      console.error(`[post-call] trigger failed: ${err?.message ?? String(err)}`);
    });
  }

  ctx.finishInProgress = false;

  return {
    ok: true,
    reason,
    v4FinishResult,
    callEndedPersisted: ctx.callEndedPersisted,
    postCallTriggeredNow
  };
}

/**
 * Finalize all in-process active calls (SIGTERM/SIGINT before exit).
 */
export async function finalizeAllActiveCallsOnShutdown(config, reason = "process_shutdown", deps = {}) {
  const entries = listActiveCalls();
  console.log(
    `[voice-bridge] active_call_shutdown_started reason=${reason} active_call_registry_size=${entries.length}`
  );

  for (const entry of entries) {
    const { ctx } = entry;
    if (!ctx || ctx.closed) continue;
    await finalizeAudioSocketCall(config, ctx, reason, deps);
  }

  console.log(
    `[voice-bridge] active_call_shutdown_completed reason=${reason} active_call_registry_size=${getActiveCallRegistrySize()}`
  );
}
