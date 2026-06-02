import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { assignBridgeCallIdentity } from "../src/persist.js";
import {
  canActivateLiveV4Canary,
  selectLiveCallHandler,
  matchLiveCanaryAllowlist,
  shouldCaptureAssistantTurnAudio,
  handleLiveCanaryInboundFrame,
  processLiveCanaryInboundFrame,
  finishLiveCanaryCall
} from "../src/v4/live-audiosocket-handler.js";
import { createLiveCanaryRuntime } from "../src/v4/canary-runtime-loop.js";
import { validateQualityEventInput } from "../src/v4/quality-events.js";

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function liveCanaryEnv(allowlist = "qa-canary") {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "true",
    VOICE_V4_LIVE_CANARY_ALLOWLIST: allowlist
  };
}

function makeCtx(overrides = {}) {
  const ctx = {
    bridgeCallId: overrides.bridgeCallId ?? randomUUID(),
    audiosocketUuid: overrides.audiosocketUuid ?? randomUUID(),
    callSessionId: overrides.callSessionId ?? randomUUID(),
    callHandler: overrides.callHandler ?? "v3",
    inboundAudioFrames: 0
  };
  ctx.externalCallId = overrides.externalCallId ?? `bridge:${ctx.bridgeCallId}`;
  return ctx;
}

function makePcmFrame(amplitude, samples = 160) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(amplitude, i * 2);
  }
  return buf;
}

function feedLiveCanaryFrames(config, ctx, runtime, amplitude, count) {
  for (let i = 0; i < count; i += 1) {
    processLiveCanaryInboundFrame(config, ctx, runtime, makePcmFrame(amplitude));
  }
}

test("T1: selectLiveCallHandler defaults to v3 with factory config", () => {
  withEnv(
    {
      VOICE_RUNTIME_VERSION: undefined,
      VOICE_V4_REALTIME_ENABLED: undefined,
      VOICE_V4_CANARY_ENABLED: undefined,
      VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: undefined,
      VOICE_V4_LIVE_CANARY_ALLOWLIST: undefined
    },
    () => {
      const config = loadConfig();
      const ctx = makeCtx();
      const selected = selectLiveCallHandler(config, ctx);
      assert.equal(selected.handler, "v3");
      assert.equal(selected.runtime, null);
      assert.notEqual(selected.reason, "v4_live_canary_selected");
    }
  );
});

test("T2: v4 runtime without canary/realtime does not activate live path", () => {
  withEnv(
    {
      VOICE_RUNTIME_VERSION: "v4",
      VOICE_V4_REALTIME_ENABLED: "false",
      VOICE_V4_CANARY_ENABLED: "false",
      VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "true",
      VOICE_V4_LIVE_CANARY_ALLOWLIST: "qa-canary"
    },
    () => {
      const config = loadConfig();
      const ctx = makeCtx({ bridgeCallId: "qa-canary-test-001" });
      const gate = canActivateLiveV4Canary(config, ctx);
      assert.equal(gate.ok, false);
      assert.equal(selectLiveCallHandler(config, ctx).handler, "v3");
    }
  );
});

test("T3: v4 + realtime + canary but liveAudioSocketEnabled=false → v3", () => {
  withEnv(
    {
      ...liveCanaryEnv("qa-canary"),
      VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "false"
    },
    () => {
      const config = loadConfig();
      const ctx = makeCtx({ bridgeCallId: "qa-canary-live-001" });
      const gate = canActivateLiveV4Canary(config, ctx);
      assert.equal(gate.ok, false);
      assert.equal(gate.reason, "live_audiosocket_disabled");
      assert.equal(selectLiveCallHandler(config, ctx).handler, "v3");
    }
  );
});

test("T4: all flags true but empty allowlist → v3", () => {
  withEnv(
    {
      ...liveCanaryEnv(""),
      VOICE_V4_LIVE_CANARY_ALLOWLIST: ""
    },
    () => {
      const config = loadConfig();
      assert.deepEqual(config.v4.liveCanaryAllowlist, []);
      const ctx = makeCtx({ bridgeCallId: "qa-canary-any" });
      const gate = canActivateLiveV4Canary(config, ctx);
      assert.equal(gate.ok, false);
      assert.equal(gate.reason, "live_canary_allowlist_empty");
      assert.equal(selectLiveCallHandler(config, ctx).handler, "v3");
    }
  );
});

