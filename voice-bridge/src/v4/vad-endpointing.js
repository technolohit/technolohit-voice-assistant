/**
 * v4 VAD/endpointing module — Phase 1 placeholder.
 */

export function createVadEndpointingStub({ rmsThreshold = 450, speechFramesRequired = 3 } = {}) {
  return {
    rmsThreshold,
    speechFramesRequired,
    consecutiveSpeechFrames: 0,
    phase: "phase1_stub"
  };
}

export function observeInboundFrame(state, rms) {
  const next = { ...state, consecutiveSpeechFrames: state?.consecutiveSpeechFrames ?? 0 };
  if (Number(rms) >= Number(state?.rmsThreshold ?? 450)) {
    next.consecutiveSpeechFrames += 1;
  } else {
    next.consecutiveSpeechFrames = 0;
  }
  next.speechDetected =
    next.consecutiveSpeechFrames >= Number(state?.speechFramesRequired ?? 3);
  return next;
}
