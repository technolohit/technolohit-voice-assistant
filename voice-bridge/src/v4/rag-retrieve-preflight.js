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
  runtimeRetrieveMaxAttempts,
  runtimeRetrieveTimeoutMs,
  validateRetrievePayload
} from "./rag-retrieve-probe.js";

function safeBoolean(value) {
  return value ? "true" : "false";
}

function resolvePreflightAttemptCount(config, options = {}) {
  const raw = Number(options.attemptCount ?? runtimeRetrieveMaxAttempts(config));
  if (!Number.isFinite(raw)) return runtimeRetrieveMaxAttempts(config);
  return Math.max(1, Math.min(5, Math.trunc(raw)));
}

function summarizeAttemptResults(attempts = [], payload = {}) {
  const outcomes = attempts.map((entry) => ({
    ragResult: entry.ragResult,
    outcome: classifyRetrieveOutcome(entry.ragResult, payload)
  }));
  const hits = outcomes.filter((entry) => entry.outcome.hit);
  const requiredSuccessCount = 1;
  const selected = hits[0] ?? outcomes[outcomes.length - 1] ?? {
    ragResult: null,
    outcome: classifyRetrieveOutcome(null, payload)
  };
  const fallbackReasons = [
    ...new Set(outcomes.map((entry) => entry.outcome.fallback_reason).filter(Boolean))
  ];
  return {
    selected,
    attempt_count: outcomes.length,
    success_count: hits.length,
    required_success_count: requiredSuccessCount,
    timeout_count: outcomes.filter((entry) => entry.outcome.fallback_reason === "rag_retrieve_timeout").length,
    fallback_reasons: fallbackReasons,
    passed: hits.length >= requiredSuccessCount
  };
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

  const attemptCount = resolvePreflightAttemptCount(config, options);
  const attempts = [];
  for (let index = 0; index < attemptCount; index += 1) {
    let ragResult;
    try {
      ragResult = await retrieveFn(config, {
        ...payload,
        timeoutMs: runtimeTimeout
      });
    } catch {
      ragResult = { ok: false, reason: "request_failed", latencyMs: null };
    }

    attempts.push({ ragResult });
    const outcome = classifyRetrieveOutcome(ragResult, payload);
    if (outcome.hit || outcome.fallback_reason !== "rag_retrieve_timeout") {
      break;
    }
  }

  const summary = summarizeAttemptResults(attempts, payload);
  const { ragResult, outcome } = summary.selected;
  checks.rag_retrieve_ok = Boolean(ragResult?.ok);
  checks.rag_retrieve_parseable = ragResult != null && typeof ragResult === "object";
  checks.rag_retrieve_success_count = summary.success_count >= summary.required_success_count;
  if (!summary.passed) failures.push(outcome.failure ?? "rag_retrieve_failed");

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
    attempt_count: summary.attempt_count,
    success_count: summary.success_count,
    required_success_count: summary.required_success_count,
    timeout_count: summary.timeout_count,
    attempt_fallback_reasons: summary.fallback_reasons,
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
    `preflight_mode=raw_retrieve`,
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
    `attempt_count=${result?.attempt_count ?? 0}`,
    `success_count=${result?.success_count ?? 0}`,
    `required_success_count=${result?.required_success_count ?? 0}`,
    `timeout_count=${result?.timeout_count ?? 0}`,
    `attempt_fallback_reasons=${result?.attempt_fallback_reasons?.join(",") || "none"}`,
    `min_score=${result?.min_score ?? "none"}`,
    `failure_count=${result?.failures?.length ?? 0}`,
    `failures=${result?.failures?.join(",") || "none"}`
  ];
  return lines.join("\n");
}
