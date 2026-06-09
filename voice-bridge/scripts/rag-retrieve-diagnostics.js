#!/usr/bin/env node
/**
 * Non-live RAG retrieve diagnostics for Gate 3 timeout vs miss classification.
 * Prints safe markers only (no raw query/transcript/snippet).
 */

import { loadVoiceBridgeEnv } from "../src/load-env.js";
import { loadConfig } from "../src/config.js";
import {
  formatRagRetrieveDiagnosticsLines,
  runRagRetrieveDiagnostics
} from "../src/v4/rag-retrieve-diagnostics.js";

loadVoiceBridgeEnv();
const config = loadConfig();
const attemptCount = Number(process.env.VOICE_RAG_RETRIEVE_DIAGNOSTIC_ATTEMPTS ?? 5);
const result = await runRagRetrieveDiagnostics(config, {
  attemptCount: Number.isFinite(attemptCount) && attemptCount > 0 ? attemptCount : 5
});
console.log(formatRagRetrieveDiagnosticsLines(result));
process.exit(result.ok ? 0 : 1);