test("T5: all gates pass + allowlist match → v4_canary", () => {
  withEnv(liveCanaryEnv("qa-canary"), () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-bridge-001" });
    const selected = selectLiveCallHandler(config, ctx);
    assert.equal(selected.handler, "v4_canary");
    assert.equal(selected.reason, "v4_live_canary_selected");
    assert.equal(selected.runtime?.ok, true);
    assert.equal(selected.runtime?.phase, "phase10b_live_vad");
  });
});

test("T6: createLiveCanaryRuntime init failure → fallback v3", () => {
  withEnv(
    {
      ...liveCanaryEnv("qa-canary"),
      VOICE_AGENT_CONFIG_PATH: "/nonexistent/phase10a-missing-agent.json"
    },
    () => {
      const config = loadConfig();
      const ctx = makeCtx({ bridgeCallId: "qa-canary-bridge-002" });
      const runtime = createLiveCanaryRuntime(config, ctx);
      assert.equal(runtime.ok, false);
      assert.equal(runtime.reason, "agent_config_unavailable");
      const selected = selectLiveCallHandler(config, ctx);
      assert.equal(selected.handler, "v3");
      assert.equal(selected.runtime, null);
    }
  );
});

test("T13: v3 path allows captureAssistantTurnAudio", () => {
  const ctx = makeCtx({ callHandler: "v3" });
  assert.equal(shouldCaptureAssistantTurnAudio(ctx), true);
});

test("T14: v4_canary path skips captureAssistantTurnAudio", () => {
  const ctx = makeCtx({ callHandler: "v4_canary" });
  assert.equal(shouldCaptureAssistantTurnAudio(ctx), false);
});

test("T16: UUID-style ctx with default config selects v3", () => {
  withEnv(
    {
      VOICE_RUNTIME_VERSION: undefined,
      VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: undefined,
      VOICE_V4_LIVE_CANARY_ALLOWLIST: undefined
    },
    () => {
      const config = loadConfig();
      const ctx = {
        remoteAddress: "127.0.0.1:12345",
        audiosocketUuid: null,
        callSessionId: "session-mock-001",
        callHandler: "v3"
      };
      assignBridgeCallIdentity(ctx);
      ctx.audiosocketUuid = randomUUID();
      ctx.startedAt = Date.now();

      const selected = selectLiveCallHandler(config, ctx);
      assert.equal(selected.handler, "v3");
      assert.equal(ctx.callHandler, "v3");
    }
  );
});

test("allowlist match supports prefix on bridge_call_id", () => {
  const ctx = makeCtx({ bridgeCallId: "qa-canary-prefix-123" });
  assert.equal(matchLiveCanaryAllowlist(ctx, ["qa-canary"]), true);
  assert.equal(matchLiveCanaryAllowlist(ctx, ["nomatch"]), false);
});

test("allowlist empty never matches", () => {
  const ctx = makeCtx({ bridgeCallId: "qa-canary-xyz" });
  assert.equal(matchLiveCanaryAllowlist(ctx, []), false);
});

test("loadConfig defaults live AudioSocket flags off", () => {
  withEnv(
    {
      VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: undefined,
      VOICE_V4_LIVE_CANARY_ALLOWLIST: undefined
    },
    () => {
      const config = loadConfig();
      assert.equal(config.v4.liveAudioSocketEnabled, false);
      assert.deepEqual(config.v4.liveCanaryAllowlist, []);
    }
  );
});

test("loadConfig accepts comma, semicolon, and whitespace separated live canary allowlist", () => {
  withEnv(
    {
      VOICE_V4_LIVE_CANARY_ALLOWLIST: "qa-one; qa-two qa-three,qa-four"
    },
    () => {
      const config = loadConfig();
      assert.deepEqual(config.v4.liveCanaryAllowlist, ["qa-one", "qa-two", "qa-three", "qa-four"]);
    }
  );
});

test("10B: v3 path does not run v4 VAD processing", () => {
  const config = loadConfig();
  const ctx = makeCtx({ callHandler: "v3" });
  handleLiveCanaryInboundFrame(config, ctx, null, makePcmFrame(900));
  assert.equal(ctx.v4LiveRuntime, undefined);
});

