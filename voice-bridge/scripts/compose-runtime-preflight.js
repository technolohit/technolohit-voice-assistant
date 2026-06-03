#!/usr/bin/env node
/**
 * Gate 3 compose/runtime preflight.
 * Expects sanitized snapshots for effective layers and raw Compose sources for ownership checks.
 */

import fs from "node:fs";
import path from "node:path";
import {
  assertOutputIsPrivacySafe,
  extractEnvKeyNames,
  extractEnvKeyNamesFromList,
  extractSanitizedRuntimeSnapshot,
  extractVoiceBridgeEnvironmentFromComposeConfig,
  formatComposeRuntimePreflightLines,
  parseEnvAssignments,
  PREFLIGHT_DOCKER_USER,
  runComposeRuntimePreflight
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

function readInput(flag, args) {
  const values = readRepeatedArgValues(flag, args);
  if (values.length === 0) return null;
  if (values.length === 1) return fs.readFileSync(values[0], "utf8");
  return values.map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");
}

const args = process.argv.slice(2);
const mode = args.includes("--gate3") ? "gate3" : "gate3";

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
    "Usage: node scripts/compose-runtime-preflight.js --gate3 \\\n" +
      "  --authoritative-file /tmp/authoritative-snapshot.env \\\n" +
      "  --compose-config-file /tmp/compose-snapshot.env \\\n" +
      "  --container-env-file /tmp/container-snapshot.env \\\n" +
      "  --raw-compose-file /raw/docker-compose.yml \\\n" +
      "  --raw-compose-file /raw/docker-compose.prod.yml \\\n" +
      "  --compose-project-env-keys-file /tmp/compose-project-env-keys.txt\n\n" +
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

const result = runComposeRuntimePreflight({
  mode,
  authoritativeEnv: extractSanitizedRuntimeSnapshot(authoritativeEnv),
  composeEnvironment: extractSanitizedRuntimeSnapshot(composeEnvironment),
  containerEnv: extractSanitizedRuntimeSnapshot(containerEnv),
  composeRawSources,
  composeProjectEnvKeys: extractEnvKeyNamesFromList(composeProjectEnvKeysContent).length
    ? extractEnvKeyNamesFromList(composeProjectEnvKeysContent)
    : extractEnvKeyNames(composeProjectEnvKeysContent)
});

const output = formatComposeRuntimePreflightLines(result);
assertOutputIsPrivacySafe(output);
console.log(output);
process.exit(result.ok ? 0 : 1);
