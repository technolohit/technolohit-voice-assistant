/**
 * Privacy-safe Gate 3 compose/runtime preflight with source ownership checks.
 *
 * Effective layers (sanitized snapshots only — no secrets):
 * 1. Authoritative file: ../voice-bridge/.env
 * 2. Rendered Compose service config
 * 3. Running container env
 *
 * Ownership layers (raw source — key names only in output):
 * 4. Every raw Compose file used by the render command
 * 5. Compose project env key names from asterisk/.env
 */

/** Voice-bridge runtime keys — must exist only in ../voice-bridge/.env (env_file). */
export const VOICE_BRIDGE_RUNTIME_ENV_KEYS = [
  "VOICE_AGENT_CONFIG_PATH",
  "VOICE_AGENT_ID",
  "VOICE_ASR_DIAGNOSTICS_ENABLED",
  "VOICE_ASSISTANT_ENABLED",
  "VOICE_ASSISTANT_END_ON_SILENCE",
  "VOICE_ASSISTANT_END_SILENCE_MS",
  "VOICE_ASSISTANT_MAX_LISTEN_MS",
  "VOICE_ASSISTANT_MAX_RESPONSE_CHARS",
  "VOICE_ASSISTANT_MAX_RESPONSE_SENTENCES",
  "VOICE_ASSISTANT_MAX_TURNS",
  "VOICE_ASSISTANT_MAX_TURNS_WITH_INTAKE",
  "VOICE_ASSISTANT_MIN_LISTEN_MS",
  "VOICE_ASSISTANT_MIN_TRANSCRIPT_CHARS",
  "VOICE_ASSISTANT_MODEL",
  "VOICE_ASSISTANT_TTS_MODEL",
  "VOICE_ASSISTANT_TTS_SPEED",
  "VOICE_ASSISTANT_TTS_VOICE",
  "VOICE_BRIDGE_HOST",
  "VOICE_BRIDGE_PORT",
  "VOICE_CONTACT_EMAIL",
  "VOICE_CONTACT_FORM_URL",
  "VOICE_CONVERSATION_REPAIR_ENABLED",
  "VOICE_DB_HOST",
  "VOICE_DB_NAME",
  "VOICE_DB_PASSWORD",
  "VOICE_DB_POOL_MAX",
  "VOICE_DB_PORT",
  "VOICE_DB_SSL",
  "VOICE_DB_USER",
  "VOICE_FRAME_MS",
  "VOICE_GREETING_FILE",
  "VOICE_GREETING_MODE",
  "VOICE_GREETING_PRIVACY_MODE",
  "VOICE_INBOUND_LOG_EVERY",
  "VOICE_KNOWLEDGE_RETRIEVAL_ENABLED",
  "VOICE_KNOWLEDGE_RETRIEVAL_MIN_SCORE",
  "VOICE_LEAD_POLICY_STRICT_CALLBACK",
  "VOICE_LOG_TRANSCRIPT_PREVIEW",
  "VOICE_POST_CALL_LEAD_EXTRACTION_ENABLED",
  "VOICE_POST_CALL_NOTIFY_ENABLED",
  "VOICE_POST_CALL_NOTIFY_TIMEOUT_MS",
  "VOICE_POST_CALL_NOTIFY_WEBHOOK_URL",
  "VOICE_POST_CALL_SUMMARY_ENABLED",
  "VOICE_QA_LOG_TRANSCRIPT_PREVIEW",
  "VOICE_RAG_API_URL",
  "VOICE_RAG_ENABLED",
  "VOICE_RAG_MIN_SCORE",
  "VOICE_RAG_QA_ACCEPT_FLOOR",
  "VOICE_RAG_QA_MODE",
  "VOICE_RAG_QA_RETRY_DELTA",
  "VOICE_RAG_QA_TIMEOUT_MS",
  "VOICE_RAG_SALES_ANSWERER_ENABLED",
  "VOICE_RAG_TIMEOUT_MS",
  "VOICE_RECORDING_DIR",
  "VOICE_RECORDING_ENABLED",
  "VOICE_RECORDING_MAX_SECONDS",
  "VOICE_RUNTIME_VERSION",
  "VOICE_SAMPLE_RATE",
  "VOICE_SEMANTIC_INTENT_ENABLED",
  "VOICE_SEMANTIC_INTENT_MIN_ACCEPT",
  "VOICE_SEMANTIC_INTENT_MIN_SOFT",
  "VOICE_SEMANTIC_INTENT_MODE",
  "VOICE_SEMANTIC_INTENT_MODEL",
  "VOICE_TENANT_ID",
  "VOICE_TONE_DURATION_MS",
  "VOICE_TONE_FREQUENCY_HZ",
  "VOICE_TRANSCRIPTION_ENABLED",
  "VOICE_TRANSCRIPTION_LANGUAGE",
  "VOICE_TRANSCRIPTION_MODEL",
  "VOICE_TRANSCRIPTION_PROMPT",
  "VOICE_TURN_LISTEN_SECONDS",
  "VOICE_V4_BARGE_IN_CANCEL_TIMEOUT_MS",
  "VOICE_V4_BARGE_IN_ENABLED",
  "VOICE_V4_BARGE_IN_MIN_PLAYBACK_MS",
  "VOICE_V4_BARGE_IN_RMS_THRESHOLD",
  "VOICE_V4_BARGE_IN_SPEECH_FRAMES",
  "VOICE_V4_CANARY_ENABLED",
  "VOICE_V4_ENDPOINT_MIN_SPEECH_MS",
  "VOICE_V4_ENDPOINT_SILENCE_MS",
  "VOICE_V4_INTERRUPTION_CONTEXT_SPIKE_ENABLED",
  "VOICE_V4_INTERRUPT_FOLLOWUP_MAX_MS",
  "VOICE_V4_INTERRUPT_FOLLOWUP_WAIT_MS",
  "VOICE_V4_INTERRUPT_MARKER_ONLY_MIN_CHARS",
  "VOICE_V4_LIVE_AUDIOSOCKET_ENABLED",
  "VOICE_V4_LIVE_CANARY_ALLOWLIST",
  "VOICE_V4_PLAYBACK_CANCEL_SPIKE_ENABLED",
  "VOICE_V4_PLAYBACK_CANCEL_SPIKE_RMS_THRESHOLD",
  "VOICE_V4_PLAYBACK_CANCEL_SPIKE_SPEECH_FRAMES",
  "VOICE_V4_REALTIME_ENABLED",
  "VOICE_V4_STT_PROVIDER",
  "VOICE_V4_STREAMING_STT_ENABLED",
  "VOICE_V4_STREAMING_TTS_ENABLED",
  "VOICE_V4_TTS_CACHE_ENABLED",
  "VOICE_V4_TTS_PROVIDER",
  "VOICE_V4_VAD_RMS_THRESHOLD",
  "VOICE_V4_VAD_SPEECH_FRAMES",
  "VOICE_WEBSITE_URL"
];

