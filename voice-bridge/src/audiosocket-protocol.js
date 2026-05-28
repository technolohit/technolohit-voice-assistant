/** Asterisk AudioSocket framing: 1 byte type + 2 byte BE length + payload */

export const FRAME_HEADER_SIZE = 3;

export const FrameType = {
  HANGUP: 0x00,
  UUID: 0x01,
  DTMF: 0x03,
  ERROR: 0xff,
  AUDIO_SLIN16_8K: 0x10
};

export function isInboundAudioType(type) {
  return type >= 0x10 && type <= 0x18;
}

export function frameTypeName(type) {
  if (type === FrameType.HANGUP) return "hangup";
  if (type === FrameType.UUID) return "uuid";
  if (type === FrameType.DTMF) return "dtmf";
  if (type === FrameType.ERROR) return "error";
  if (isInboundAudioType(type)) return `audio_0x${type.toString(16)}`;
  return `unknown_0x${type.toString(16)}`;
}

export function readFrameHeader(buffer) {
  if (buffer.length < FRAME_HEADER_SIZE) return null;
  const type = buffer[0];
  const length = buffer.readUInt16BE(1);
  return { type, length };
}

export function encodeFrame(type, payload) {
  const body = payload ?? Buffer.alloc(0);
  const frame = Buffer.alloc(FRAME_HEADER_SIZE + body.length);
  frame[0] = type;
  frame.writeUInt16BE(body.length, 1);
  if (body.length) body.copy(frame, FRAME_HEADER_SIZE);
  return frame;
}

export function parseUuidPayload(buffer) {
  if (buffer.length === 16) {
    const hex = buffer.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  const text = buffer.toString("utf8").trim();
  return text || null;
}
