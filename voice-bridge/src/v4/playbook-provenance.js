/**
 * Phase 12E — runtime playbook provenance from verified Behavior Policy / binding.
 *
 * Fail closed: never claim a published playbook version when provenance cannot
 * be resolved from the verified binding path.
 */

import { getAgentVersionMetadata } from "./agent-config.js";
import { isV4CanaryPathActive } from "./playbook-runtime-binding.js";

export function buildPlaybookProvenance(config = null, behaviorPolicy = null) {
  const runtimeEnabled = Boolean(config?.v4?.playbookRuntimeEnabled);
  const canaryActive = isV4CanaryPathActive(config);

  if (!runtimeEnabled || !canaryActive) {
    return {
      playbook_version: null,
      playbook_binding_version: null,
      playbook_source: null,
      playbook_provenance_ok: true,
      playbook_provenance_reason: runtimeEnabled ? "v4_canary_path_inactive" : "playbook_runtime_disabled",
    };
  }

  if (
    behaviorPolicy?.source === "playbook" &&
    typeof behaviorPolicy.playbook_version === "string" &&
    behaviorPolicy.playbook_version.trim()
  ) {
    const bindingVersion =
      typeof behaviorPolicy.playbook_binding_version === "string"
        ? behaviorPolicy.playbook_binding_version.trim()
        : null;
    return {
      playbook_version: behaviorPolicy.playbook_version.trim(),
      playbook_binding_version: bindingVersion || null,
      playbook_source: bindingVersion ? "approved_runtime_binding" : "playbook",
      playbook_provenance_ok: true,
      playbook_provenance_reason: behaviorPolicy.reason ?? "playbook_runtime_active",
    };
  }

  return {
    playbook_version: null,
    playbook_binding_version: null,
    playbook_source: null,
    playbook_provenance_ok: false,
    playbook_provenance_reason: behaviorPolicy?.reason ?? "playbook_provenance_unresolved",
  };
}

export function buildPlaybookProvenanceFields(config = null, behaviorPolicy = null, agentConfigResult = null) {
  const fromAgent = agentConfigResult?.ok ? getAgentVersionMetadata(agentConfigResult.config) : null;
  const provenance = buildPlaybookProvenance(config, behaviorPolicy);
  return {
    ...provenance,
    agent_config_version: fromAgent?.agent_config_version ?? null,
    agent_config_playbook_version: fromAgent?.prompt_playbook_version ?? null,
  };
}

/** Flat quality-event fields for response_plan_created and persistence enrichment. */
export function playbookProvenanceQualityPayload({
  config = null,
  behaviorPolicy = null,
  agentConfigResult = null,
} = {}) {
  return buildPlaybookProvenanceFields(config, behaviorPolicy, agentConfigResult);
}