/** Allowed in asterisk/.env and non-runtime Compose interpolation only. */
export const APPROVED_COMPOSE_INTERPOLATION_KEYS = [
  "VOICE_BRIDGE_IMAGE",
  "RAG_API_IMAGE",
  "BUILD_VERSION",
  "IMAGE_TAG"
];

/** Non-runtime keys allowed in raw Compose voice-bridge environment: (BUILD_VERSION, IMAGE_TAG). */
export const APPROVED_COMPOSE_SERVICE_ENV_KEYS = [
  "BUILD_VERSION",
  "IMAGE_TAG"
];

export const GATE3_REQUIRED_RUNTIME = Object.freeze({
  VOICE_RUNTIME_VERSION: "v4",
  VOICE_V4_REALTIME_ENABLED: "true",
  VOICE_V4_CANARY_ENABLED: "true",
  VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "true",
  VOICE_RAG_ENABLED: "true",
  VOICE_RAG_SALES_ANSWERER_ENABLED: "true",
  VOICE_RAG_API_URL: "http://127.0.0.1:8080"
});

export const SECRET_ENV_DENYLIST = [
  "OPENAI_API_KEY",
  "VOICE_DB_PASSWORD",
  "EASYBELL_SIP_PASSWORD",
  "EASYBELL_SIP_USER",
  "EASYBELL_CONTACT_USER",
  "VOICE_POST_CALL_NOTIFY_WEBHOOK_URL"
];

