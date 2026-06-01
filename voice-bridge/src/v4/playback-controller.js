/**
 * v4 playback controller — Phase 4 barge-in foundation.
 * Separate from Phase 0B spike path; no transcript/phone logging.
 */

let playbackCounter = 0;

const STATUS = {
  IDLE: "idle",
  PLAYING: "playing",
  CANCEL_REQUESTED: "cancel_requested",
  CANCELLED: "cancelled",
  COMPLETED: "completed"
};

export function createPlaybackController({
  enabled = false,
  bridgeCallId = "pending",
  turnIndex = null,
  label = "assistant_response"
} = {}) {
  playbackCounter += 1;
  return {
    enabled: Boolean(enabled),
    phase: "phase4_playback",
    playbackId: `playback-${playbackCounter}`,
    bridgeCallId: String(bridgeCallId),
    turnIndex: turnIndex == null ? null : Number(turnIndex),
    label: String(label ?? "assistant_response"),
    status: STATUS.IDLE,
    startedAt: null,
    cancelRequestedAt: null,
    cancelledAt: null,
    completedAt: null,
    framesSent: 0,
    bytesSent: 0,
    cancelReason: null,
    cancelLatencyMs: null,
    stoppedByBargeIn: false
  };
}

export function startPlayback(controller, atMs = Date.now()) {
  if (!controller?.enabled) {
    return { controller, ok: false, reason: "playback_disabled" };
  }
  const ts = Number(atMs) || Date.now();
  return {
    ok: true,
    controller: {
      ...controller,
      status: STATUS.PLAYING,
      startedAt: ts,
      cancelRequestedAt: null,
      cancelledAt: null,
      completedAt: null,
      framesSent: 0,
      bytesSent: 0,
      cancelReason: null,
      cancelLatencyMs: null,
      stoppedByBargeIn: false
    }
  };
}

export function observePlaybackFrameSent(controller, frameMeta = {}, atMs = Date.now()) {
  if (!controller || controller.status !== STATUS.PLAYING) {
    return { controller, ok: false, reason: "not_playing" };
  }
  const bytes = Number(frameMeta?.bytes ?? frameMeta?.frameBytes ?? 0) || 0;
  return {
    ok: true,
    controller: {
      ...controller,
      framesSent: controller.framesSent + 1,
      bytesSent: controller.bytesSent + bytes,
      lastFrameAt: Number(atMs) || Date.now()
    }
  };
}

export function requestPlaybackCancel(controller, reason = "barge_in", atMs = Date.now()) {
  if (!controller) {
    return { ok: false, reason: "controller_missing", controller: null };
  }
  if (controller.status !== STATUS.PLAYING && controller.status !== STATUS.CANCEL_REQUESTED) {
    return { ok: false, reason: "not_playing", controller };
  }
  const ts = Number(atMs) || Date.now();
  const cancelLatencyMs =
    controller.startedAt != null ? Math.max(0, ts - controller.startedAt) : null;
  const stoppedByBargeIn = String(reason).includes("barge_in") || reason === "caller_speech";
  return {
    ok: true,
    controller: {
      ...controller,
      status: STATUS.CANCEL_REQUESTED,
      cancelRequestedAt: controller.cancelRequestedAt ?? ts,
      cancelReason: String(reason),
      cancelLatencyMs,
      stoppedByBargeIn
    }
  };
}

export function shouldStopPlayback(controller) {
  if (!controller) return false;
  return (
    controller.status === STATUS.CANCEL_REQUESTED ||
    controller.status === STATUS.CANCELLED
  );
}

export function finalizePlayback(controller, outcome = "completed", atMs = Date.now()) {
  if (!controller) {
    return { ok: false, reason: "controller_missing", controller: null };
  }
  const ts = Number(atMs) || Date.now();
  if (outcome === "cancelled" || controller.status === STATUS.CANCEL_REQUESTED) {
    return {
      ok: true,
      controller: {
        ...controller,
        status: STATUS.CANCELLED,
        cancelledAt: controller.cancelledAt ?? ts,
        cancelLatencyMs:
          controller.cancelLatencyMs ??
          (controller.startedAt != null ? Math.max(0, ts - controller.startedAt) : null)
      }
    };
  }
  return {
    ok: true,
    controller: {
      ...controller,
      status: STATUS.COMPLETED,
      completedAt: ts
    }
  };
}

export function getPlaybackMetrics(controller) {
  if (!controller) {
    return {
      playback_id: null,
      bridge_call_id: null,
      turn_index: null,
      label: null,
      status: null,
      frames_sent: 0,
      bytes_sent: 0,
      cancel_reason: null,
      cancel_latency_ms: null,
      stopped_by_barge_in: false
    };
  }
  return {
    playback_id: controller.playbackId,
    bridge_call_id: controller.bridgeCallId,
    turn_index: controller.turnIndex,
    label: controller.label,
    status: controller.status,
    started_at: controller.startedAt,
    cancel_requested_at: controller.cancelRequestedAt,
    cancelled_at: controller.cancelledAt,
    completed_at: controller.completedAt,
    frames_sent: controller.framesSent,
    bytes_sent: controller.bytesSent,
    cancel_reason: controller.cancelReason,
    cancel_latency_ms: controller.cancelLatencyMs,
    stopped_by_barge_in: Boolean(controller.stoppedByBargeIn)
  };
}

/** @deprecated Phase 1 alias */
export function createPlaybackControllerStub(options = {}) {
  return createPlaybackController(options);
}
