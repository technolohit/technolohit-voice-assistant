/**
 * Gate 3 retrieve-level preflight — verifies RAG can return Smart Website knowledge.
 * Safe output only: no raw query, transcript, phone, email, or snippet text.
 */

import { retrieveRagContext } from "../rag-client.js";
import { loadAgentConfig } from "./agent-config.js";
import { runRagCanaryPreflight } from "./rag-canary-preflight.js";
import {
  PROBE_PRODUCT_SCOPE,
  buildSmartWebsiteRetrievePayload,
  classifyRetrieveOutcome,
  runtimeRetrieveTimeoutMs,
  validateRetrievePayload
} from "./rag-retrieve-probe.js";

function safeBoolean(value) {
  return value ? "true" : "false";
}

export async function runRagRetrievePreflight(config, options = {}) {
  const retrieveFn = options.retrieveFn ?? retrieveRagContext;
  const agentConfig = options.agentConfig ?? loadAgentConfig(config);
  const canary = options.skipCanary
    ? { ok: true, checks: {}, failures: [], ragHealthOk: true }
    : await runRagCanaryPreflight(config, { fetchImpl: options.fetchImpl });

  const failures = [...(canary.failures ?? [])];
  const checks = { ...(canary.checks ?? {}) };
  const runtimeTimeout = runtimeRetrieveTimeoutMs(config);

  if (!canary.ok) {
    return {
      ok: false,
      checks,
      failures,
      canary,
      retrieve: null,
      product_scope: PROBE_PRODUCT_SCOPE,
      result_count: 0,
      hit: false,
      top_score: null,
      fallback_reason: "canary_preflight_failed",
      timeout_ms: runtimeTimeout
    };
  }

  let payload;
  try {
    ({ payload } = buildSmartWebsiteRetrievePayload(config, {
      agentConfig,
      buildV4RagQueryFn: options.buildV4RagQueryFn
    }));
  } catch (err) {
    failures.push(`rag_payload_build_${String(err?.message ?? "failed").slice(0, 40)}`);
    return {
      ok: false,
      checks,
      failures,
      canary,
      retrieve: null,
      product_scope: PROBE_PRODUCT_SCOPE,
      result_count: 0,
      hit: false,
      top_score: null,
      fallback_reason: "payload_invalid",
      timeout_ms: runtimeTimeout
    };
  }

  const payloadValidation = validateRetrievePayload(payload);
  Object.assign(checks, payloadValidation.checks);
  failures.push(...payloadValidation.failures);

  if (failures.length > 0) {
    const primaryFailure = payloadValidation.failures.includes("wrong_product_scope")
      ? "wrong_product_scope"
      : "payload_invalid";
    return {
      ok: false,
      checks,
      failures,
      canary,
      retrieve: null,
      product_scope: PROBE_PRODUCT_SCOPE,
      result_count: 0,
      hit: false,
      top_score: null,
      fallback_reason: primaryFailure,
      payload_tenant_id: payload.tenant_id,
      payload_agent_id: payload.agent_id,
      timeout_ms: runtimeTimeout,
      min_score: payload.min_score ?? null
    };
  }

  let ragResult;
  try {
    ragResult = await retrieveFn(config, {
      ...payload,
      timeoutMs: runtimeTimeout
    });
  } catch {
    failures.push("rag_unavailable");
    return {
      ok: false,
      checks,
      failures,
      canary,
      retrieve: { ok: false, reason: "request_failed" },
      product_scope: PROBE_PRODUCT_SCOPE,
      result_count: 0,
      hit: false,
      top_score: null,
      fallback_reason: "rag_unavailable",
      payload_tenant_id: payload.tenant_id,
      payload_agent_id: payload.agent_id,
      timeout_ms: runtimeTimeout,
      min_score: payload.min_score ?? null
    };
  }

  const outcome = classifyRetrieveOutcome(ragResult, payload);
  checks.rag_retrieve_ok = Boolean(ragResult?.ok);
  checks.rag_retrieve_parseable = ragResult != null && typeof ragResult === "object";
  if (outcome.failure) failures.push(outcome.failure);

  return {
    ok: failures.length === 0,
    checks,
    failures,
    canary,
    retrieve: {
      ok: Boolean(ragResult?.ok),
      hit: outcome.hit,
      result_count: outcome.result_count,
      top_score: outcome.top_score,
      rag_http_status: ragResult?.status ?? null,
      latency_ms: ragResult?.latencyMs ?? null,
      fallback_reason: outcome.fallback_reason
    },
    product_scope: PROBE_PRODUCT_SCOPE,
    result_count: outcome.result_count,
    hit: outcome.hit,
    top_score: outcome.top_score,
    fallback_reason: outcome.fallback_reason,
    payload_tenant_id: payload.tenant_id,
    payload_agent_id: payload.agent_id,
    min_score: payload.min_score ?? null,
    timeout_ms: runtimeTimeout
  };
}

export function formatRagRetrievePreflightLines(result) {
  const retrieve = result?.retrieve ?? {};
  const lines = [
    `rag_retrieve_preflight=${result?.ok ? "pass" : "fail"}`,
    `product_scope=${result?.product_scope ?? PROBE_PRODUCT_SCOPE}`,
    `result_count=${result?.result_count ?? 0}`,
    `hit=${safeBoolean(result?.hit)}`,
    `top_score=${result?.top_score ?? "none"}`,
    `fallback_reason=${result?.fallback_reason ?? "none"}`,
    `payload_tenant_id=${result?.payload_tenant_id ?? "none"}`,
    `payload_agent_id=${result?.payload_agent_id ?? "none"}`,
    `rag_retrieve_ok=${safeBoolean(retrieve.ok)}`,
    `rag_http_status=${retrieve.rag_http_status ?? "none"}`,
    `rag_latency_ms=${retrieve.latency_ms ?? 0}`,
    `timeout_ms=${result?.timeout_ms ?? 0}`,
    `min_score=${result?.min_score ?? "none"}`,
    `failure_count=${result?.failures?.length ?? 0}`,
    `failures=${result?.failures?.join(",") || "none"}`
  ];
  return lines.join("\n");
}