const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b\+?[0-9]{8,}\b/
];

/** Short read-only preflight containers must run as root to read host-owned 0600 mounts. */
export const PREFLIGHT_DOCKER_USER = "0:0";

export function normalizeEnvValue(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export function parseEnvAssignments(content) {
  const env = {};
  for (const rawLine of String(content ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function parsePrintenvOutput(content) {
  return parseEnvAssignments(content);
}

export function extractEnvKeyNames(content) {
  return Object.keys(parseEnvAssignments(content));
}

export function extractEnvKeyNamesFromList(content) {
  const keys = [];
  for (const rawLine of String(content ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    keys.push(line);
  }
  return keys;
}

export function extractSanitizedRuntimeSnapshot(
  env,
  keys = Object.keys(GATE3_REQUIRED_RUNTIME)
) {
  const snapshot = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      snapshot[key] = normalizeEnvValue(env[key]);
    }
  }
  return snapshot;
}

export function formatSanitizedEnvSnapshot(snapshot) {
  return Object.entries(snapshot)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function extractVoiceBridgeEnvironmentFromComposeConfig(yamlContent) {
  const lines = String(yamlContent ?? "").split(/\r?\n/);
  let inServices = false;
  let inVoiceBridge = false;
  let inEnvironment = false;
  const environment = {};

  for (const line of lines) {
    if (!inServices) {
      if (/^services:\s*$/.test(line)) inServices = true;
      continue;
    }

    if (!inVoiceBridge) {
      if (/^  voice-bridge:\s*$/.test(line)) {
        inVoiceBridge = true;
        inEnvironment = false;
      }
      continue;
    }

    if (/^  [A-Za-z0-9_.-]+:\s*$/.test(line) && !/^  voice-bridge:\s*$/.test(line)) {
      break;
    }

    if (!inEnvironment) {
      if (/^    environment:\s*$/.test(line)) {
        inEnvironment = true;
      }
      continue;
    }

    if (/^    [A-Za-z0-9_.-]+:\s/.test(line) && !/^    environment:\s*$/.test(line)) {
      break;
    }

    const mapMatch = line.match(/^ {6}([A-Z0-9_]+):\s*(.*)$/);
    if (mapMatch) {
      environment[mapMatch[1]] = unquoteYamlScalar(mapMatch[2]);
      continue;
    }

    const listMatch = line.match(/^ {6}- ([A-Z0-9_]+)=(.*)$/);
    if (listMatch) {
      environment[listMatch[1]] = unquoteYamlScalar(listMatch[2]);
      continue;
    }

    if (/^ {4}[A-Za-z0-9_.-]+:\s*$/.test(line)) {
      break;
    }
  }

  return environment;
}

function unquoteYamlScalar(raw) {
  const value = String(raw ?? "").trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function findForbiddenRuntimeKeysInComposeEnvironment(composeEnvironment = {}) {
  return Object.keys(composeEnvironment).filter(
    (key) =>
      VOICE_BRIDGE_RUNTIME_ENV_KEYS.includes(key) &&
      !APPROVED_COMPOSE_SERVICE_ENV_KEYS.includes(key)
  );
}

/** @deprecated use findForbiddenRuntimeKeysInComposeEnvironment */
export function findDuplicatedRuntimeInComposeEnvironment(composeEnvironment = {}) {
  return findForbiddenRuntimeKeysInComposeEnvironment(composeEnvironment);
}

export function findForbiddenRuntimeKeysInProjectEnvKeys(projectEnvKeys = []) {
  return projectEnvKeys.filter((key) => VOICE_BRIDGE_RUNTIME_ENV_KEYS.includes(key));
}

export function findApprovedInterpolationKeysInProjectEnvKeys(projectEnvKeys = []) {
  return projectEnvKeys.filter((key) => APPROVED_COMPOSE_INTERPOLATION_KEYS.includes(key));
}

export function inspectRawComposeSources(rawComposeSources = []) {
  const findings = [];
  for (const source of rawComposeSources) {
    const label = String(source?.label ?? "unknown").trim() || "unknown";
    const environment = extractVoiceBridgeEnvironmentFromComposeConfig(source?.content ?? "");
    for (const key of findForbiddenRuntimeKeysInComposeEnvironment(environment)) {
      findings.push({ file: label, key });
    }
  }
  return findings;
}

export function formatComposeSourceForbiddenFindings(findings = []) {
  if (!findings.length) return "none";
  return findings.map((finding) => `${finding.file}:${finding.key}`).join(",");
}

function compareLayer(layerName, env, expected, failures, mismatches) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actual = normalizeEnvValue(env?.[key]);
    if (actual !== expectedValue) {
      failures.push(`${layerName}_${key}_expected_${expectedValue}`);
      mismatches.push({
        layer: layerName,
        key,
        expected: expectedValue,
        actual: actual || "<unset>"
      });
    }
  }
}

function compareEffectiveLayersToAuthoritative(
  authoritativeEnv,
  composeEnvironment,
  containerEnv,
  failures,
  mismatches
) {
  const keys = [
    ...new Set([
      ...Object.keys(authoritativeEnv),
      ...Object.keys(composeEnvironment),
      ...Object.keys(containerEnv)
    ])
  ].filter((key) => VOICE_BRIDGE_RUNTIME_ENV_KEYS.includes(key));

  for (const key of keys) {
    const expected = normalizeEnvValue(authoritativeEnv[key]);
    const composeActual = normalizeEnvValue(composeEnvironment[key]);
    const containerActual = normalizeEnvValue(containerEnv[key]);

    if (composeActual !== expected) {
      failures.push(`compose_config_${key}_mismatch_authoritative`);
      mismatches.push({
        layer: "compose_config",
        key,
        expected: expected || "<unset>",
        actual: composeActual || "<unset>"
      });
    }
    if (containerActual !== expected) {
      failures.push(`container_runtime_${key}_mismatch_authoritative`);
      mismatches.push({
        layer: "container_runtime",
        key,
        expected: expected || "<unset>",
        actual: containerActual || "<unset>"
      });
    }
  }
}

export const BASELINE_SAFE_DISPLAY_KEYS = [
  "VOICE_RUNTIME_VERSION",
  "VOICE_RAG_ENABLED",
  "VOICE_RAG_SALES_ANSWERER_ENABLED",
  "VOICE_V4_LIVE_AUDIOSOCKET_ENABLED",
  "VOICE_SEMANTIC_INTENT_ENABLED",
  "VOICE_CONVERSATION_REPAIR_ENABLED"
];

export function extractAuthoritativeRuntimeEnv(env) {
  return extractSanitizedRuntimeSnapshot(env, VOICE_BRIDGE_RUNTIME_ENV_KEYS);
}

export function runComposeRuntimePreflight(options = {}) {
  const authoritativeEnv = options.authoritativeEnv ?? {};
  const composeEnvironment = options.composeEnvironment ?? {};
  const containerEnv = options.containerEnv ?? {};
  const composeRawSources = options.composeRawSources ?? [];
  const composeProjectEnvKeys = options.composeProjectEnvKeys ?? [];
  const mode = options.mode ?? "baseline";
  const failures = [];
  const mismatches = [];

  const composeSourceForbiddenFindings = inspectRawComposeSources(composeRawSources);
  if (composeSourceForbiddenFindings.length > 0) {
    failures.push("compose_source_environment_forbidden_runtime_keys");
  }

  const projectEnvForbidden = findForbiddenRuntimeKeysInProjectEnvKeys(composeProjectEnvKeys);
  if (projectEnvForbidden.length > 0) {
    failures.push("compose_project_env_forbidden_runtime_keys");
  }

  if (mode === "gate3") {
    compareLayer("authoritative_file", authoritativeEnv, GATE3_REQUIRED_RUNTIME, failures, mismatches);
    compareLayer("compose_config", composeEnvironment, GATE3_REQUIRED_RUNTIME, failures, mismatches);
    compareLayer("container_runtime", containerEnv, GATE3_REQUIRED_RUNTIME, failures, mismatches);
  } else if (mode === "baseline") {
    compareEffectiveLayersToAuthoritative(
      authoritativeEnv,
      composeEnvironment,
      containerEnv,
      failures,
      mismatches
    );
  }

  const ownershipOk =
    composeSourceForbiddenFindings.length === 0 && projectEnvForbidden.length === 0;

  return {
    ok: failures.length === 0,
    mode,
    failures,
    mismatches,
    ownership: {
      ok: ownershipOk,
      composeSourceForbiddenFindings,
      composeSourceForbiddenKeys: [
        ...new Set(composeSourceForbiddenFindings.map((finding) => finding.key))
      ],
      composeProjectEnvForbiddenKeys: projectEnvForbidden,
      composeProjectEnvApprovedKeys: findApprovedInterpolationKeysInProjectEnvKeys(
        composeProjectEnvKeys
      )
    },
    baselineEffectivePass:
      mode === "baseline"
        ? !failures.some((failure) => failure.includes("_mismatch_authoritative"))
        : null,
    layers: {
      authoritative_file: pickRuntimeKeys(authoritativeEnv),
      compose_config: pickRuntimeKeys(composeEnvironment),
      container_runtime: pickRuntimeKeys(containerEnv)
    }
  };
}

function pickRuntimeKeys(env) {
  const picked = {};
  for (const key of [...Object.keys(GATE3_REQUIRED_RUNTIME), ...VOICE_BRIDGE_RUNTIME_ENV_KEYS]) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      picked[key] = normalizeEnvValue(env[key]);
    }
  }
  return picked;
}

export function formatComposeRuntimePreflightLines(result) {
  const displayKeys =
    result?.mode === "gate3" ? Object.keys(GATE3_REQUIRED_RUNTIME) : BASELINE_SAFE_DISPLAY_KEYS;

  const lines = [
    `compose_runtime_preflight=${result?.ok ? "pass" : "fail"}`,
    `mode=${result?.mode ?? "baseline"}`,
    `ownership_pass=${result?.ownership?.ok ? "true" : "false"}`,
    `compose_source_forbidden_by_file=${formatComposeSourceForbiddenFindings(result?.ownership?.composeSourceForbiddenFindings)}`,
    `compose_project_env_forbidden_keys=${result?.ownership?.composeProjectEnvForbiddenKeys?.join(",") || "none"}`,
    `compose_project_env_approved_keys=${result?.ownership?.composeProjectEnvApprovedKeys?.join(",") || "none"}`
  ];

  if (result?.mode === "baseline") {
    lines.push(`baseline_effective_pass=${result?.baselineEffectivePass ? "true" : "false"}`);
  }

  lines.push(
    `failure_count=${result?.failures?.length ?? 0}`,
    `failures=${result?.failures?.join(",") || "none"}`
  );

  for (const layerName of ["authoritative_file", "compose_config", "container_runtime"]) {
    const layer = result?.layers?.[layerName] ?? {};
    for (const key of displayKeys) {
      const value = normalizeEnvValue(layer[key]);
      lines.push(`${layerName}.${key}=${value || "<unset>"}`);
    }
  }

  for (const mismatch of result?.mismatches ?? []) {
    lines.push(
      `mismatch layer=${mismatch.layer} key=${mismatch.key} expected=${mismatch.expected} actual=${mismatch.actual}`
    );
  }

  return lines.join("\n");
}

export function assertOutputIsPrivacySafe(output) {
  const text = String(output ?? "");
  for (const secretName of SECRET_ENV_DENYLIST) {
    if (text.includes(`${secretName}=`)) {
      throw new Error(`privacy_violation:${secretName}`);
    }
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error("privacy_violation:secret_pattern");
    }
  }
  return true;
}