test("10B: v4_canary inbound frame increments audio session counters", () => {
  withEnv(liveCanaryEnv("qa-canary"), () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-vad-001", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    assert.equal(runtime.ok, true);
    ctx.v4LiveRuntime = runtime;
    processLiveCanaryInboundFrame(config, ctx, runtime, makePcmFrame(0, 160));
    assert.equal(runtime.inboundFrameCount, 1);
    assert.equal(runtime.audioSession.inboundFrames, 1);
    assert.equal(runtime.inboundBytes, 320);
  });
});

test("10B: silence frames do not trigger speech start", () => {
  withEnv(liveCanaryEnv("qa-canary"), () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-vad-silence", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    feedLiveCanaryFrames(config, ctx, runtime, 0, 20);
    assert.equal(runtime.speechStartCount, 0);
    assert.equal(runtime.endpointCount, 0);
    assert.equal(runtime.vadState.speechActive, false);
  });
});

test("10B: consecutive speech frames trigger vad speech start", () => {
  withEnv(liveCanaryEnv("qa-canary"), () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-vad-speech", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    feedLiveCanaryFrames(config, ctx, runtime, 800, 3);
    assert.equal(runtime.speechStartCount, 1);
    assert.equal(runtime.vadState.speechActive, true);
    assert.ok(runtime.audioSession.speechStartedAt != null);
    assert.equal(runtime.qualityEventsBuffer.length, 1);
    assert.equal(runtime.qualityEventsBuffer[0].eventType, "vad_speech_start");
  });
});

test("10B: speech followed by silence triggers endpoint detected", () => {
  withEnv(liveCanaryEnv("qa-canary"), () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-vad-endpoint", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    feedLiveCanaryFrames(config, ctx, runtime, 800, 15);
    feedLiveCanaryFrames(config, ctx, runtime, 0, 30);
    assert.equal(runtime.speechStartCount, 1);
    assert.equal(runtime.endpointCount, 1);
    assert.equal(runtime.vadState.speechActive, false);
    assert.ok(runtime.audioSession.endpointDetectedAt != null);
    const endpointEvents = runtime.qualityEventsBuffer.filter(
      (event) => event.eventType === "vad_endpoint_detected"
    );
    assert.equal(endpointEvents.length, 1);
  });
});

test("10B: VAD quality events contain no phone-like payload data", () => {
  withEnv(liveCanaryEnv("qa-canary"), () => {
    const config = loadConfig();
    const ctx = makeCtx({
      bridgeCallId: "qa-canary-vad-privacy",
      callHandler: "v4_canary",
      callSessionId: "session-no-phone-001"
    });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    feedLiveCanaryFrames(config, ctx, runtime, 800, 15);
    feedLiveCanaryFrames(config, ctx, runtime, 0, 30);
    for (const event of runtime.qualityEventsBuffer) {
      const validation = validateQualityEventInput(event);
      assert.equal(validation.ok, true, validation.errors?.join("; "));
      assert.doesNotMatch(JSON.stringify(event.payload), /\+?\d{8,}/);
    }
  });
});

test("v4 live inbound frame handler increments lifecycle counters", () => {
  withEnv(liveCanaryEnv("qa-canary"), () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-frame-count", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    ctx.v4LiveRuntime = runtime;
    handleLiveCanaryInboundFrame(config, ctx, null, makePcmFrame(0));
    assert.equal(ctx.v4LiveRuntime.inboundFrameCount, 1);
    assert.equal(ctx.v4LiveRuntime.inboundBytes, 320);
    assert.equal(ctx.v4LiveRuntime.audioSession.inboundFrames, 1);
  });
});

test("finishLiveCanaryCall clears runtime on v4 handler", () => {
  withEnv(liveCanaryEnv("qa-canary"), () => {
    const config = loadConfig();
    const ctx = makeCtx({ bridgeCallId: "qa-canary-finish", callHandler: "v4_canary" });
    const runtime = createLiveCanaryRuntime(config, ctx);
    runtime.inboundFrameCount = 3;
    runtime.startedAt = Date.now() - 100;
    ctx.v4LiveRuntime = runtime;
    const result = finishLiveCanaryCall(config, ctx, "socket_close");
    assert.equal(result.ok, true);
    assert.equal(result.inboundFrameCount, 3);
    assert.equal(ctx.v4LiveRuntime, null);
  });
});
