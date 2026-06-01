/**
 * v4 barge-in detector — speech during playback using Phase 3 VAD thresholds.
 */

import { pcmFrameRms } from "./pcm-rms.js";
import { getPlaybackMetrics } from "./playback-controller.js";

export function createBargeInDetector({
  rmsThreshold = 450,
  speechFramesRequired = 3,
  minPlaybackMs = 120,
  frameMs = 20
} = {}) {
  return {
    phase: "phase4_barge_in_detector",
    rmsThreshold: Number(rmsThreshold) || 450,
    speechFramesRequired: Math.max(1, Number(speechFramesRequired) || 3),
    minPlaybackMs: Math.max(0, Number(minPlaybackMs) || 120),
    frameMs: Number(frameMs) || 20,
    consecutiveSpeechFrames: 0,
    speechDetected: false,
    bargeInTriggered: false,
    triggeredAt: null,
    lastRms: 0,
    playbackMsAtTrigger: null,
    triggerCount: 0
  };
}

export function createBargeInDetectorFromConfig(config) {
  const v4 = config?.v4 ?? {};
  return createBargeInDetector({
    rmsThreshold: v4.bargeInRmsThreshold ?? v4.vadRmsThreshold ?? 450,
    speechFramesRequired: v4.bargeInSpeechFrames ?? v4.vadSpeechFrames ?? 3,
    minPlaybackMs: v4.bargeInMinPlaybackMs ?? 120,
    frameMs: config?.frameMs ?? 20
  });
}

function frameRms(frameOrRms) {
  return typeof frameOrRms === "number" ? frameOrRms : pcmFrameRms(frameOrRms);
}

function playbackElapsedMs(playback, atMs) {
  const metrics = getPlaybackMetrics(playback);
  if (metrics.started_at == null) return 0;
  return Math.max(0, (Number(atMs) || Date.now()) - metrics.started_at);
}

export function observeInboundDuringPlayback(detector, frameOrRms, playback, atMs = Date.now()) {
  const next = { ...detector };
  const rms = frameRms(frameOrRms);
  next.lastRms = rms;

  const elapsedMs = playbackElapsedMs(playback, atMs);
  if (elapsedMs < next.minPlaybackMs) {
    next.consecutiveSpeechFrames = 0;
    return next;
  }

  const isSpeech = rms >= next.rmsThreshold;
  if (isSpeech) {
    next.consecutiveSpeechFrames += 1;
  } else {
    next.consecutiveSpeechFrames = 0;
    next.speechDetected = false;
  }

  if (next.consecutiveSpeechFrames >= next.speechFramesRequired) {
    next.speechDetected = true;
  }

  return next;
}

export function shouldCancelPlaybackForSpeech(detector, playback, atMs = Date.now()) {
  if (!detector || !playback) return false;
  if (detector.bargeInTriggered) return true;
  const elapsedMs = playbackElapsedMs(playback, atMs);
  if (elapsedMs < detector.minPlaybackMs) return false;
  return detector.consecutiveSpeechFrames >= detector.speechFramesRequired;
}

export function markBargeInTriggered(detector, playback, atMs = Date.now()) {
  const ts = Number(atMs) || Date.now();
  return {
    ...detector,
    bargeInTriggered: true,
    triggeredAt: ts,
    playbackMsAtTrigger: playbackElapsedMs(playback, ts),
    triggerCount: Number(detector.triggerCount ?? 0) + 1
  };
}

export function resetBargeInDetector(detector) {
  return createBargeInDetector({
    rmsThreshold: detector?.rmsThreshold,
    speechFramesRequired: detector?.speechFramesRequired,
    minPlaybackMs: detector?.minPlaybackMs,
    frameMs: detector?.frameMs
  });
}

export function getBargeInMetrics(detector) {
  return {
    rms_threshold: detector?.rmsThreshold ?? null,
    speech_frames_required: detector?.speechFramesRequired ?? null,
    min_playback_ms: detector?.minPlaybackMs ?? null,
    frame_ms: detector?.frameMs ?? null,
    consecutive_speech_frames: detector?.consecutiveSpeechFrames ?? 0,
    speech_detected: Boolean(detector?.speechDetected),
    barge_in_triggered: Boolean(detector?.bargeInTriggered),
    triggered_at: detector?.triggeredAt ?? null,
    playback_ms_at_trigger: detector?.playbackMsAtTrigger ?? null,
    last_rms: detector?.lastRms ?? 0,
    trigger_count: detector?.triggerCount ?? 0
  };
}
