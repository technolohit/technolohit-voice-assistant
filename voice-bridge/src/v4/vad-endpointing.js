/**
 * v4 VAD/endpointing — RMS-based foundation (8 kHz PSTN frame assumptions).
 * Structured so WebRTC/Silero/etc. can replace observeAudioFrame internals later.
 */

import { pcmFrameRms } from "./pcm-rms.js";

export function createVadState({
  rmsThreshold = 450,
  speechFramesRequired = 3,
  endpointSilenceMs = 600,
  minSpeechMs = 240,
  frameMs = 20,
  sampleRate = 8000
} = {}) {
  return {
    rmsThreshold: Number(rmsThreshold) || 450,
    speechFramesRequired: Math.max(1, Number(speechFramesRequired) || 3),
    endpointSilenceMs: Math.max(0, Number(endpointSilenceMs) || 600),
    minSpeechMs: Math.max(0, Number(minSpeechMs) || 240),
    frameMs: Number(frameMs) || 20,
    sampleRate: Number(sampleRate) || 8000,
    phase: "phase3_rms_vad",
    consecutiveSpeechFrames: 0,
    consecutiveSilenceFrames: 0,
    speechActive: false,
    speechStartedAt: null,
    speechEndedAt: null,
    endpointDetectedAt: null,
    totalSpeechFrames: 0,
    totalSilenceFrames: 0,
    lastRms: 0,
    endpointPending: false
  };
}

export function observeAudioFrame(state, frameOrRms, frameMsOverride = null) {
  const next = { ...state };
  const frameMs = Number(frameMsOverride ?? state.frameMs ?? 20);

  let rms;
  if (typeof frameOrRms === "number") {
    rms = frameOrRms;
  } else {
    rms = pcmFrameRms(frameOrRms);
  }
  next.lastRms = rms;

  const isSpeech = rms >= next.rmsThreshold;
  if (isSpeech) {
    next.consecutiveSpeechFrames += 1;
    next.consecutiveSilenceFrames = 0;
    next.totalSpeechFrames += 1;
  } else {
    next.consecutiveSilenceFrames += 1;
    next.consecutiveSpeechFrames = 0;
    next.totalSilenceFrames += 1;
  }

  if (!next.speechActive && detectSpeechStart(next)) {
    next.speechActive = true;
    next.speechStartedAt = Date.now();
    next.speechEndedAt = null;
    next.endpointDetectedAt = null;
    next.endpointPending = false;
  }

  if (next.speechActive) {
    const speechDurationMs = next.totalSpeechFrames * frameMs;
    if (
      detectSpeechEnd(next) &&
      speechDurationMs >= next.minSpeechMs &&
      !next.endpointPending
    ) {
      next.endpointPending = true;
      next.speechEndedAt = Date.now();
    }

    if (next.endpointPending && detectEndpoint(next, frameMs)) {
      next.endpointDetectedAt = Date.now();
      next.speechActive = false;
      next.endpointPending = false;
      next.consecutiveSpeechFrames = 0;
      next.consecutiveSilenceFrames = 0;
      next.totalSpeechFrames = 0;
      next.totalSilenceFrames = 0;
    }
  }

  return next;
}

export function detectSpeechStart(state) {
  return Number(state?.consecutiveSpeechFrames ?? 0) >= Number(state?.speechFramesRequired ?? 3);
}

export function detectSpeechEnd(state) {
  return Number(state?.consecutiveSilenceFrames ?? 0) >= 1;
}

export function detectEndpoint(state, frameMs = null) {
  const ms = Number(frameMs ?? state?.frameMs ?? 20);
  const silenceMs = Number(state?.consecutiveSilenceFrames ?? 0) * ms;
  return silenceMs >= Number(state?.endpointSilenceMs ?? 600);
}

export function resetVad(state) {
  return createVadState({
    rmsThreshold: state?.rmsThreshold,
    speechFramesRequired: state?.speechFramesRequired,
    endpointSilenceMs: state?.endpointSilenceMs,
    minSpeechMs: state?.minSpeechMs,
    frameMs: state?.frameMs,
    sampleRate: state?.sampleRate
  });
}

export function getVadMetrics(state) {
  return {
    rms_threshold: state?.rmsThreshold ?? null,
    speech_frames_required: state?.speechFramesRequired ?? null,
    endpoint_silence_ms: state?.endpointSilenceMs ?? null,
    min_speech_ms: state?.minSpeechMs ?? null,
    frame_ms: state?.frameMs ?? null,
    sample_rate: state?.sampleRate ?? null,
    speech_active: Boolean(state?.speechActive),
    speech_started_at: state?.speechStartedAt ?? null,
    speech_ended_at: state?.speechEndedAt ?? null,
    endpoint_detected_at: state?.endpointDetectedAt ?? null,
    consecutive_speech_frames: state?.consecutiveSpeechFrames ?? 0,
    consecutive_silence_frames: state?.consecutiveSilenceFrames ?? 0,
    total_speech_frames: state?.totalSpeechFrames ?? 0,
    total_silence_frames: state?.totalSilenceFrames ?? 0,
    last_rms: state?.lastRms ?? 0
  };
}

/** @deprecated Phase 1 alias — use createVadState */
export function createVadEndpointingStub(options = {}) {
  return createVadState({
    rmsThreshold: options.rmsThreshold,
    speechFramesRequired: options.speechFramesRequired
  });
}

/** @deprecated — use observeAudioFrame */
export function observeInboundFrame(state, rms) {
  return observeAudioFrame(state, rms);
}
