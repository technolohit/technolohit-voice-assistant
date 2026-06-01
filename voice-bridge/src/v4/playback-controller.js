/**
 * v4 playback controller — Phase 1 placeholder.
 * Production playback cancel must use VOICE_V4_BARGE_IN_ENABLED, not Phase 0B spike flags.
 */

export function createPlaybackControllerStub({ enabled = false } = {}) {
  return {
    enabled: Boolean(enabled),
    phase: "phase1_stub",
    cancelRequested: false
  };
}

export function requestPlaybackCancel(controller, reason = "unknown") {
  if (!controller) return { ok: false, reason: "controller_missing" };
  controller.cancelRequested = true;
  controller.cancelReason = String(reason);
  return { ok: true, reason: controller.cancelReason };
}
