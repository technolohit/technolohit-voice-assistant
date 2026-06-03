import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertOutputIsPrivacySafe,
  extractEnvKeyNamesFromList,
  extractSanitizedRuntimeSnapshot,
  extractVoiceBridgeEnvironmentFromComposeConfig,
  findApprovedInterpolationKeysInProjectEnvKeys,
  findForbiddenRuntimeKeysInComposeEnvironment,
  findForbiddenRuntimeKeysInProjectEnvKeys,
  formatComposeRuntimePreflightLines,
  formatComposeSourceForbiddenFindings,
  GATE3_REQUIRED_RUNTIME,
  inspectRawComposeSources,
  parseEnvAssignments,
  PREFLIGHT_DOCKER_USER,
  runComposeRuntimePreflight,
  VOICE_BRIDGE_RUNTIME_ENV_KEYS
} from "../src/v4/compose-runtime-preflight.js";
import {
  formatRagCanaryPreflightLines,
  runRagCanaryPreflight
} from "../src/v4/rag-canary-preflight.js";
import { loadConfig } from "../src/config.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const CLEAN_RAW_SOURCES = [
  {
    label: "docker-compose.yml",
    content: "services:\n  voice-bridge:\n    env_file:\n      - ../voice-bridge/.env\n"
  },
  {
    label: "docker-compose.prod.yml",
    content: "services:\n  voice-bridge:\n    image: example\n    build: null\n"
  }
];

function gate3Env(overrides = {}) {
  return {
    ...GATE3_REQUIRED_RUNTIME,
    VOICE_V4_LIVE_CANARY_ALLOWLIST: "bridge:",
    ...overrides
  };
}

function baselineEnv(overrides = {}) {
  return {
    VOICE_RUNTIME_VERSION: "v3",
    VOICE_RAG_ENABLED: "false",
    VOICE_RAG_SALES_ANSWERER_ENABLED: "false",
    VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "false",
    VOICE_V4_REALTIME_ENABLED: "false",
    VOICE_V4_CANARY_ENABLED: "false",
    VOICE_SEMANTIC_INTENT_ENABLED: "true",
    VOICE_CONVERSATION_REPAIR_ENABLED: "true",
    ...overrides
  };
}

function runBaselinePreflight(overrides = {}) {
  const env = baselineEnv();
  return runComposeRuntimePreflight({
    mode: "baseline",
    authoritativeEnv: env,
    composeEnvironment: env,
    containerEnv: env,
    composeRawSources: CLEAN_RAW_SOURCES,
    composeProjectEnvKeys: ["VOICE_BRIDGE_IMAGE"],
    ...overrides
  });
}

function runGate3Preflight(overrides = {}) {
  return runComposeRuntimePreflight({
    mode: "gate3",
    authoritativeEnv: gate3Env(),
    composeEnvironment: gate3Env(),
    containerEnv: gate3Env(),
    composeRawSources: CLEAN_RAW_SOURCES,
    composeProjectEnvKeys: ["VOICE_BRIDGE_IMAGE"],
    ...overrides
  });
}

test("10Y: forbidden runtime key list includes interrupt and spike keys", () => {
  for (const key of [
    "VOICE_V4_INTERRUPT_FOLLOWUP_WAIT_MS",
    "VOICE_V4_INTERRUPT_FOLLOWUP_MAX_MS",
    "VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED",
    "VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED"
  ]) {
    assert.ok(VOICE_BRIDGE_RUNTIME_ENV_KEYS.includes(key), key);
  }
});

test("10Y: baseline mode passes for safe v3/RAG-off when ownership is clean", () => {
  const result = runBaselinePreflight();
  assert.equal(result.ok, true);
  assert.equal(result.mode, "baseline");
  assert.equal(result.baselineEffectivePass, true);
  const output = formatComposeRuntimePreflightLines(result);
  assert.match(output, /mode=baseline/);
  assert.match(output, /baseline_effective_pass=true/);
  assert.match(output, /authoritative_file\.VOICE_RUNTIME_VERSION=v3/);
  assert.match(output, /authoritative_file\.VOICE_RAG_ENABLED=false/);
});

