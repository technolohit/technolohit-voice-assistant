/**
 * Build tenant/agent-scoped RAG retrieve payloads for voice-bridge.
 */

import { getAgentVersionMetadata } from "./agent-config.js";

export const ALLOWED_RAG_PURPOSES = new Set([
  "product_question",
  "sales_qa",
  "sales_product_explanation",
  "semantic_knowledge_question",
  "voice_bridge_fallback",
  "rag_sales_answerer"
]);

const FORBIDDEN_RAG_DELEGATIONS = new Set([
  "lead_validation",
  "callback_permission",
  "contact_validation",
  "phone_validation",
  "lead_ready"
]);

export function resolveRagScope(config, agentConfigResult = null) {
  const fromAgent = agentConfigResult?.ok ? getAgentVersionMetadata(agentConfigResult.config) : null;
  return {
    tenant_id: String(fromAgent?.tenant_id ?? config?.v4?.tenantId ?? "technolohit").trim(),
    agent_id: String(fromAgent?.agent_id ?? config?.v4?.agentId ?? "main_voice_sales").trim()
  };
}

export function assertRagPurposeAllowed(purpose) {
  const normalized = String(purpose ?? "").trim().toLowerCase();
  if (FORBIDDEN_RAG_DELEGATIONS.has(normalized)) {
    return { ok: false, reason: "rag_cannot_validate_leads_or_permissions" };
  }
  if (!normalized || ALLOWED_RAG_PURPOSES.has(normalized)) {
    return { ok: true, reason: "allowed" };
  }
  return { ok: true, reason: "allowed_unlisted_purpose" };
}

export function isLeadValidationDelegatedToRag(context = {}) {
  const source = String(context?.source ?? "").toLowerCase();
  if (FORBIDDEN_RAG_DELEGATIONS.has(source)) return true;
  return Boolean(context?.delegate_lead_validation || context?.validate_contact);
}

export function buildRagRetrievePayload(config, input = {}, agentConfigResult = null) {
  const scope = resolveRagScope(config, agentConfigResult);
  const query = String(input.query ?? "").trim();
  if (!query) {
    throw new Error("query is required for RAG retrieve payload");
  }

  const context = {
    ...(input.context && typeof input.context === "object" ? input.context : {}),
    tenant_id: scope.tenant_id,
    agent_id: scope.agent_id
  };

  if (isLeadValidationDelegatedToRag(context)) {
    throw new Error("RAG context must not delegate lead or permission validation");
  }

  const purpose = String(context.source ?? input.purpose ?? "sales_qa");
  const purposeCheck = assertRagPurposeAllowed(purpose);
  if (!purposeCheck.ok) {
    throw new Error(purposeCheck.reason);
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
    context
  };
}

/** Documented default RAG base URL for host-network voice-bridge deployments. */
export const V4_RAG_HOST_LOCAL_BASE_URL = "http://127.0.0.1:8080";

export function resolveDocumentedRagBaseUrl(config) {
  const configured = String(config?.rag?.apiUrl ?? "").trim();
  return configured || V4_RAG_HOST_LOCAL_BASE_URL;
}