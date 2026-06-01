/**
 * v4 quality event sink — memory buffer; DB insert only on explicit v4 path.
 */

import { validateQualityEventInput, redactQualityPayload } from "./quality-events.js";

export function createQualityEventSink({
  v4PathActive = false,
  insertFn = null,
  maxBuffer = 256
} = {}) {
  const buffer = [];
  const max = Math.max(1, Number(maxBuffer) || 256);

  return {
    v4PathActive: Boolean(v4PathActive),
    insertFn: typeof insertFn === "function" ? insertFn : null,
    bufferedCount: () => buffer.length,
    bufferQualityEvent(event) {
      if (!event?.eventType) {
        return { ok: false, reason: "invalid_event" };
      }
      const normalized = {
        ...event,
        payload: redactQualityPayload(event.payload ?? {})
      };
      const validation = validateQualityEventInput(normalized);
      if (!validation.ok) {
        return { ok: false, reason: "validation_failed", errors: validation.errors };
      }
      if (buffer.length >= max) {
        buffer.shift();
      }
      buffer.push({ ...normalized, buffered_at: Date.now() });
      return { ok: true, buffered: buffer.length };
    },
    async flushQualityEvents(options = {}) {
      const forceV4 = options.v4PathActive ?? this.v4PathActive;
      if (!forceV4) {
        return { ok: false, reason: "v3_path_no_flush", flushed: 0, discarded: buffer.length };
      }
      const events = buffer.splice(0, buffer.length);
      if (!this.insertFn) {
        return { ok: true, flushed: 0, memory_only: true, events };
      }
      const inserted = [];
      for (const event of events) {
        await this.insertFn(event);
        inserted.push(event.eventType);
      }
      return { ok: true, flushed: inserted.length, events };
    },
    discardQualityEvents() {
      const count = buffer.length;
      buffer.length = 0;
      return { ok: true, discarded: count };
    },
    getBufferedQualityEvents() {
      return buffer.map((event) => ({ ...event }));
    }
  };
}

export function isQualityEventSinkWritable(sink, config) {
  const runtimeVersion = String(config?.v4?.runtimeVersion ?? "v3").toLowerCase();
  return Boolean(sink?.v4PathActive) && runtimeVersion === "v4" && typeof sink?.insertFn === "function";
}