test("10Y: gate3 mode fails while production remains v3/RAG-off", () => {
  const env = baselineEnv();
  const result = runComposeRuntimePreflight({
    mode: "gate3",
    authoritativeEnv: env,
    composeEnvironment: env,
    containerEnv: env,
    composeRawSources: CLEAN_RAW_SOURCES,
    composeProjectEnvKeys: ["VOICE_BRIDGE_IMAGE"]
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join(","), /authoritative_file_VOICE_RUNTIME_VERSION_expected_v4/);
});

test("10Y: baseline fails when container env disagrees with authoritative v3 file", () => {
  const result = runBaselinePreflight({
    containerEnv: baselineEnv({ VOICE_RAG_ENABLED: "true" })
  });
  assert.equal(result.ok, false);
  assert.equal(result.baselineEffectivePass, false);
  assert.match(result.failures.join(","), /container_runtime_VOICE_RAG_ENABLED_mismatch_authoritative/);
});

test("10Y: host Stage A wrapper uses baseline mode", () => {
  const script = fs.readFileSync(
    path.join(repoRoot, "scripts/stage-a-compose-runtime-preflight.sh"),
    "utf8"
  );
  assert.match(script, /PREFLIGHT_MODE=baseline/);
});

test("10Y: host Gate 3 wrapper uses gate3 mode", () => {
  const script = fs.readFileSync(
    path.join(repoRoot, "scripts/gate3-compose-runtime-preflight.sh"),
    "utf8"
  );
  assert.match(script, /PREFLIGHT_MODE=gate3/);
});

test("10Y: tracked compose prod override does not declare runtime flags in environment:", () => {
  const content = fs.readFileSync(
    path.join(repoRoot, "asterisk/docker-compose.prod.yml"),
    "utf8"
  );
  const environment = extractVoiceBridgeEnvironmentFromComposeConfig(content);
  assert.deepEqual(findForbiddenRuntimeKeysInComposeEnvironment(environment), []);
});

test("10Y: fails when docker-compose.yml contains VOICE_RAG_ENABLED", () => {
  const result = runGate3Preflight({
    composeRawSources: [
      {
        label: "docker-compose.yml",
        content: `
services:
  voice-bridge:
    environment:
      VOICE_RAG_ENABLED: "true"
`
      },
      CLEAN_RAW_SOURCES[1]
    ]
  });
  assert.equal(result.ok, false);
  assert.match(formatComposeRuntimePreflightLines(result), /docker-compose.yml:VOICE_RAG_ENABLED/);
});

test("10Y: fails when docker-compose.prod.yml contains VOICE_RUNTIME_VERSION", () => {
  const result = runGate3Preflight({
    composeRawSources: [
      CLEAN_RAW_SOURCES[0],
      {
        label: "docker-compose.prod.yml",
        content: `
services:
  voice-bridge:
    environment:
      VOICE_RUNTIME_VERSION: "v4"
`
      }
    ]
  });
  assert.equal(result.ok, false);
  assert.match(
    formatComposeRuntimePreflightLines(result),
    /docker-compose.prod.yml:VOICE_RUNTIME_VERSION/
  );
});

test("10Y: fails when raw Compose contains VOICE_V4_INTERRUPT_FOLLOWUP_WAIT_MS", () => {
  const findings = inspectRawComposeSources([
    {
      label: "docker-compose.yml",
      content: `
services:
  voice-bridge:
    environment:
      VOICE_V4_INTERRUPT_FOLLOWUP_WAIT_MS: "2200"
`
    }
  ]);
  assert.deepEqual(findings, [
    { file: "docker-compose.yml", key: "VOICE_V4_INTERRUPT_FOLLOWUP_WAIT_MS" }
  ]);
});

test("10Y: fails when asterisk/.env contains VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED", () => {
  const result = runGate3Preflight({
    composeProjectEnvKeys: ["VOICE_BRIDGE_IMAGE", "VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED"]
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join(","), /compose_project_env_forbidden_runtime_keys/);
});

test("10Y: allows approved image/build interpolation keys", () => {
  const keys = ["VOICE_BRIDGE_IMAGE", "RAG_API_IMAGE", "BUILD_VERSION", "IMAGE_TAG", "EASYBELL_REGISTRATION_NAME"];
  assert.deepEqual(findForbiddenRuntimeKeysInProjectEnvKeys(keys), []);
  assert.deepEqual(findApprovedInterpolationKeysInProjectEnvKeys(keys).sort(), [
    "BUILD_VERSION",
    "IMAGE_TAG",
    "RAG_API_IMAGE",
    "VOICE_BRIDGE_IMAGE"
  ]);
  const result = runGate3Preflight({ composeProjectEnvKeys: keys });
  assert.equal(result.ownership.ok, true);
});

test("10Y: passes only when every raw Compose file and effective layers are clean", () => {
  const result = runGate3Preflight();
  assert.equal(result.ok, true);
  const output = formatComposeRuntimePreflightLines(result);
  assert.match(output, /compose_runtime_preflight=pass/);
  assert.match(output, /ownership_pass=true/);
  assert.match(output, /compose_source_forbidden_by_file=none/);
  assert.equal(formatComposeSourceForbiddenFindings([]), "none");
});

test("10Y: host wrapper mounts and passes both raw Compose files", () => {
  const script = fs.readFileSync(
    path.join(repoRoot, "scripts/compose-runtime-preflight-host.sh"),
    "utf8"
  );
  assert.match(script, /RAW_COMPOSE_BASE/);
  assert.match(script, /RAW_COMPOSE_PROD/);
  assert.match(script, /raw_compose_missing:docker-compose.prod.yml/);
  assert.match(script, /--raw-compose-file \/raw\/docker-compose.yml/);
  assert.match(script, /--raw-compose-file \/raw\/docker-compose.prod.yml/);
  assert.match(script, /docker run --rm --user 0:0/);
  assert.match(script, /PREFLIGHT_MODE=baseline/);
  assert.match(script, /PREFLIGHT_FLAG="--baseline"/);
  assert.match(script, /PREFLIGHT_FLAG="--gate3"/);
  assert.equal(PREFLIGHT_DOCKER_USER, "0:0");
});

test("10Y: preflight output never prints secret variable names or values", () => {
  const fullEnv = gate3Env({
    OPENAI_API_KEY: "sk-test-secret-key",
    VOICE_DB_PASSWORD: "super-secret-password"
  });
  const result = runGate3Preflight({
    authoritativeEnv: extractSanitizedRuntimeSnapshot(fullEnv),
    composeEnvironment: extractSanitizedRuntimeSnapshot(fullEnv),
    containerEnv: extractSanitizedRuntimeSnapshot(fullEnv)
  });
  const output = formatComposeRuntimePreflightLines(result);
  assert.doesNotMatch(output, /OPENAI_API_KEY/);
  assert.doesNotMatch(output, /sk-test-secret-key/);
  assert.doesNotMatch(output, /super-secret-password/);
  assertOutputIsPrivacySafe(output);
});

test("10Y: v3 defaults remain off in voice-bridge env example", () => {
  const voiceBridgeExample = fs.readFileSync(path.join(repoRoot, "voice-bridge/.env.example"), "utf8");
  const env = parseEnvAssignments(voiceBridgeExample);
  assert.equal(env.VOICE_RUNTIME_VERSION, "v3");
  assert.equal(env.VOICE_RAG_ENABLED, "false");
  assert.equal(env.VOICE_RAG_SALES_ANSWERER_ENABLED, "false");
  assert.equal(env.VOICE_V4_LIVE_AUDIOSOCKET_ENABLED, "false");
});

test("10Y: rag:canary-preflight still enforces required Gate 3 pass markers", async () => {
  const previous = {};
  const ragOnEnv = {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "true",
    VOICE_V4_LIVE_CANARY_ALLOWLIST: "bridge:",
    VOICE_RAG_ENABLED: "true",
    VOICE_RAG_SALES_ANSWERER_ENABLED: "true",
    VOICE_RAG_API_URL: "http://127.0.0.1:8080"
  };
  for (const [key, value] of Object.entries(ragOnEnv)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const result = await runRagCanaryPreflight(loadConfig(), {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
    });
    const output = formatRagCanaryPreflightLines(result);
    assert.equal(result.ok, true);
    assert.match(output, /rag_canary_preflight=pass/);
    assert.match(output, /runtime_v4=true/);
    assert.match(output, /v4_live_audiosocket_enabled=true/);
    assert.match(output, /rag_enabled=true/);
    assert.match(output, /rag_sales_answerer_enabled=true/);
    assert.match(output, /rag_health_ok=true/);
    assert.match(output, /failure_count=0/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("10Y: compose project env keys file accepts one key per line", () => {
  const keys = extractEnvKeyNamesFromList("VOICE_BRIDGE_IMAGE\nRAG_API_IMAGE\n");
  assert.deepEqual(keys, ["VOICE_BRIDGE_IMAGE", "RAG_API_IMAGE"]);
});

test("10Y: compose config parser extracts voice-bridge environment map", () => {
  const yaml = `
services:
  voice-bridge:
    image: example
    environment:
      VOICE_RAG_ENABLED: "false"
      BUILD_VERSION: "voice-bridge-v1.0.0"
  asterisk:
    image: asterisk
`;
  const environment = extractVoiceBridgeEnvironmentFromComposeConfig(yaml);
  assert.equal(environment.VOICE_RAG_ENABLED, "false");
  assert.equal(environment.BUILD_VERSION, "voice-bridge-v1.0.0");
  assert.deepEqual(findForbiddenRuntimeKeysInComposeEnvironment(environment), ["VOICE_RAG_ENABLED"]);
});
