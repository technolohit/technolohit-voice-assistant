#!/usr/bin/env node
/**
 * Mandatory OpenAI STT preflight before supervised v4 live canary (Phase 10J).
 * Prints only safe fields — no API keys or transcript text.
 */

import { loadVoiceBridgeEnv } from "../src/load-env.js";
import { loadConfig } from "../src/config.js";
import {
  formatOpenAiSttPreflightLines,
  runOpenAiSttPreflight
} from "../src/v4/openai-stt-preflight.js";

loadVoiceBridgeEnv();
const config = loadConfig();

const result = await runOpenAiSttPreflight(config);
console.log(formatOpenAiSttPreflightLines(result));
process.exit(result.ok ? 0 : 1);
