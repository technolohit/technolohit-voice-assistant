#!/usr/bin/env node

import {
  formatPlaybookCanaryArtifactValidation,
  validatePlaybookCanaryArtifacts,
} from "../src/v4/playbook-canary-artifact-validator.js";

const result = validatePlaybookCanaryArtifacts();
console.log(formatPlaybookCanaryArtifactValidation(result));
process.exit(result.ok ? 0 : 1);
