import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import {
  loadAgentConfig,
  validateAgentConfig,
  resolveAgentConfigPath,
  getAgentVersionMetadata
} from "../src/v4/agent-config.js";
import {
  resolveRuntimeRoute,
  describeRuntimeRoute,
  isV4RuntimeActive
} from "../src/v4/runtime-router.js";
import { buildRagRetrievePayload, resolveRagScope } from "../src/v4/rag-scope.js";
import {
  buildQualityEventInput,
  validateQualityEventInput
} from "../src/v4/quality-events.js";
import { buildPersistMetadata } from "../src/v4/persist-metadata.js";
import { canTransition, V4_STATES } from "../src/v4/state-machine.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

test("loadConfig defaults v4 runtime flags to v3/off", () => {
  withEnv(
    {
      VOICE_RUNTIME_VERSION: undefined,
      VOICE_V4_REALTIME_ENABLED: undefined,
      VOICE_V4_BARGE_IN_ENABLED: undefined,
      VOICE_V4_STREAMING_STT_ENABLED: undefined,
      VOICE_V4_STREAMING_TTS_ENABLED: undefined,
      VOICE_TENANT_ID: undefined,
      VOICE_AGENT_ID: undefined
    },
    () => {
      const config = loadConfig();
      assert.equal(config.v4.runtimeVersion, "v3");
      assert.equal(config.v4.realtimeEnabled, false);
      assert.equal(config.v4.bargeInEnabled, false);
      assert.equal(config.v4.streamingSttEnabled, false);
      assert.equal(config.v4.streamingTtsEnabled, false);
      assert.equal(config.v4.tenantId, "technolohit");
      assert.equal(config.v4.agentId, "main_voice_sales");
    }
  );
});

test("resolveRuntimeRoute defaults to active v3", () => {
  const config = loadConfig();
  const route = resolveRuntimeRoute(config);
  assert.equal(route.runtime, "v3");
  assert.equal(route.active, true);
  assert.equal(route.stub, false);
  assert.equal(isV4RuntimeActive(config), false);
});

test("resolveRuntimeRoute keeps v4 stub inactive when realtime flag off", () => {
  withEnv({ VOICE_RUNTIME_VERSION: "v4", VOICE_V4_REALTIME_ENABLED: "false" }, () => {
    const config = loadConfig();
    const route = resolveRuntimeRoute(config);
    assert.equal(route.runtime, "v3");
    assert.equal(route.reason, "v4_requested_but_realtime_disabled");
  });
});

test("resolveRuntimeRoute returns v4 stub when v4 requested and enabled", () => {
  withEnv({ VOICE_RUNTIME_VERSION: "v4", VOICE_V4_REALTIME_ENABLED: "true" }, () => {
    const config = loadConfig();
    const route = resolveRuntimeRoute(config);
    assert.equal(route.runtime, "v4");
    assert.equal(route.stub, true);
    assert.equal(route.active, false);
    assert.equal(describeRuntimeRoute(config).selected_runtime, "v4");
  });
});

test("loadAgentConfig loads TechnoloHit seed JSON", () => {
  withEnv({ VOICE_AGENT_CONFIG_PATH: undefined }, () => {
    const config = loadConfig();
    const result = loadAgentConfig(config);
    assert.equal(result.ok, true);
    assert.equal(result.config.tenant_id, "technolohit");
    assert.equal(result.config.agent_id, "main_voice_sales");
    assert.ok(Array.isArray(result.config.products));
    assert.ok(result.config.products.length >= 5);
  });
});

test("validateAgentConfig rejects missing required fields", () => {
  const result = validateAgentConfig({ tenant_id: "technolohit" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.includes("agent_id")));
});

test("resolveAgentConfigPath prefers explicit env path", () => {
  withEnv({ VOICE_AGENT_CONFIG_PATH: "/tmp/custom-agent.json" }, () => {
    const config = loadConfig();
    assert.equal(resolveAgentConfigPath(config), "/tmp/custom-agent.json");
  });
});

test("buildRagRetrievePayload includes tenant_id and agent_id", () => {
  const config = loadConfig();
  const agent = loadAgentConfig(config);
  const payload = buildRagRetrievePayload(
    config,
    { query: "Was ist Smart Website?", context: { source: "test" } },
    agent
  );
  assert.equal(payload.tenant_id, "technolohit");
  assert.equal(payload.agent_id, "main_voice_sales");
  assert.equal(payload.query, "Was ist Smart Website?");
  assert.equal(payload.context.tenant_id, "technolohit");
  assert.equal(payload.context.agent_id, "main_voice_sales");
});

test("resolveRagScope uses config defaults", () => {
  const scope = resolveRagScope(loadConfig());
  assert.deepEqual(scope, {
    tenant_id: "technolohit",
    agent_id: "main_voice_sales"
  });
});

test("buildQualityEventInput validates required shape", () => {
  const config = loadConfig();
  const input = buildQualityEventInput({
    config,
    eventType: "latency",
    eventStage: "stt",
    metricName: "turn_ms",
    metricValue: 120,
    payload: { bridge_call_id: "test" }
  });
  const validation = validateQualityEventInput(input);
  assert.equal(validation.ok, true);
  assert.equal(input.tenantId, "technolohit");
  assert.equal(input.agentId, "main_voice_sales");
  assert.equal(input.eventType, "latency");
});

test("buildPersistMetadata returns version fields from agent config", () => {
  const config = loadConfig();
  const agent = loadAgentConfig(config);
  const metadata = buildPersistMetadata(config, agent);
  assert.equal(metadata.tenant_id, "technolohit");
  assert.equal(metadata.agent_id, "main_voice_sales");
  assert.ok(metadata.agent_config_version);
  assert.equal(getAgentVersionMetadata(agent.config).tenant_id, "technolohit");
});

test("v4 state machine allows speaking to interrupted transition", () => {
  assert.equal(canTransition(V4_STATES.SPEAKING, V4_STATES.INTERRUPTED), true);
  assert.equal(canTransition(V4_STATES.COMPLETED, V4_STATES.LISTENING), false);
});

test("voice migrations 006-009 are forward-compatible", () => {
  const files = [
    "006_v4_tenant_agent_session_fields.sql",
    "007_v4_tenant_agent_transcripts_events.sql",
    "008_v4_leads_custom_fields.sql",
    "009_v4_call_quality_events.sql"
  ];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(packageRoot, "..", "db", "voice", "migrations", file), "utf8");
    assert.match(sql, /BEGIN;/);
    assert.match(sql, /COMMIT;/);
    assert.match(sql, /DEFAULT 'technolohit'/);
  }
});

test("knowledge migration 003 adds agent scope", () => {
  const sql = fs.readFileSync(
    path.join(packageRoot, "..", "db", "knowledge", "migrations", "003_knowledge_agent_scope.sql"),
    "utf8"
  );
  assert.match(sql, /agent_id/);
  assert.match(sql, /DEFAULT 'main_voice_sales'/);
  assert.match(sql, /documents_tenant_agent_source_content_key/);
  assert.match(sql, /UNIQUE \(tenant_id, agent_id, source_uri, content_hash\)/);
});

test("voice-bridge Dockerfile copies default agent config", () => {
  const dockerfile = fs.readFileSync(path.join(packageRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /COPY --chown=node:node config \.\/config/);
  const seedPath = path.join(
    packageRoot,
    "config/agents/technolohit.main_voice_sales.v4.json"
  );
  assert.equal(fs.existsSync(seedPath), true);
});
