import test from "node:test";
import assert from "node:assert/strict";
import { generatePostCallSummary } from "../src/post-call-summary.js";
import { attachLiveV4PostCallHandoff } from "../src/v4/live-audiosocket-handler.js";
import {
  createDialogueOrchestrator,
  startCall,
  closeCall
} from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { loadConfig } from "../src/config.js";
import { setSelectedProduct, createCallSessionMemory } from "../src/v4/call-session-memory.js";

test("10Z: v4 live handoff attaches post-call metadata on ctx before post-call", () => {
  const config = loadConfig();
  const ctx = { callSessionId: "sess-1", bridgeCallId: "bridge-1", callHandler: "v4_canary" };
  const runtimeContext = createRuntimeContext(
    config,
    { bridgeCallId: "bridge-1", callSessionId: "sess-1", liveCanary: true },
    { runtime: "v4", active: true }
  );
  const orchestrator = createDialogueOrchestrator({
    config,
    runtimeContext,
    agentConfig: runtimeContext.agentConfig
  });
  startCall(orchestrator);
  orchestrator.memory = setSelectedProduct(orchestrator.memory, "smart_website");
  orchestrator.memory.use_case_summary = "Preis fuer Smart Website";

  const runtime = { orchestrator };
  const closed = attachLiveV4PostCallHandoff(ctx, runtime);

  assert.ok(closed?.postCallHandoff?.summaryMetadata);
  assert.equal(ctx.v4PostCallMetadata?.v4_runtime, true);
  assert.equal(ctx.v4PostCallMetadata?.product_interest, "smart_website");
  assert.equal(orchestrator.status, "closed");
});

test("10Z: generatePostCallSummary skips when no turn rows and no v4 handoff", async () => {
  const config = loadConfig();
  config.postCallSummary = { enabled: true };
  const result = await generatePostCallSummary(config, { callSessionId: "missing-session-no-db" });
  assert.equal(result, null);
});

test("10Z: closeCall alone produces metadata consumed by post-call bridge", () => {
  const config = loadConfig();
  const runtimeContext = createRuntimeContext(
    config,
    { bridgeCallId: "bridge-4", callSessionId: "sess-4" },
    { runtime: "v4", active: true }
  );
  const orchestrator = createDialogueOrchestrator({
    config,
    runtimeContext,
    agentConfig: runtimeContext.agentConfig
  });
  startCall(orchestrator);
  orchestrator.memory = setSelectedProduct(orchestrator.memory, "smart_website");
  const closed = closeCall(orchestrator);
  assert.equal(closed.postCallHandoff?.summaryMetadata?.v4_runtime, true);
});
