/**
 * Non-live RAG retrieve diagnostics for Gate 3 readiness (timeout vs miss vs unavailable).
 * Safe output only — no raw query, transcript, phone, email, or snippet text.
 */

import { retrieveRagContext } from "../rag-client.js";
import {
  PROBE_PRODUCT_SCOPE,
  buildSmartWebsiteRetrievePayload,
  classifyDiagnosticsBudgets,
  classifyRetrieveOutcome,
  computeLatencyStats,
  diagnosticTimeoutBudgets,
  runtimeRetrieveTimeoutMs,
  validateRetrievePayload
} from "./rag-retrieve-probe.js";

export const DEFAULT_DIAGNOSTIC_ATTEMPTS = 5;

async function runBudgetAttempts(config, payload, retrieveFn, timeoutMs, attemptCount) {
  const attempts = [];
  for (let index = 0; index < attemptCount; index += 1) {
    let ragResult;
    try {
      ragResult = await retrieveFn(config, { ...payload, timeoutMs });
    } catch {
      ragResult = { ok: false, reason: "request_failed", latencyMs: null };
    }
    const outcome = classifyRetrieveOutcome(ragResult, payload);
    attempts.push({
      ok: Boolean(ragResult?.ok),
      hit: outcome.hit,
      result_count: outcome.result_count,
      top_score: outcome.top_score,
      latency_ms: ragResult?.latencyMs ?? null,
      fallback_reason: outcome.fallback_reason,
      failure: outcome.failure
    });
  }

  const latencies = attempts.map((entry) => entry.latency_ms).filter((value) => Number.isFinite(value));
  const latencyStats = computeLatencyStats(latencies);
  const resultCounts = attempts.map((entry) => entry.result_count);
  const topScores = attempts.map((entry) => entry.top_score).filter((value) => value != null);
  const fallbackReasons = [...new Set(attempts.map((entry) => entry.fallback_reason).filter(Boolean))];

  return {
    timeout_ms: timeoutMs,
    attempt_count: attemptCount,
    success_count: attempts.filter((entry) => entry.ok && entry.hit).length,
    timeout_count: attempts.filter((entry) => entry.fallback_reason === "rag_retrieve_timeout").length,
    hit_count: attempts.filter((entry) => entry.hit).length,
    result_count_min: resultCounts.length ? Math.min(...resultCounts) : 0,
    result_count_max: resultCounts.length ? Math.max(...resultCounts) : 0,
    latency_ms_min: latencyStats.min,
    latency_ms_p50: latencyStats.p50,
    latency_ms_p95: latencyStats.p95,
    latency_ms_max: latencyStats.max,
    top_score_max: topScores.length ? Math.max(...topScores) : null,
    fallback_reasons: fallbackReasons
  };
}

