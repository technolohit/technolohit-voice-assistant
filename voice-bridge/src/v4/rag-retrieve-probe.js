/**
 * Shared Smart Website RAG retrieve probe helpers (preflight + diagnostics).
 * Never prints raw query, transcript, phone, email, or snippet text.
 */

import { loadAgentConfig } from "./agent-config.js";
import { buildV4RagQuery } from "./rag-orchestrator.js";
import { createCallSessionMemory, setSelectedProduct } from "./call-session-memory.js";
import { V4_STATES } from "./state-machine.js";

export const PROBE_PRODUCT_SCOPE = "smart_website";
const PROBE_QUERY = "Was ist Smart Website und was kostet sie?";
const EMAIL_IN_TEXT = /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/i;
const PHONE_IN_TEXT = /\b(\+?\d[\d\s\-()/]{5,}\d)\b/;

export function payloadContainsPrivateData(payload) {
  const serialized = JSON.stringify(payload ?? {});
  return EMAIL_IN_TEXT.test(serialized) || PHONE_IN_TEXT.test(serialized);
}

export function runtimeRetrieveTimeoutMs(config) {
  return Math.max(100, Number(config?.rag?.timeoutMs ?? 700));
}

export function diagnosticTimeoutBudgets(config) {
  const runtime = runtimeRetrieveTimeoutMs(config);
  const custom = Number(config?.rag?.retrieveDiagnosticTimeoutMs);
  const budgets = [runtime, 1200, 2000];
  if (Number.isFinite(custom) && custom >= 100 && !budgets.includes(custom)) {
    budgets.push(custom);
  }
  return [...new Set(budgets)].sort((a, b) => a - b);
}

export function buildSmartWebsiteRetrievePayload(config, options = {}) {
  const agentConfig = options.agentConfig ?? loadAgentConfig(config);
  const buildQuery = options.buildV4RagQueryFn ?? buildV4RagQuery;
  const memory = setSelectedProduct(
    createCallSessionMemory({ bridgeCallId: options.bridgeCallId ?? "rag-retrieve-probe" }),
    PROBE_PRODUCT_SCOPE
  );
  memory.current_product_context = PROBE_PRODUCT_SCOPE;
  const payload = buildQuery({
    config,
    agentConfig,
    transcript: PROBE_QUERY,
    memory,
    stateMachine: { state: V4_STATES.THINKING }
  });
  return { payload, agentConfig };
}

export function validateRetrievePayload(payload) {
  const failures = [];
  const checks = {
    payload_tenant_id: payload.tenant_id === "technolohit",
    payload_agent_id: payload.agent_id === "main_voice_sales",
    payload_product_scope: payload.context?.product_scope === PROBE_PRODUCT_SCOPE,
    payload_privacy_safe: !payloadContainsPrivateData(payload)
  };
  if (!checks.payload_tenant_id) failures.push("payload_tenant_id_not_technolohit");
  if (!checks.payload_agent_id) failures.push("payload_agent_id_not_main_voice_sales");
  if (!checks.payload_product_scope) failures.push("wrong_product_scope");
  if (!checks.payload_privacy_safe) failures.push("payload_contains_private_data");
  return { checks, failures };
}

export function classifyRetrieveOutcome(ragResult, payload = {}) {
  const minScore = Number(payload?.min_score ?? 0.72);
  const resultCount = Number(ragResult?.hitCount ?? ragResult?.data?.answer_context?.length ?? 0);
  const topScore = Number.isFinite(ragResult?.topScore) ? ragResult.topScore : null;

  if (!ragResult?.ok) {
    const reason = String(ragResult?.reason ?? "rag_unavailable");
    if (reason === "timeout") {
      return {
        hit: false,
        result_count: 0,
        top_score: null,
        fallback_reason: "rag_retrieve_timeout",
        failure: "rag_retrieve_timeout"
      };
    }
    if (reason === "rag_api_url_missing" || reason === "request_failed") {
      return {
        hit: false,
        result_count: 0,
        top_score: null,
        fallback_reason: "rag_unavailable",
        failure: "rag_unavailable"
      };
    }
    if (reason.startsWith("http_")) {
      return {
        hit: false,
        result_count: 0,
        top_score: null,
        fallback_reason: "rag_unavailable",
        failure: "rag_unavailable"
      };
    }
    return {
      hit: false,
      result_count: 0,
      top_score: null,
      fallback_reason: "rag_unavailable",
      failure: `rag_retrieve_${reason}`
    };
  }

  const hit = Boolean(ragResult.hit && resultCount > 0);
  if (!hit) {
    return {
      hit: false,
      result_count: resultCount,
      top_score: topScore,
      fallback_reason: "rag_miss",
      failure: "rag_miss"
    };
  }

  if (topScore != null && topScore < minScore) {
    return {
      hit: false,
      result_count: resultCount,
      top_score: topScore,
      fallback_reason: "low_score",
      failure: "low_score"
    };
  }

  return {
    hit: true,
    result_count: resultCount,
    top_score: topScore,
    fallback_reason: null,
    failure: null
  };
}

export function computeLatencyStats(latencies = []) {
  const values = latencies.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!values.length) {
    return { min: null, p50: null, p95: null, max: null };
  }
  const percentile = (p) => {
    const index = Math.ceil((p / 100) * values.length) - 1;
    return values[Math.max(0, Math.min(values.length - 1, index))];
  };
  return {
    min: values[0],
    p50: percentile(50),
    p95: percentile(95),
    max: values[values.length - 1]
  };
}

export function classifyDiagnosticsBudgets(budgetSummaries, runtimeTimeoutMs) {
  const runtime = budgetSummaries.find((entry) => entry.timeout_ms === runtimeTimeoutMs);
  const higher = budgetSummaries.filter((entry) => entry.timeout_ms > runtimeTimeoutMs);
  const anyHit = budgetSummaries.some((entry) => entry.hit_count > 0);
  const runtimeHits = runtime?.hit_count ?? 0;
  const higherHits = higher.some((entry) => entry.hit_count > 0);

  if (!anyHit) {
    const onlyTimeouts = budgetSummaries.every(
      (entry) => entry.timeout_count > 0 && entry.hit_count === 0
    );
    if (onlyTimeouts) {
      return { classification: "rag_retrieve_timeout", ok: false };
    }
    const onlyMiss = budgetSummaries.every(
      (entry) => entry.fallback_reasons.includes("rag_miss") && entry.hit_count === 0
    );
    if (onlyMiss) {
      return { classification: "rag_miss", ok: false };
    }
    return { classification: "rag_unavailable", ok: false };
  }

  if (runtimeHits === 0 && higherHits) {
    return { classification: "latency_budget_issue", ok: true };
  }

  return { classification: runtimeHits > 0 ? "ready" : "partial", ok: runtimeHits > 0 };
}
