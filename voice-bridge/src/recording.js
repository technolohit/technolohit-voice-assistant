import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function maxRecordingBytes(config) {
  const seconds = Math.max(0, Number(config.recording?.maxSeconds ?? 300));
  return Math.floor(config.sampleRate * 2 * seconds);
}

function recordingState(ctx) {
  if (!ctx.recording) {
    ctx.recording = {
      chunks: [],
      bytes: 0,
      limitReached: false
    };
  }
  return ctx.recording;
}

export function captureInboundAudio(config, ctx, payload) {
  if (!config.recording?.enabled) return;
  if (!payload?.length) return;

  const state = recordingState(ctx);
  if (state.limitReached) return;

  const maxBytes = maxRecordingBytes(config);
  if (maxBytes <= 0 || state.bytes + payload.length > maxBytes) {
    state.limitReached = true;
    console.warn(
      `[voice-recording] max recording buffer reached bridge_call_id=${ctx.bridgeCallId ?? "pending"} bytes=${state.bytes} max_bytes=${maxBytes}; stopped buffering`
    );
    return;
  }

  state.chunks.push(Buffer.from(payload));
  state.bytes += payload.length;
}

async function fileSize(filePath) {
  const stat = await fs.stat(filePath);
  return stat.size;
}

async function convertSlinToWav(inputPath, outputPath) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "s16le",
    "-ar",
    "8000",
    "-ac",
    "1",
    "-i",
    inputPath,
    outputPath
  ]);
}

export async function writeRecordingFiles(config, ctx) {
  if (!config.recording?.enabled) {
    return null;
  }

  const state = ctx.recording;
  if (!state?.bytes || !state.chunks?.length) {
    console.log(`[voice-recording] no inbound audio captured bridge_call_id=${ctx.bridgeCallId}`);
    return null;
  }

  const dir = String(config.recording.dir || "/app/recordings");
  const baseName = String(ctx.bridgeCallId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const slinPath = path.join(dir, `${baseName}.slin`);
  const wavPath = path.join(dir, `${baseName}.wav`);
  const pcm = Buffer.concat(state.chunks, state.bytes);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(slinPath, pcm);
  console.log(`[voice-recording] wrote ${slinPath} bytes=${pcm.length}`);

  await convertSlinToWav(slinPath, wavPath);
  const wavBytes = await fileSize(wavPath);
  console.log(`[voice-recording] converted ${wavPath} bytes=${wavBytes}`);

  return {
    slinPath,
    wavPath,
    audioBytes: pcm.length,
    wavBytes,
    limitReached: Boolean(state.limitReached)
  };
}
