/**
 * v4 audio session abstraction — Phase 1 placeholder only.
 * Realtime AudioSocket session wiring belongs to Phase 2.
 */

export function createAudioSessionStub({ bridgeCallId, sampleRate = 8000 }) {
  return {
    bridgeCallId: String(bridgeCallId ?? "pending"),
    sampleRate,
    phase: "phase1_stub",
    startedAt: Date.now(),
    isActive: false
  };
}

export function describeAudioSession(session) {
  return {
    bridge_call_id: session?.bridgeCallId ?? null,
    sample_rate: session?.sampleRate ?? null,
    phase: session?.phase ?? "unknown",
    is_active: Boolean(session?.isActive)
  };
}
