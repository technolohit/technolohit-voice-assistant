/**
 * v4 streaming TTS adapter — Phase 1 placeholder.
 */

export function createTtsAdapterStub({ enabled = false, provider = "openai" } = {}) {
  return {
    enabled: Boolean(enabled),
    provider,
    phase: "phase1_stub",
    streaming: false
  };
}

export function isStreamingTtsEnabled(config) {
  return Boolean(config?.v4?.streamingTtsEnabled);
}
