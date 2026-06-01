/**
 * v4 session/version metadata helpers for future persistence paths.
 */

import { getAgentVersionMetadata } from "./agent-config.js";

export function buildPersistMetadata(config, agentConfigResult = null) {
  const fromAgent = agentConfigResult?.ok ? getAgentVersionMetadata(agentConfigResult.config) : null;
  const runtimeVersion = String(config?.v4?.runtimeVersion ?? "v3").trim();
  return {
    tenant_id: String(fromAgent?.tenant_id ?? config?.v4?.tenantId ?? "technolohit").trim(),
    agent_id: String(fromAgent?.agent_id ?? config?.v4?.agentId ?? "main_voice_sales").trim(),
    agent_config_version: fromAgent?.agent_config_version ?? null,
    prompt_playbook_version: fromAgent?.prompt_playbook_version ?? null,
    knowledge_version: fromAgent?.knowledge_version ?? null,
    runtime_version: fromAgent?.runtime_version ?? runtimeVersion
  };
}

export function mergeMetadataPayload(base = {}, metadata = {}) {
  return {
    ...(base && typeof base === "object" ? base : {}),
    v4: {
      ...(base?.v4 && typeof base.v4 === "object" ? base.v4 : {}),
      tenant_id: metadata.tenant_id,
      agent_id: metadata.agent_id,
      agent_config_version: metadata.agent_config_version,
      prompt_playbook_version: metadata.prompt_playbook_version,
      knowledge_version: metadata.knowledge_version,
      runtime_version: metadata.runtime_version
    }
  };
}
