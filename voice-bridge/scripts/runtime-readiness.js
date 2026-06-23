#!/usr/bin/env node
/**
 * Non-live handler readiness report — distinguishes startup router stub from
 * per-call live v4 canary handler selection.
 */

import { loadConfig } from "../src/config.js";
import { describeLiveHandlerReadiness } from "../src/v4/runtime-router.js";
import { resolveBehaviorPolicy } from "../src/v4/behavior-policy.js";
import { buildPlaybookProvenance } from "../src/v4/playbook-provenance.js";

const config = loadConfig();
const readiness = describeLiveHandlerReadiness(config);
const behaviorPolicy = resolveBehaviorPolicy({ config, v4PathActive: readiness.live_audiosocket_canary_configured });
const provenance = buildPlaybookProvenance(config, behaviorPolicy);

console.log(
  JSON.stringify(
    {
      ok: true,
      ...readiness,
      playbook_runtime_enabled: Boolean(config?.v4?.playbookRuntimeEnabled),
      playbook_provenance: provenance,
    },
    null,
    2,
  ),
);
