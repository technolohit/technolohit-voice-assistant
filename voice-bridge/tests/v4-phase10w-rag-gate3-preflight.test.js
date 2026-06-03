import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { createCallSessionMemory } from "../src/v4/call-session-memory.js";
import { createStateMachine } from "../src/v4/state-machine.js";
import { detectTranscriptIntent } from "../src/v4/transcript-intent.js";
import { resolveClosedDomainIntent } from "../src/v4/closed-domain-intent.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import {
  formatRagCanaryPreflightLines,
  runRagCanaryPreflight
} from "../src/v4/rag-canary-preflight.js";

async function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function ragOnEnv() {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "true",
    VOICE_V4_LIVE_CANARY_ALLOWLIST: "bridge:",
    VOICE_RAG_ENABLED: "true",
    VOICE_RAG_SALES_ANSWERER_ENABLED: "true",
    VOICE_RAG_API_URL: "http://127.0.0.1:8080"
  };
}

test("10W: Gate 3 preflight fails when running container RAG flags are false", async () => {
  await withEnv({ ...ragOnEnv(), VOICE_RAG_ENABLED: "false", VOICE_RAG_SALES_ANSWERER_ENABLED: "false" }, async () => {
    const result = await runRagCanaryPreflight(loadConfig(), {
      fetchImpl: async () => {
        throw new Error("health must not run when flags fail");
      }
    });
    assert.equal(result.ok, false);
    assert.match(result.failures.join(","), /VOICE_RAG_ENABLED/);
    assert.match(result.failures.join(","), /VOICE_RAG_SALES_ANSWERER_ENABLED/);
  });
});

test("10W: Gate 3 preflight passes only with v4 live gates, RAG flags, and health", async () => {
  await withEnv(ragOnEnv(), async () => {
    const result = await runRagCanaryPreflight(loadConfig(), {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
    });
    assert.equal(result.ok, true);
    assert.equal(result.ragHealthOk, true);
    assert.match(formatRagCanaryPreflightLines(result), /rag_enabled=true/);
    assert.match(formatRagCanaryPreflightLines(result), /rag_sales_answerer_enabled=true/);
  });
});

test("10W: Smart-Webseite opening phrase resolves to product selection, not fallback", () => {
  const config = loadConfig();
  const agent = loadAgentConfig(config);
  const memory = createCallSessionMemory({ bridgeCallId: "10w-smart-hyphen" });
  const stateMachine = createStateMachine();
  const transcript = "Hallo, ich interessiere mich für die Smart-Webseite.";
  const intent = detectTranscriptIntent(transcript, memory, agent);
  const closedDomain = resolveClosedDomainIntent({ agentConfig: agent, transcript, memory });
  const plan = buildResponsePlan({ agentConfig: agent, memory, stateMachine, transcript, intent, closedDomain });

  assert.equal(intent, "product_selection");
  assert.equal(closedDomain.matched_product, "smart_website");
  assert.notEqual(plan.response_type, RESPONSE_TYPES.FALLBACK_CLARIFICATION);
  assert.equal(plan.memory_patch.selected_product_id, "smart_website");
});

test("10W: inflected Smart Website opening phrase resolves to product selection", () => {
  const config = loadConfig();
  const agent = loadAgentConfig(config);
  const memory = createCallSessionMemory({ bridgeCallId: "10w-smart-inflected" });
  const transcript = "Ich interessiere mich für die smarte Webseite.";
  assert.equal(detectTranscriptIntent(transcript, memory, agent), "product_selection");
});
