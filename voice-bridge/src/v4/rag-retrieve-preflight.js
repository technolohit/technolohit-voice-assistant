/**
 * Gate 3 retrieve-level preflight — verifies RAG can return Smart Website knowledge.
 * Safe output only: no raw query, transcript, phone, email, or snippet text.
 */

import { retrieveRagContext } from "../rag-client.js";
import { loadAgentConfig } from "./agent-config.js";
import { buildV4RagQuery } from "./rag-orchestrator.js";
import { runRagCanaryPreflight } from "./rag-canary-preflight.js";
import { createCallSessionMemory, setSelectedProduct } from "./call-session-memory.js";
import { V4_STATES } from "./state-machine.js";

const PREFLIGHT_PRODUCT_SCOPE = "smart_website";
const PREFLIGHT_QUERY = "Was ist Smart Website und was kostet sie?";
const EMAIL_IN_TEXT = /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/i;
const PHONE_IN_TEXT = /\b(\+?\d[\d\s\-()/]{5,}\d)\b/;

function safeBoolean(value) {
  return value ? "true" : "false";
}

function payloadContainsPrivateData(payload) {
  const serialized = JSON.stringify(payload ?? {});
  return EMAIL_IN_TEXT.test(serialized) || PHONE_IN_TEXT.test(serialized);
}

export async function runRagRetrievePreflight(config, options = {}) {
  const retrieveFn = options.retrieveFn ?? retrieveRagContext;
  const agentConfig = options.agentConfig ?? loadAgentConfig(config);
  const canary = options.skipCanary
    ? { ok: true, checks: {}, failures: [], ragHealthOk: true }
    : await runRagCanaryPreflight(config, { fetchImpl: options.fetchImpl });

  const failures = [...(canary.failures ?? [])];
  const checks = { ...(canary.checks ?? {}) };

  if (!canary.ok) {
    return {
      ok: false,
      checks,
      failures,
      canary,
      retrieve: null,
      product_scope: PREFLIGHT_PRODUCT_SCOPE,
      result_count: 0,
      hit: false,
      top_score: null,
      fallback_reason: "canary_preflight_failed"
    };
  }

  const buildQuery = options.buildV4RagQueryFn ?? buildV4RagQuery;
  let payload;
  try {
    const memory = setSelectedProduct(
      createCallSessionMemory({ bridgeCallId: "rag-retrieve-preflight" }),
      PREFLIGHT_PRODUCT_SCOPE
    );
    memory.current_product_context = PREFLIGHT_PRODUCT_SCOPE;
    payload = buildQuery({
      config,
      agentConfig,
      transcript: PREFLIGHT_QUERY,
      memory,
      stateMachine: { state: V4_STATES.THINKING }
    });
  } catch (err) {
    failures.push(`rag_payload_build_${String(err?.message ?? "failed").slice(0, 40)}`);
    return {
      ok: false,
      checks,
      failures,
      canary,
      retrieve: null,
      product_scope: PREFLIGHT_PRODUCT_SCOPE,
      result_count: 0,
      hit: false,
      top_score: null,
      fallback_reason: "payload_invalid"
    };
  }

  checks.payload_tenant_id = payload.tenant_id === "technolohit";
  checks.payload_agent_id = payload.agent_id === "main_voice_sales";
  checks.payload_product_scope = payload.context?.product_scope === PREFLIGHT_PRODUCT_SCOPE;
  checks.payload_privacy_safe = !payloadContainsPrivateData(payload);

  if (!checks.payload_tenant_id) failures.push("payload_tenant_id_not_technolohit");
  if (!checks.payload_agent_id) failures.push("payload_agent_id_not_main_voice_sales");
  if (!checks.payload_product_scope) failures.push("payload_product_scope_not_smart_website");
  if (!checks.payload_privacy_safe) failures.push("payload_contains_private_data");

  if (failures.length > 0) {
    return {
      ok: false,
      checks,
      failures,
      canary,
      retrieve: null,
      product_scope: PREFLIGHT_PRODUCT_SCOPE,
      result_count: 0,
      hit: false,
      top_score: null,
      fallback_reason: "payload_invalid",
      payload_tenant_id: payload.tenant_id,
      payload_agent_id: payload.agent_id
    };
  }

  let ragResult;
  try {
    ragResult = await retrieveFn(config, {
      ...payload,
      timeoutMs: Math.max(100, Number(config?.rag?.timeoutMs ?? 700))
    });
  } catch {
    failures.push("rag_retrieve_unreachable");
    return {
      ok: false,
      checks,
      failures,
      canary,
      retrieve: { ok: false, reason: "request_failed" },
      product_scope: PREFLIGHT_PRODUCT_SCOPE,
      result_count: 0,
      hit: false,
      top_score: null,
      fallback_reason: "rag_retrieve_unreachable",
      payload_tenant_id: payload.tenant_id,
      payload_agent_id: payload.agent_id
    };
  }

  const resultCount = Number(ragResult?.hitCount ?? ragResult?.data?.answer_context?.length ?? 0);
  const hit = Boolean(ragResult?.ok && ragResult?.hit && resultCount > 0);
  const topScore = Number.isFinite(ragResult?.topScore) ? ragResult.topScore : null;
  const fallbackReason = !ragResult?.ok
    ? ragResult?.reason ?? "rag_unavailable"
    : hit
      ? null
      : "rag_miss";

  checks.rag_retrieve_ok = Boolean(ragResult?.ok);
  checks.rag_retrieve_parseable = ragResult != null && typeof ragResult === "object";
  if (!checks.rag_retrieve_ok) failures.push(`rag_retrieve_${ragResult?.reason ?? "failed"}`);
  if (checks.rag_retrieve_ok && !hit) failures.push("rag_miss");

  return {
    ok: failures.length === 0,
    checks,
    failures,
    canary,
    retrieve: {
      ok: Boolean(ragResult?.ok),
      hit,
      result_count: resultCount,
      top_score: topScore,
      rag_http_status: ragResult?.status ?? null,
      latency_ms: ragResult?.latencyMs ?? null,
      fallback_reason: fallbackReason
    },
    product_scope: PREFLIGHT_PRODUCT_SCOPE,
    result_count: resultCount,
    hit,
    top_score: topScore,
    fallback_reason: fallbackReason,
    payload_tenant_id: payload.tenant_id,
    payload_agent_id: payload.agent_id,
    min_score: payload.min_score ?? null
  };
}

export function formatRagRetrievePreflightLines(result) {
  const retrieve = result?.retrieve ?? {};
  const lines = [
    `rag_retrieve_preflight=${result?.ok ? "pass" : "fail"}`,
    `product_scope=${result?.product_scope ?? PREFLIGHT_PRODUCT_SCOPE}`,
    `result_count=${result?.result_count ?? 0}`,
    `hit=${safeBoolean(result?.hit)}`,
    `top_score=${result?.top_score ?? "none"}`,
    `fallback_reason=${result?.fallback_reason ?? "none"}`,
    `payload_tenant_id=${result?.payload_tenant_id ?? "none"}`,
    `payload_agent_id=${result?.payload_agent_id ?? "none"}`,
    `rag_retrieve_ok=${safeBoolean(retrieve.ok)}`,
    `rag_http_status=${retrieve.rag_http_status ?? "none"}`,
    `rag_latency_ms=${retrieve.latency_ms ?? 0}`,
    `min_score=${result?.min_score ?? "none"}`,
    `failure_count=${result?.failures?.length ?? 0}`,
    `failures=${result?.failures?.join(",") || "none"}`
  ];
  return lines.join("\n");
}
