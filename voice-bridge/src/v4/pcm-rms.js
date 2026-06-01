/**
 * PCM frame RMS helper for 16-bit LE mono audio (PSTN-friendly 8 kHz).
 */

export function pcmFrameRms(buffer) {
  if (!buffer?.length) return 0;
  const samples = Math.floor(buffer.length / 2);
  if (!samples) return 0;

  let sumSquares = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / samples);
}
