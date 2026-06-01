import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { streamPcmToSocket } from "../src/media-outbound.js";
import { generateTestTonePcm } from "../src/audio-media.js";
import {
  createPlaybackSession,
  finalizePlaybackSession,
  isPlaybackCancelSpikeEnabled,
  monitorInboundDuringPlayback,
  requestPlaybackCancel
} from "../src/playback-session.js";

function mockSocket(initialWritable = true) {
  const writes = [];
  return {
    writes,
    socket: {
      writable: initialWritable,
      write(data) {
        if (!this.writable) return false;
        writes.push(Buffer.from(data));
        return true;
      },
      once() {}
    }
  };
}

function spikeConfig(overrides = {}) {
  return {
    sampleRate: 8000,
    frameMs: 1,
    v4PlaybackCancelSpike: {
      enabled: true,
      speechRmsThreshold: 450,
      speechFramesRequired: 2,
      ...overrides
    }
  };
}

test("loadConfig defaults playback cancel spike to disabled", () => {
  const prev = process.env.VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED;
  delete process.env.VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED;
  const config = loadConfig();
  assert.equal(config.v4PlaybackCancelSpike.enabled, false);
  if (prev === undefined) {
    delete process.env.VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED;
  } else {
    process.env.VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED = prev;
  }
});

test("isPlaybackCancelSpikeEnabled is false when flag off", () => {
  assert.equal(isPlaybackCancelSpikeEnabled({ v4PlaybackCancelSpike: { enabled: false } }), false);
  assert.equal(isPlaybackCancelSpikeEnabled({}), false);
});

test("streamPcmToSocket completes all frames without playback session", async () => {
  const { socket, writes } = mockSocket();
  const pcm = generateTestTonePcm(8000, 40, 440);
  const config = { sampleRate: 8000, frameMs: 1 };
  const stats = await streamPcmToSocket(socket, pcm, config, "test");
  assert.equal(stats.cancelled, false);
  assert.ok(stats.frames > 0);
  assert.ok(writes.length > 0);
});

test("streamPcmToSocket exits early when playback session is cancelled", async () => {
  const { socket, writes } = mockSocket();
  const pcm = generateTestTonePcm(8000, 200, 440);
  const config = { sampleRate: 8000, frameMs: 1 };
  const session = createPlaybackSession(config, { bridgeCallId: "test-bridge" }, {
    label: "assistant response",
    turnIndex: 1
  });

  const streamPromise = streamPcmToSocket(socket, pcm, config, "test", {
    playbackSession: session
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  requestPlaybackCancel(config, { bridgeCallId: "test-bridge" }, session, "test_cancel");

  const stats = await streamPromise;
  assert.equal(stats.cancelled, true);
  assert.equal(stats.cancelReason, "test_cancel");
  assert.ok(stats.frames > 0);
  assert.ok(stats.frames < 20);
});

test("streamPcmToSocket does not write after socket becomes non-writable", async () => {
  const { socket, writes } = mockSocket();
  const pcm = generateTestTonePcm(8000, 120, 440);
  const config = { sampleRate: 8000, frameMs: 1 };

  const streamPromise = streamPcmToSocket(socket, pcm, config, "test");
  await new Promise((resolve) => setTimeout(resolve, 3));
  socket.writable = false;
  const stats = await streamPromise;
  const writeCountAfterClose = writes.length;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(writes.length, writeCountAfterClose);
  assert.ok(stats.frames > 0);
});

test("monitorInboundDuringPlayback requests cancel after consecutive speech frames", () => {
  const config = spikeConfig({ speechFramesRequired: 2, speechRmsThreshold: 100 });
  const ctx = { bridgeCallId: "test-bridge" };
  const session = createPlaybackSession(config, ctx, { label: "assistant response", turnIndex: 1 });

  const loud = Buffer.alloc(320);
  for (let i = 0; i < loud.length; i += 2) {
    loud.writeInt16LE(8000, i);
  }

  monitorInboundDuringPlayback(config, ctx, session, loud);
  assert.equal(session.cancelled, false);
  monitorInboundDuringPlayback(config, ctx, session, loud);
  assert.equal(session.cancelled, true);
  assert.equal(session.cancelReason, "inbound_speech_detected");
});

test("monitorInboundDuringPlayback is inactive when spike flag is off", () => {
  const config = {
    v4PlaybackCancelSpike: { enabled: false, speechRmsThreshold: 100, speechFramesRequired: 1 }
  };
  const session = createPlaybackSession(config, { bridgeCallId: "test-bridge" }, {
    label: "assistant response",
    turnIndex: 1
  });
  const loud = Buffer.alloc(320);
  for (let i = 0; i < loud.length; i += 2) {
    loud.writeInt16LE(8000, i);
  }
  monitorInboundDuringPlayback(config, { bridgeCallId: "test-bridge" }, session, loud);
  assert.equal(session.cancelled, false);
});

test("finalizePlaybackSession records cancel latency", () => {
  const config = spikeConfig();
  const ctx = { bridgeCallId: "test-bridge" };
  const session = createPlaybackSession(config, ctx, { label: "assistant response", turnIndex: 1 });
  requestPlaybackCancel(config, ctx, session, "inbound_speech_detected");
  session.framesSent = 4;
  finalizePlaybackSession(config, ctx, session);
  assert.ok(session.cancelLatencyMs !== null);
  assert.ok(session.cancelLatencyMs >= 0);
});
