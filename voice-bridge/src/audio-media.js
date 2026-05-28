import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function pcmChunkBytes(sampleRate, frameMs) {
  return Math.floor((sampleRate * frameMs) / 1000) * 2;
}

/**
 * Generate s16le mono PCM test tone (default greeting when no file).
 */
export function generateTestTonePcm(sampleRate, durationMs, frequencyHz = 440) {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequencyHz * t) * 0.25 * 32767;
    buf.writeInt16LE(Math.round(sample), i * 2);
  }
  return buf;
}

export function readRawPcmFile(filePath) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(PACKAGE_ROOT, filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`greeting file not found: ${resolved}`);
  }
  const data = fs.readFileSync(resolved);
  if (!data.length) {
    throw new Error(`greeting file is empty: ${resolved}`);
  }
  return { pcm: data, resolvedPath: resolved };
}

export function* iteratePcmChunks(pcm, chunkBytes) {
  let offset = 0;
  while (offset < pcm.length) {
    const end = Math.min(offset + chunkBytes, pcm.length);
    const slice = pcm.subarray(offset, end);
    if (slice.length < chunkBytes) {
      const pad = Buffer.alloc(chunkBytes);
      slice.copy(pad, 0);
      yield pad;
    } else {
      yield slice;
    }
    offset = end;
  }
}

export function resolveGreetingPcm(config) {
  const file = String(config.greetingFile ?? "").trim();
  const mode = String(config.greetingMode ?? "default").trim().toLowerCase();

  if (file) {
    try {
      const { pcm, resolvedPath } = readRawPcmFile(file);
      return {
        pcm,
        source: "file",
        label: resolvedPath,
        skipped: false
      };
    } catch (err) {
      if (mode !== "none" && mode !== "skip") {
        const pcm = generateTestTonePcm(
          config.sampleRate,
          config.toneDurationMs,
          config.toneFrequencyHz
        );
        return {
          pcm,
          source: "generated_tone",
          label: `tone_${config.toneDurationMs}ms_${config.toneFrequencyHz}hz`,
          skipped: false,
          fallbackReason: err.message,
          requestedFile: file
        };
      }
      return {
        pcm: null,
        source: "none",
        label: "",
        skipped: true,
        reason: err.message,
        requestedFile: file
      };
    }
  }

  if (mode === "default" || mode === "tone" || mode === "file") {
    const pcm = generateTestTonePcm(
      config.sampleRate,
      config.toneDurationMs,
      config.toneFrequencyHz
    );
    return {
      pcm,
      source: "generated_tone",
      label: `tone_${config.toneDurationMs}ms_${config.toneFrequencyHz}hz`,
      skipped: false,
      fallbackReason: mode === "file" ? "VOICE_GREETING_FILE is empty" : ""
    };
  }

  return { pcm: null, source: "none", label: "", skipped: true, reason: `mode=${mode}` };
}
