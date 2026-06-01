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
  finishLiveCanaryCall
} from "../src/v4/live-audiosocket-handler.js";
import { createLiveCanaryRuntime } from "../src/v4/canary-runtime-loop.js";

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
    assert.equal(selected.runtime?.phase, "phase10a_live_lifecycle");
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

test("v4 live inbound frame handler increments lifecycle counters", () => {
  const config = loadConfig();
  const ctx = makeCtx({ callHandler: "v4_canary" });
  ctx.v4LiveRuntime = { inboundFrameCount: 0, inboundBytes: 0 };
  handleLiveCanaryInboundFrame(config, ctx, null, Buffer.alloc(320));
  assert.equal(ctx.v4LiveRuntime.inboundFrameCount, 1);
  assert.equal(ctx.v4LiveRuntime.inboundBytes, 320);
});

test("finishLiveCanaryCall clears runtime on v4 handler", () => {
  const config = loadConfig();
  const ctx = makeCtx({ callHandler: "v4_canary" });
  ctx.v4LiveRuntime = { inboundFrameCount: 3, startedAt: Date.now() - 100 };
  const result = finishLiveCanaryCall(config, ctx, "socket_close");
  assert.equal(result.ok, true);
  assert.equal(result.inboundFrameCount, 3);
  assert.equal(ctx.v4LiveRuntime, null);
});
