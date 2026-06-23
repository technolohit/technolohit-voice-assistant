#!/usr/bin/env node

import {
  assertPlaybookCanaryArtifactOutputIsPrivacySafe,
  formatPlaybookCanaryArtifactValidation,
  validatePlaybookCanaryArtifacts,
} from "../src/v4/playbook-canary-artifact-validator.js";

const result = validatePlaybookCanaryArtifacts();
const output = formatPlaybookCanaryArtifactValidation(result);
assertPlaybookCanaryArtifactOutputIsPrivacySafe(output);
console.log(output);
process.exit(result.ok ? 0 : 1);
