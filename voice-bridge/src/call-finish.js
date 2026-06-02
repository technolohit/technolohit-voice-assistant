/**
 * Idempotent AudioSocket call teardown — v4 finish + persist.onCallEnded (Phase 10I).
 */

import * as persist from "./persist.js";
import { stopSilenceWriter } from "./media-outbound.js";
import { finishLiveCanaryCall } from "./v4/live-audiosocket-handler.js";
import { runPostCallProcessing } from "./post-call.js";

export async function finalizeAudioSocketCall(config, ctx, reason, deps = {}) {
  if (ctx.closed || ctx.finishInProgress) {
    return { ok: false, reason: "already_finalized" };
  }

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

  if (v4FinishResult && ctx.callHandler === "v4_canary") {
    console.log(
      `[v4-live] call_finish_persisted close_reason=${reason} call_session_id=${ctx.callSessionId ?? "pending"} call_ended_persisted=${ctx.callEndedPersisted}`
    );
  }

  if (ctx.postCallTriggered) {
    ctx.finishInProgress = false;
    return { ok: true, reason, v4FinishResult, callEndedPersisted: ctx.callEndedPersisted };
  }

  ctx.postCallTriggered = true;
  console.log(
    `[post-call] trigger start call_session_id=${ctx.callSessionId ?? ""} external_call_id=${ctx.externalCallId ?? ""} reason=${reason}`
  );
  void triggerPostCall(config, ctx).catch((err) => {
    console.error(`[post-call] trigger failed: ${err?.message ?? String(err)}`);
  });
  ctx.finishInProgress = false;

  return { ok: true, reason, v4FinishResult, callEndedPersisted: ctx.callEndedPersisted };
}
