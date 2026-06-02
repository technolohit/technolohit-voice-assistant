/**
 * Phase 10P — run interrupt-followup timeout clarification on live canary path.
 */

import { runLiveDialogueOnCallerTranscript } from "./live-dialogue-endpoint.js";
import { runLiveTtsAndPlayback } from "./live-tts-playback-endpoint.js";
import {
  clearInterruptFollowupWait,
  markInterruptFollowupTimeoutStarted,
  bufferInterruptFollowupTimeoutEvent,
} from "./interrupt-followup-wait.js";
import {
  finalizeInterruptFollowupLatencyMetrics,
  markInterruptFollowupLatency,
} from "./interrupt-followup-latency.js";
import { buildInterruptFollowupLatencyMetricsEvent } from "./quality-events.js";

function liveLogIds(ctx) {
  return `bridge_call_id=${ctx?.bridgeCallId ?? "pending"} call_session_id=${ctx?.callSessionId ?? "pending"}`;
}

function bufferQualityEvent(runtime, event) {
  if (!runtime || !event) return;
  if (!Array.isArray(runtime.qualityEventsBuffer))
    runtime.qualityEventsBuffer = [];
  runtime.qualityEventsBuffer.push(event);
}

/**
 * After wait window expires with only a marker utterance, ask a short clarification (no immediate Gerne on marker STT).
 */
export async function runInterruptFollowupTimeoutClarification(
  config,
  ctx,
  runtime,
) {
  if (runtime?.interruptFollowup?.timeoutResponseStarted) {
    return { ok: false, reason: "timeout_already_started" };
  }

  markInterruptFollowupTimeoutStarted(runtime);
  bufferInterruptFollowupTimeoutEvent(config, ctx, runtime);
  console.log(`[v4-live] interrupt_followup_timeout ${liveLogIds(ctx)}`);

  const candidate = {
    ok: true,
    transcript: "",
    transcriptChars: 0,
    interruptFollowupTimeout: true,
    endpointIndex: runtime.endpointCount ?? 0,
    atMs: Date.now(),
  };

  runtime.lastCallerTurnCandidate = candidate;

  let dialogue = { ok: false, reason: "not_run" };
  try {
    dialogue = await runLiveDialogueOnCallerTranscript(
      config,
      ctx,
      runtime,
      candidate,
    );
  } catch (err) {
    dialogue = {
      ok: false,
      reason: "dialogue_exception",
      error: String(err?.message ?? err),
    };
  }

  markInterruptFollowupLatency(runtime, "followup_stt_completed", Date.now());

  let playback = { ok: false, reason: "not_run" };
  if (dialogue?.ok) {
    markInterruptFollowupLatency(runtime, "followup_dialogue_plan", Date.now());
    try {
      playback = await runLiveTtsAndPlayback(config, ctx, runtime, dialogue);
      if (playback?.ok) {
        markInterruptFollowupLatency(
          runtime,
          "followup_playback_started",
          Date.now(),
        );
      }
    } catch (err) {
      playback = { ok: false, reason: "tts_playback_exception" };
    }
  }

  const interruptMetrics = finalizeInterruptFollowupLatencyMetrics(runtime);
  if (interruptMetrics) {
    bufferQualityEvent(
      runtime,
      buildInterruptFollowupLatencyMetricsEvent({
        config,
        agentConfigResult: runtime?.runtimeContext?.agentConfig ?? null,
        callSessionId: ctx?.callSessionId ?? null,
        metricValue: interruptMetrics.followup_plan_to_first_playback_ms,
        payload: interruptMetrics,
      }),
    );
  }

  clearInterruptFollowupWait(runtime);
  runtime.pendingInterruptionRecovery = false;
  runtime.highPriorityInterruptionTurn = false;

  return { ok: dialogue?.ok ?? false, dialogue, playback, interruptMetrics };
}
