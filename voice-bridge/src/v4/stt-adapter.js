/**
 * v4 streaming/incremental STT adapter — Phase 1 placeholder.
 */

export function createSttAdapterStub({ enabled = false, provider = "openai" } = {}) {
  return {
    enabled: Boolean(enabled),
    provider,
    phase: "phase1_stub",
    streaming: false
  };
}

export function isStreamingSttEnabled(config) {
  return Boolean(config?.v4?.streamingSttEnabled);
}
