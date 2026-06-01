import net from "node:net";
import {
  frameTypeName,
  FrameType,
  isInboundAudioType,
  parseUuidPayload,
  readFrameHeader,
  FRAME_HEADER_SIZE
} from "./audiosocket-protocol.js";
import {
  playGreetingAndKeepalive,
  startSilenceWriter,
  stopSilenceWriter
} from "./media-outbound.js";
import { runPostCallProcessing } from "./post-call.js";
import { captureInboundAudio } from "./recording.js";
import { captureAssistantTurnAudio } from "./turn-assistant.js";
import * as persist from "./persist.js";
import {
  getActivePlaybackSession,
  isPlaybackCancelSpikeEnabled,
  monitorInboundDuringPlayback
} from "./playback-session.js";

function normalizePhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const compact = raw.replace(/[^\d+]/g, "");
  if (!compact) return "";
  return compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
}

function parseIdentityPayload(uuidPayload) {
  const value = String(uuidPayload ?? "").trim();
  const result = {
    audiosocketUuid: value || "unknown",
    callerPhoneRaw: "",
    callerPhoneNormalized: "",
    callerPhoneSource: ""
  };
  if (!value) return result;

  // Backward compatible default: plain UUID payload.
  // Optional phase-4 format support:
  // - JSON: {"uuid":"...","caller_phone_raw":"+4917..."}
  // - KV: uuid=<...>;caller_phone_raw=<...>;caller_phone_source=<...>
  let parsed = null;
  if (value.startsWith("{") && value.endsWith("}")) {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  }
  if (!parsed && value.includes("=")) {
    parsed = {};
    for (const part of value.split(/[;|,&]/)) {
      const [k, ...rest] = part.split("=");
      if (!k || !rest.length) continue;
      parsed[k.trim()] = rest.join("=").trim();
    }
  }
  if (!parsed || typeof parsed !== "object") return result;

  const uuid = String(parsed.uuid ?? parsed.audiosocket_uuid ?? parsed.audio_uuid ?? value).trim();
  const rawPhone = String(
    parsed.caller_phone_raw ??
      parsed.caller_phone ??
      parsed.callerid_num ??
      parsed.callerid ??
      parsed.ani ??
      ""
  ).trim();

  result.audiosocketUuid = uuid || result.audiosocketUuid;
  result.callerPhoneRaw = rawPhone;
  result.callerPhoneNormalized = normalizePhone(rawPhone);
  result.callerPhoneSource = String(parsed.caller_phone_source ?? (rawPhone ? "audiosocket_uuid_payload" : "")).trim();
  return result;
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 */
export function createAudioSocketServer(config) {
  const server = net.createServer((socket) => {
    const ctx = {
      remoteAddress: `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? 0}`,
      bridgeCallId: null,
      audiosocketUuid: null,
      callerPhoneRaw: "",
      callerPhoneNormalized: "",
      callerPhoneSource: "",
      externalCallId: null,
      callSessionId: null,
      startedAt: null,
      framesReceived: 0,
      bytesReceived: 0,
      inboundAudioFrames: 0,
      greetingHandled: false,
      closed: false,
      silenceTimer: null,
      recording: null,
      assistantTurn: null,
      postCallTriggered: false,
      buffer: Buffer.alloc(0)
    };

    persist.assignBridgeCallIdentity(ctx);
    console.log(
      `[voice-bridge] call accepted ${persist.callLogLabel(ctx)} remote=${ctx.remoteAddress}`
    );

    const finish = async (reason) => {
      if (ctx.closed) return;
      ctx.closed = true;
      stopSilenceWriter(ctx);
      await persist.onCallEnded(config, ctx, {
        closeReason: reason,
        framesReceived: ctx.framesReceived,
        bytesReceived: ctx.bytesReceived
      });
      if (ctx.postCallTriggered) return;
      ctx.postCallTriggered = true;
      console.log(
        `[post-call] trigger start call_session_id=${ctx.callSessionId ?? ""} external_call_id=${ctx.externalCallId ?? ""} reason=${reason}`
      );
      void runPostCallProcessing(config, ctx).catch((err) => {
        console.error(`[post-call] trigger failed: ${err?.message ?? String(err)}`);
      });
    };

    socket.on("error", (err) => {
      void persist.onError(config, ctx, err, { phase: "socket" });
    });

    socket.on("close", () => {
      void finish("socket_close");
    });

    socket.on("data", (chunk) => {
      ctx.buffer = Buffer.concat([ctx.buffer, chunk]);

      while (ctx.buffer.length >= FRAME_HEADER_SIZE) {
        const header = readFrameHeader(ctx.buffer);
        if (!header) break;
        const total = FRAME_HEADER_SIZE + header.length;
        if (ctx.buffer.length < total) break;

        const payload = ctx.buffer.subarray(FRAME_HEADER_SIZE, total);
        ctx.buffer = ctx.buffer.subarray(total);

        try {
          handleFrame(config, ctx, socket, header.type, payload);
        } catch (err) {
          void persist.onError(config, ctx, err, {
            phase: "frame",
            frame_type: header.type
          });
        }
      }
    });
  });

  return server;
}

function handleFrame(config, ctx, socket, type, payload) {
  if (type === FrameType.HANGUP) {
    console.log(`[voice-bridge] hangup frame received ${persist.callLogLabel(ctx)}`);
    socket.end();
    return;
  }

  if (type === FrameType.UUID) {
    const uuidPayload = parseUuidPayload(payload);
    const identity = parseIdentityPayload(uuidPayload);
    ctx.audiosocketUuid = identity.audiosocketUuid;
    ctx.callerPhoneRaw = identity.callerPhoneRaw;
    ctx.callerPhoneNormalized = identity.callerPhoneNormalized;
    ctx.callerPhoneSource = identity.callerPhoneSource;
    ctx.startedAt = Date.now();
    console.log(`[voice-bridge] UUID frame received ${persist.callLogLabel(ctx)}`);

    void (async () => {
      try {
        await persist.onConnectionOpen(config, ctx);
        await persist.onCallStarted(config, ctx);
        await playGreetingAndKeepalive(config, ctx, socket);
      } catch (err) {
        void persist.onError(config, ctx, err, { phase: "uuid_setup" });
        startSilenceWriter(config, ctx, socket);
      }
    })();
    return;
  }

  if (isInboundAudioType(type)) {
    ctx.framesReceived += 1;
    ctx.inboundAudioFrames += 1;
    ctx.bytesReceived += payload.length;
    captureInboundAudio(config, ctx, payload);
    captureAssistantTurnAudio(config, ctx, payload);
    if (isPlaybackCancelSpikeEnabled(config)) {
      const activePlayback = getActivePlaybackSession(ctx);
      if (activePlayback) {
        monitorInboundDuringPlayback(config, ctx, activePlayback, payload);
      }
    }

    const n = ctx.inboundAudioFrames;
    if (n === 1 || n % config.inboundLogEvery === 0) {
      console.log(
        `[voice-bridge] inbound audio frames=${ctx.framesReceived} bytes=${ctx.bytesReceived} type=${frameTypeName(type)}`
      );
    }
    return;
  }

  if (type === FrameType.DTMF) {
    console.log(
      `[voice-bridge] DTMF frame len=${payload.length} data=${payload.toString("utf8").slice(0, 32)}`
    );
    return;
  }

  if (type === FrameType.ERROR) {
    console.warn(
      `[voice-bridge] error frame len=${payload.length} data=${payload.toString("utf8").slice(0, 128)}`
    );
    void persist.onError(config, ctx, new Error("AudioSocket error frame"), {
      phase: "audiosocket_error_frame"
    });
    return;
  }

  console.warn(
    `[voice-bridge] unknown frame type=${frameTypeName(type)} len=${payload.length}`
  );
}
