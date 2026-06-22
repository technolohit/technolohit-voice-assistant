#!/usr/bin/env node

import { loadVoiceBridgeEnv } from "../src/load-env.js";
import { loadConfig } from "../src/config.js";
import {
  assertPlaybookCanaryPreflightOutputIsSafe,
  formatPlaybookCanaryPreflight,
  runPlaybookCanaryPreflight,
} from "../src/v4/playbook-canary-preflight.js";

loadVoiceBridgeEnv();
const result = runPlaybookCanaryPreflight(loadConfig());
const output = formatPlaybookCanaryPreflight(result);
assertPlaybookCanaryPreflightOutputIsSafe(output);
console.log(output);
process.exit(result.ok ? 0 : 1);
