import { encodeFrame, FrameType } from "./audiosocket-protocol.js";
import { iteratePcmChunks, pcmChunkBytes, resolveGreetingPcm } from "./audio-media.js";
import * as persist from "./persist.js";
import { startOneTurnAssistant } from "./turn-assistant.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeFrame(socket, type, payload) {
  return new Promise((resolve, reject) => {
    const frame = encodeFrame(type, payload);
    const ok = socket.write(frame);
    if (ok) return resolve();
    socket.once("drain", resolve);
    socket.once("error", reject);
  });
}

/**
 * Stream PCM to Asterisk in fixed 20ms (configurable) frames.
 * Optional playbackSession (Phase 0B spike): exits early when session.cancelled is set.
 */
export async function streamPcmToSocket(socket, pcm, config, label, options = {}) {
  const playbackSession = options?.playbackSession ?? null;
  const chunkBytes = pcmChunkBytes(config.sampleRate, config.frameMs);
  const frameType = FrameType.AUDIO_SLIN16_8K;
  let frames = 0;
  let bytes = 0;

  console.log(`[voice-bridge] sending ${label} (${pcm.length} bytes pcm, chunk=${chunkBytes})`);

  for (const chunk of iteratePcmChunks(pcm, chunkBytes)) {
    if (!socket.writable) break;
    if (playbackSession?.cancelled) break;
    await writeFrame(socket, frameType, chunk);
    frames += 1;
    bytes += chunk.length;
    if (playbackSession) {
      playbackSession.framesSent = frames;
      playbackSession.bytesSent = bytes;
    }
    if (playbackSession?.cancelled) break;
    await sleep(config.frameMs);
  }

  const cancelled = Boolean(playbackSession?.cancelled);
  if (cancelled) {
    console.log(
      `[voice-bridge] cancelled sending ${label} frames=${frames} bytes=${bytes} reason=${playbackSession.cancelReason ?? "unknown"}`
    );
  } else {
    console.log(`[voice-bridge] finished sending ${label} frames=${frames} bytes=${bytes}`);
  }

  return { frames, bytes, cancelled, cancelReason: playbackSession?.cancelReason ?? null };
}

export async function playGreetingAndKeepalive(config, ctx, socket, options = {}) {
  const skipAssistant = Boolean(options?.skipAssistant);
  if (ctx.greetingHandled) return;
  ctx.greetingHandled = true;

  let resolved;
  try {
    resolved = resolveGreetingPcm(config);
  } catch (err) {
    console.error(`[voice-bridge] greeting error: ${err.message}`);
    await persist.onError(config, ctx, err, { phase: "greeting_resolve" });
    startSilenceWriter(config, ctx, socket);
    return;
  }

  if (resolved.skipped) {
    console.log(`[voice-bridge] greeting skipped (${resolved.reason ?? "no source"})`);
    await persist.onGreetingSkipped(config, ctx, {
      reason: resolved.reason ?? "no_greeting_file",
      greeting_mode: config.greetingMode,
      greeting_file: resolved.requestedFile ?? ""
    });
    startSilenceWriter(config, ctx, socket);
    return;
  }

  try {
    if (resolved.fallbackReason) {
      console.warn(
        `[voice-bridge] greeting file unavailable (${resolved.fallbackReason}); falling back to generated tone`
      );
    }
    console.log(`[voice-bridge] sending greeting (${resolved.source}: ${resolved.label})`);
    await persist.onGreetingPlayed(config, ctx, {
      greetingFile: resolved.source === "file" ? resolved.label : "",
      greetingType: resolved.source,
      greetingSource: resolved.source,
      fallbackReason: resolved.fallbackReason ?? "",
      requestedFile: resolved.requestedFile ?? ""
    });

    await streamPcmToSocket(socket, resolved.pcm, config, "greeting");
    startSilenceWriter(config, ctx, socket);
    if (!skipAssistant) {
      startOneTurnAssistant(config, ctx, socket, {
        streamPcmToSocket,
        startSilenceWriter,
        stopSilenceWriter
      });
    }
  } catch (err) {
    console.error(`[voice-bridge] greeting playback failed: ${err.message}`);
    await persist.onError(config, ctx, err, { phase: "greeting_playback" });
    startSilenceWriter(config, ctx, socket);
  }
}

export function startSilenceWriter(config, ctx, socket) {
  if (ctx.silenceTimer) return;

  const chunkBytes = pcmChunkBytes(config.sampleRate, config.frameMs);
  const silence = Buffer.alloc(chunkBytes);
  const frameType = FrameType.AUDIO_SLIN16_8K;

  console.log("[voice-bridge] starting silence writer");

  ctx.silenceTimer = setInterval(() => {
    if (!socket.writable || ctx.closed) {
      stopSilenceWriter(ctx);
      return;
    }
    try {
      socket.write(encodeFrame(frameType, silence));
    } catch (err) {
      console.error(`[voice-bridge] silence write error: ${err.message}`);
      stopSilenceWriter(ctx);
    }
  }, config.frameMs);

  ctx.silenceTimer.unref?.();
}

export function stopSilenceWriter(ctx) {
  if (ctx.silenceTimer) {
    clearInterval(ctx.silenceTimer);
    ctx.silenceTimer = null;
  }
}
