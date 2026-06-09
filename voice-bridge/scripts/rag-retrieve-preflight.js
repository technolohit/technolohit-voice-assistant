#!/usr/bin/env node
/**
 * Gate 3 retrieve-level preflight — verifies Smart Website knowledge is retrievable.
 * Prints safe markers only (no raw query/transcript/snippet).
 */

import { loadVoiceBridgeEnv } from "../src/load-env.js";
import { loadConfig } from "../src/config.js";
import {
  formatRagRetrievePreflightLines,
  runRagRetrievePreflight
} from "../src/v4/rag-retrieve-preflight.js";

loadVoiceBridgeEnv();
const config = loadConfig();
const result = await runRagRetrievePreflight(config);
console.log(formatRagRetrievePreflightLines(result));
process.exit(result.ok ? 0 : 1);
