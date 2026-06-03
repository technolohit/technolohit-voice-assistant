#!/usr/bin/env node
/**
 * Compose/runtime preflight — baseline (Stage A, safe v3/RAG-off) or gate3 (RAG-on canary).
 */

import fs from "node:fs";
import path from "node:path";
import {
  assertOutputIsPrivacySafe,
  extractAuthoritativeRuntimeEnv,
  extractEnvKeyNames,
  extractEnvKeyNamesFromList,
  extractSanitizedRuntimeSnapshot,
  formatComposeRuntimePreflightLines,
  parseEnvAssignments,
  PREFLIGHT_DOCKER_USER,
  runComposeRuntimePreflight,
  VOICE_BRIDGE_RUNTIME_ENV_KEYS
} from "../src/v4/compose-runtime-preflight.js";

function readRepeatedArgValues(flag, args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && index + 1 < args.length) {
      values.push(args[index + 1]);
    }
  }
  return values;
}

function resolveMode(args) {
  if (args.includes("--gate3")) return "gate3";
  if (args.includes("--baseline")) return "baseline";
  return "baseline";
}

const args = process.argv.slice(2);
const mode = resolveMode(args);

const authoritativePath =
  readRepeatedArgValues("--authoritative-file", args)[0] ??
  readRepeatedArgValues("--authoritative", args)[0];
const composeConfigPath =
  readRepeatedArgValues("--compose-config-file", args)[0] ??
  readRepeatedArgValues("--compose-config", args)[0];
const containerEnvPath =
  readRepeatedArgValues("--container-env-file", args)[0] ??
  readRepeatedArgValues("--container-env", args)[0];
const rawComposePaths = readRepeatedArgValues("--raw-compose-file", args);
const composeProjectEnvKeysPath =
  readRepeatedArgValues("--compose-project-env-keys-file", args)[0] ??
  readRepeatedArgValues("--compose-project-env-keys", args)[0];

if (
  !authoritativePath ||
  !composeConfigPath ||
  !containerEnvPath ||
  rawComposePaths.length === 0 ||
  !composeProjectEnvKeysPath
) {
  console.error(
    "Usage: node scripts/compose-runtime-preflight.js --baseline|--gate3 \\\n" +
      "  --authoritative-file /tmp/authoritative-snapshot.env \\\n" +
      "  --compose-config-file /tmp/compose-snapshot.env \\\n" +
      "  --container-env-file /tmp/container-snapshot.env \\\n" +
      "  --raw-compose-file /raw/docker-compose.yml \\\n" +
      "  --raw-compose-file /raw/docker-compose.prod.yml \\\n" +
      "  --compose-project-env-keys-file /tmp/compose-project-env-keys.txt\n\n" +
      "  --baseline  Stage A: ownership + effective match (safe v3/RAG-off)\n" +
      "  --gate3     Gate 3 only: requires v4/RAG-on values\n\n" +
      `Preflight docker user: ${PREFLIGHT_DOCKER_USER}`
  );
  process.exit(2);
}

const authoritativeEnv = parseEnvAssignments(fs.readFileSync(authoritativePath, "utf8"));
const composeEnvironment = parseEnvAssignments(fs.readFileSync(composeConfigPath, "utf8"));
const containerEnv = parseEnvAssignments(fs.readFileSync(containerEnvPath, "utf8"));
const composeProjectEnvKeysContent = fs.readFileSync(composeProjectEnvKeysPath, "utf8");

const composeRawSources = rawComposePaths.map((filePath) => ({
  label: path.basename(filePath),
  content: fs.readFileSync(filePath, "utf8")
}));

const snapshotKeys = mode === "gate3" ? undefined : VOICE_BRIDGE_RUNTIME_ENV_KEYS;

const result = runComposeRuntimePreflight({
  mode,
  authoritativeEnv:
    mode === "gate3"
      ? extractSanitizedRuntimeSnapshot(authoritativeEnv)
      : extractAuthoritativeRuntimeEnv(authoritativeEnv),
  composeEnvironment: extractSanitizedRuntimeSnapshot(composeEnvironment, snapshotKeys),
  containerEnv: extractSanitizedRuntimeSnapshot(containerEnv, snapshotKeys),
  composeRawSources,
  composeProjectEnvKeys: extractEnvKeyNamesFromList(composeProjectEnvKeysContent).length
    ? extractEnvKeyNamesFromList(composeProjectEnvKeysContent)
    : extractEnvKeyNames(composeProjectEnvKeysContent)
});

const output = formatComposeRuntimePreflightLines(result);
assertOutputIsPrivacySafe(output);
console.log(output);
process.exit(result.ok ? 0 : 1);
