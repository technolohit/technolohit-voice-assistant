/**
 * Build tenant/agent-scoped RAG retrieve payloads for voice-bridge.
 */

import { getAgentVersionMetadata } from "./agent-config.js";

export function resolveRagScope(config, agentConfigResult = null) {
  const fromAgent = agentConfigResult?.ok ? getAgentVersionMetadata(agentConfigResult.config) : null;
  return {
    tenant_id: String(fromAgent?.tenant_id ?? config?.v4?.tenantId ?? "technolohit").trim(),
    agent_id: String(fromAgent?.agent_id ?? config?.v4?.agentId ?? "main_voice_sales").trim()
  };
}

export function buildRagRetrievePayload(config, input = {}, agentConfigResult = null) {
  const scope = resolveRagScope(config, agentConfigResult);
  const query = String(input.query ?? "").trim();
  if (!query) {
    throw new Error("query is required for RAG retrieve payload");
  }

  return {
    tenant_id: scope.tenant_id,
    agent_id: scope.agent_id,
    query,
    language: String(input.language ?? "de").trim() || "de",
    top_k: Number.isFinite(Number(input.top_k)) ? Number(input.top_k) : 3,
    min_score: Number.isFinite(Number(input.min_score))
      ? Number(input.min_score)
      : Number(config?.rag?.minScore ?? 0.72),
    context: {
      ...(input.context && typeof input.context === "object" ? input.context : {}),
      tenant_id: scope.tenant_id,
      agent_id: scope.agent_id
    }
  };
}