export async function runRagRetrieveDiagnostics(config, options = {}) {
  const retrieveFn = options.retrieveFn ?? retrieveRagContext;
  const attemptCount = Math.max(1, Number(options.attemptCount ?? DEFAULT_DIAGNOSTIC_ATTEMPTS));
  const runtimeTimeout = runtimeRetrieveTimeoutMs(config);
  const timeoutBudgets = options.timeoutBudgets ?? diagnosticTimeoutBudgets(config);

  let payload;
  try {
    ({ payload } = buildSmartWebsiteRetrievePayload(config, options));
  } catch (err) {
    return {
      ok: false,
      classification: "payload_invalid",
      attempt_count: 0,
      timeout_ms: runtimeTimeout,
      success_count: 0,
      timeout_count: 0,
      hit_count: 0,
      result_count_min: 0,
      result_count_max: 0,
      latency_ms_min: null,
      latency_ms_p50: null,
      latency_ms_p95: null,
      latency_ms_max: null,
      top_score_max: null,
      fallback_reasons: ["payload_invalid"],
      product_scope: PROBE_PRODUCT_SCOPE,
      payload_tenant_id: null,
      payload_agent_id: null,
      failure_count: 1,
      failures: [`payload_build_${String(err?.message ?? "failed").slice(0, 40)}`],
      budgets: []
    };
  }

  const payloadValidation = validateRetrievePayload(payload);
  if (payloadValidation.failures.length > 0) {
    const primaryFailure = payloadValidation.failures.includes("wrong_product_scope")
      ? "wrong_product_scope"
      : "payload_invalid";
    return {
      ok: false,
      classification: primaryFailure,
      attempt_count: 0,
      timeout_ms: runtimeTimeout,
      success_count: 0,
      timeout_count: 0,
      hit_count: 0,
      result_count_min: 0,
      result_count_max: 0,
      latency_ms_min: null,
      latency_ms_p50: null,
      latency_ms_p95: null,
      latency_ms_max: null,
      top_score_max: null,
      fallback_reasons: [primaryFailure],
      product_scope: PROBE_PRODUCT_SCOPE,
      payload_tenant_id: payload.tenant_id,
      payload_agent_id: payload.agent_id,
      failure_count: payloadValidation.failures.length,
      failures: payloadValidation.failures,
      budgets: []
    };
  }

  const budgets = [];
  for (const timeoutMs of timeoutBudgets) {
    budgets.push(await runBudgetAttempts(config, payload, retrieveFn, timeoutMs, attemptCount));
  }

  const runtimeSummary = budgets.find((entry) => entry.timeout_ms === runtimeTimeout) ?? budgets[0];
  const { classification, ok } = classifyDiagnosticsBudgets(budgets, runtimeTimeout);
  const allFallbackReasons = [...new Set(budgets.flatMap((entry) => entry.fallback_reasons))];
  const failures = [];
  if (!ok) {
    if (classification === "latency_budget_issue") {
      failures.push("latency_budget_issue");
    } else if (classification === "rag_miss") {
      failures.push("rag_miss");
    } else if (classification === "rag_retrieve_timeout") {
      failures.push("rag_retrieve_timeout");
    } else {
      failures.push(classification);
    }
  }

  return {
    ok,
    classification,
    attempt_count: runtimeSummary.attempt_count,
    timeout_ms: runtimeSummary.timeout_ms,
    success_count: runtimeSummary.success_count,
    timeout_count: runtimeSummary.timeout_count,
    hit_count: runtimeSummary.hit_count,
    result_count_min: runtimeSummary.result_count_min,
    result_count_max: runtimeSummary.result_count_max,
    latency_ms_min: runtimeSummary.latency_ms_min,
    latency_ms_p50: runtimeSummary.latency_ms_p50,
    latency_ms_p95: runtimeSummary.latency_ms_p95,
    latency_ms_max: runtimeSummary.latency_ms_max,
    top_score_max: runtimeSummary.top_score_max,
    fallback_reasons: allFallbackReasons,
    product_scope: PROBE_PRODUCT_SCOPE,
    payload_tenant_id: payload.tenant_id,
    payload_agent_id: payload.agent_id,
    failure_count: failures.length,
    failures,
    budgets
  };
}

export function formatRagRetrieveDiagnosticsLines(result) {
  const fallbackReasons = (result?.fallback_reasons ?? []).join(",") || "none";
  const lines = [
    `rag_retrieve_diagnostics=${result?.ok ? "pass" : "fail"}`,
    `classification=${result?.classification ?? "unknown"}`,
    `attempt_count=${result?.attempt_count ?? 0}`,
    `timeout_ms=${result?.timeout_ms ?? 0}`,
    `success_count=${result?.success_count ?? 0}`,
    `timeout_count=${result?.timeout_count ?? 0}`,
    `hit_count=${result?.hit_count ?? 0}`,
    `result_count_min=${result?.result_count_min ?? 0}`,
    `result_count_max=${result?.result_count_max ?? 0}`,
    `latency_ms_min=${result?.latency_ms_min ?? "none"}`,
    `latency_ms_p50=${result?.latency_ms_p50 ?? "none"}`,
    `latency_ms_p95=${result?.latency_ms_p95 ?? "none"}`,
    `latency_ms_max=${result?.latency_ms_max ?? "none"}`,
    `top_score_max=${result?.top_score_max ?? "none"}`,
    `fallback_reasons=${fallbackReasons}`,
    `product_scope=${result?.product_scope ?? PROBE_PRODUCT_SCOPE}`,
    `payload_tenant_id=${result?.payload_tenant_id ?? "none"}`,
    `payload_agent_id=${result?.payload_agent_id ?? "none"}`,
    `failure_count=${result?.failure_count ?? 0}`,
    `failures=${result?.failures?.join(",") || "none"}`
  ];

  for (const budget of result?.budgets ?? []) {
    lines.push(
      `budget_timeout_ms=${budget.timeout_ms}`,
      `budget_hit_count=${budget.hit_count}`,
      `budget_timeout_count=${budget.timeout_count}`,
      `budget_latency_ms_p50=${budget.latency_ms_p50 ?? "none"}`,
      `budget_fallback_reasons=${budget.fallback_reasons.join(",") || "none"}`
    );
  }

  return lines.join("\n");
}
