#!/usr/bin/env node
/**
 * Phase 11 — validate publish candidate playbook (non-live governance).
 */

import {
  assertPublishValidationOutputIsPrivacySafe,
  formatPublishValidationOutput,
  runPublishValidation,
} from "../src/v4/playbook-publish-validator.js";

const args = process.argv.slice(2);
const skipEval = args.includes("--skip-eval");
const modeArg = args.find((entry) => entry.startsWith("--mode="));
const playbookPathArg = args.find((entry) => entry.startsWith("--playbook="));
const mode = modeArg ? modeArg.slice("--mode=".length) : undefined;
const playbookPath = playbookPathArg ? playbookPathArg.slice("--playbook=".length) : undefined;

const result = await runPublishValidation({ mode, playbookPath, skipEval });
const output = formatPublishValidationOutput(result);
assertPublishValidationOutputIsPrivacySafe(output);
process.stdout.write(output);
process.exit(result.ok ? 0 : 1);
