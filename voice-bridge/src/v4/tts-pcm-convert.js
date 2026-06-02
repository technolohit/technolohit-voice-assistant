/**
 * v4 TTS audio conversion — WAV (or other) to AudioSocket 8 kHz s16le mono PCM.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const defaultExecFile = promisify(execFile);

/**
 * Convert WAV bytes to 8 kHz signed-linear PCM via ffmpeg (fail-closed).
 */
export async function convertWavBufferToPcm8k(wavBuffer, execFileImpl = defaultExecFile) {
  if (!wavBuffer?.length) {
    return { ok: false, code: "wav_empty", message: "WAV input is empty" };
  }

  const dir = await mkdtemp(path.join(tmpdir(), "v4-tts-"));
  const wavPath = path.join(dir, "in.wav");
  const pcmPath = path.join(dir, "out.slin");

  try {
    await writeFile(wavPath, wavBuffer);
    await execFileImpl("ffmpeg", [
      "-y",
      "-i",
      wavPath,
      "-ar",
      "8000",
      "-ac",
      "1",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      pcmPath
    ]);

    const pcm = await readFile(pcmPath);
    if (!pcm.length) {
      return { ok: false, code: "pcm_empty", message: "PCM conversion produced empty audio" };
    }

    return { ok: true, pcm, sampleRate: 8000, bytes: pcm.length };
  } catch (err) {
    return {
      ok: false,
      code: "ffmpeg_convert_failed",
      message: String(err?.message ?? err).slice(0, 200)
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
