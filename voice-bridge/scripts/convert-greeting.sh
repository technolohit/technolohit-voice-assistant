#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
INPUT="$APP_DIR/audio/greeting.wav"
OUTPUT="$APP_DIR/audio/greeting.slin"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[voice-audio] ffmpeg is required" >&2
  exit 1
fi

if [ ! -s "$INPUT" ]; then
  echo "[voice-audio] missing or empty input: $INPUT" >&2
  exit 1
fi

mkdir -p "$APP_DIR/audio"

ffmpeg -y \
  -i "$INPUT" \
  -ar 8000 \
  -ac 1 \
  -f s16le \
  -acodec pcm_s16le \
  "$OUTPUT"

if [ ! -s "$OUTPUT" ]; then
  echo "[voice-audio] conversion produced an empty file: $OUTPUT" >&2
  exit 1
fi

BYTES=$(wc -c < "$OUTPUT" | tr -d ' ')
echo "[voice-audio] wrote $OUTPUT bytes=$BYTES format=s16le sample_rate=8000 channels=1"
