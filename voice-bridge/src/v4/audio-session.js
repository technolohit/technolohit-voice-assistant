/**
 * v4 audio session abstraction — Phase 3 media foundation.
 * Tracks inbound/outbound frames and timing without logging transcripts or phone data.
 */

import { V4_STATES } from "./state-machine.js";

const CLOSED = "closed";

export function createAudioSession({
  bridgeCallId,
  sampleRate = 8000,
  frameMs = 20,
  memory = null,
  stateMachine = null,
  callSessionId = null
} = {}) {
  const now = Date.now();
  return {
    bridgeCallId: String(bridgeCallId ?? "pending"),
    callSessionId: callSessionId ? String(callSessionId) : null,
    sampleRate: Number(sampleRate) || 8000,
    frameMs: Number(frameMs) || 20,
    phase: "phase3_media",
    status: "open",
    createdAt: now,
    closedAt: null,
    memoryRef: memory ?? null,
    stateMachineRef: stateMachine ?? null,
    inboundFrames: 0,
    outboundFrames: 0,
    speechStartedAt: null,
    speechEndedAt: null,
    endpointDetectedAt: null,
    playbackStartedAt: null,
    playbackCompletedAt: null,
    interruptionDetectedAt: null,
    latency: {
      speech_to_endpoint_ms: null,
      playback_duration_ms: null,
      interruption_after_playback_ms: null
    }
  };
}

export function appendInboundFrame(session, frameMeta = {}) {
  assertOpen(session);
  const next = { ...session, inboundFrames: session.inboundFrames + 1 };
  if (frameMeta?.rms != null) {
    next.lastInboundRms = Number(frameMeta.rms);
  }
  return next;
}

export function appendOutboundFrame(session, frameMeta = {}) {
  assertOpen(session);
  const next = { ...session, outboundFrames: session.outboundFrames + 1 };
  if (frameMeta?.bytes != null) {
    next.lastOutboundBytes = Number(frameMeta.bytes);
  }
  return next;
}

export function markSpeechStart(session, atMs = Date.now()) {
  assertOpen(session);
  const ts = Number(atMs) || Date.now();
  return {
    ...session,
    speechStartedAt: session.speechStartedAt ?? ts,
    speechEndedAt: null,
    endpointDetectedAt: null
  };
}

export function markSpeechEnd(session, atMs = Date.now()) {
  assertOpen(session);
  const ts = Number(atMs) || Date.now();
  const next = { ...session, speechEndedAt: ts };
  if (next.speechStartedAt != null) {
    next.latency = {
      ...next.latency,
      speech_to_endpoint_ms: ts - next.speechStartedAt
    };
  }
  return next;
}

export function markEndpointDetected(session, atMs = Date.now()) {
  assertOpen(session);
  const ts = Number(atMs) || Date.now();
  const next = { ...session, endpointDetectedAt: ts };
  if (next.speechStartedAt != null && next.latency.speech_to_endpoint_ms == null) {
    next.latency = {
      ...next.latency,
      speech_to_endpoint_ms: ts - next.speechStartedAt
    };
  }
  return next;
}

export function markPlaybackStarted(session, atMs = Date.now()) {
  assertOpen(session);
  return {
    ...session,
    playbackStartedAt: Number(atMs) || Date.now(),
    playbackCompletedAt: null
  };
}

export function markPlaybackCompleted(session, atMs = Date.now()) {
  assertOpen(session);
  const ts = Number(atMs) || Date.now();
  const next = { ...session, playbackCompletedAt: ts };
  if (next.playbackStartedAt != null) {
    next.latency = {
      ...next.latency,
      playback_duration_ms: ts - next.playbackStartedAt
    };
  }
  return next;
}

export function markInterrupted(session, atMs = Date.now()) {
  assertOpen(session);
  const ts = Number(atMs) || Date.now();
  const next = { ...session, interruptionDetectedAt: ts };
  if (next.playbackStartedAt != null) {
    next.latency = {
      ...next.latency,
      interruption_after_playback_ms: ts - next.playbackStartedAt
    };
  }
  if (next.stateMachineRef?.state === V4_STATES.SPEAKING) {
    next.stateMachineRef = {
      ...next.stateMachineRef,
      pendingInterruption: true
    };
  }
  return next;
}

export function closeAudioSession(session, atMs = Date.now()) {
  if (!session || session.status === CLOSED) {
    return session ?? null;
  }
  return {
    ...session,
    status: CLOSED,
    closedAt: Number(atMs) || Date.now()
  };
}

export function getAudioSessionMetrics(session) {
  if (!session) {
    return {
      bridge_call_id: null,
      sample_rate: null,
      frame_ms: null,
      inbound_frames: 0,
      outbound_frames: 0,
      is_open: false,
      latency: {}
    };
  }

  return {
    bridge_call_id: session.bridgeCallId,
    call_session_id: session.callSessionId,
    sample_rate: session.sampleRate,
    frame_ms: session.frameMs,
    inbound_frames: session.inboundFrames,
    outbound_frames: session.outboundFrames,
    speech_started_at: session.speechStartedAt,
    speech_ended_at: session.speechEndedAt,
    endpoint_detected_at: session.endpointDetectedAt,
    playback_started_at: session.playbackStartedAt,
    playback_completed_at: session.playbackCompletedAt,
    interruption_detected_at: session.interruptionDetectedAt,
    memory_state: session.memoryRef?.current_state ?? null,
    state_machine_state: session.stateMachineRef?.state ?? null,
    is_open: session.status !== CLOSED,
    latency: { ...(session.latency ?? {}) }
  };
}

export function describeAudioSession(session) {
  const metrics = getAudioSessionMetrics(session);
  return {
    bridge_call_id: metrics.bridge_call_id,
    sample_rate: metrics.sample_rate,
    frame_ms: metrics.frame_ms,
    phase: session?.phase ?? "unknown",
    is_active: metrics.is_open
  };
}

/** @deprecated Phase 1 alias — use createAudioSession */
export function createAudioSessionStub(options = {}) {
  return createAudioSession(options);
}

function assertOpen(session) {
  if (!session) {
    throw new Error("audio session required");
  }
  if (session.status === CLOSED) {
    throw new Error("audio session is closed");
  }
}
