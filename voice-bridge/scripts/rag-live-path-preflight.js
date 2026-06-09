#!/usr/bin/env node
/**
 * Gate 3 live-path RAG preflight — same retrieveV4RagAnswer() path as live v4 canary.
 * Prints safe markers only (no raw query/transcript/snippet).
 */

import { loadVoiceBridgeEnv } from "../src/load-env.js";
import { loadConfig } from "../src/config.js";
import {
  formatRagLivePathPreflightLines,
  runRagLivePathPreflight,
} from "../src/v4/rag-live-path-preflight.js";

loadVoiceBridgeEnv();
const config = loadConfig();
const result = await runRagLivePathPreflight(config);
console.log(formatRagLivePathPreflightLines(result));
process.exit(result.ok ? 0 : 1);
