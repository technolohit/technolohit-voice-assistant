#!/usr/bin/env node
/**
 * Mandatory hard guard before a supervised v4 RAG-on live canary.
 * Prints safe configuration/health booleans only.
 */

import { loadVoiceBridgeEnv } from "../src/load-env.js";
import { loadConfig } from "../src/config.js";
import {
  formatRagCanaryPreflightLines,
  runRagCanaryPreflight
} from "../src/v4/rag-canary-preflight.js";

loadVoiceBridgeEnv();
const config = loadConfig();
const result = await runRagCanaryPreflight(config);
console.log(formatRagCanaryPreflightLines(result));
process.exit(result.ok ? 0 : 1);
