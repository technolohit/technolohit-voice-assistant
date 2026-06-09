/**
 * Gate 3 live-path RAG preflight — exercises retrieveV4RagAnswer() like the live v4 canary.
 * Safe output only: no raw query, transcript, phone, email, or snippet text.
 */

import { retrieveRagContext } from "../rag-client.js";
import { loadAgentConfig } from "./agent-config.js";
import { retrieveV4RagAnswer, buildV4RagQuery } from "./rag-orchestrator.js";
import { runRagCanaryPreflight } from "./rag-canary-preflight.js";
import {
  PROBE_PRODUCT_SCOPE,
  buildLiveGate3RagProbeContext,
  runtimeRetrieveMaxAttempts,
  runtimeRetrieveTimeoutMs,
} from "./rag-retrieve-probe.js";

function safeBoolean(value) {
  return value ? "true" : "false";
}

function validateLiveRagResult(ragResult, payload) {
  const failures = [];
  const minScore = Number(payload?.min_score ?? 0.72);

  if (ragResult?.blocked) {
    failures.push(`rag_blocked_${ragResult.block_reason ?? "unknown"}`);
    return { failures, ok: false };
  }
  if (!ragResult?.used_rag) {
    failures.push(ragResult?.fallback_reason ?? "live_rag_not_used");
    return { failures, ok: false };
  }
  if (ragResult?.fallback_reason) {
    failures.push(String(ragResult.fallback_reason));
  }
  if (ragResult?.rag_product_scope !== PROBE_PRODUCT_SCOPE) {
    failures.push("wrong_product_scope");
  }
  if (!(Number(ragResult?.result_count) > 0)) {
    failures.push("result_count_zero");
  }
  if (ragResult?.top_score == null) {
    failures.push("top_score_missing");
  } else if (ragResult.top_score < minScore) {
    failures.push("low_score");
  }

  return { failures, ok: failures.length === 0 };
}

export async function runRagLivePathPreflight(config, options = {}) {
  const retrieveFn = options.retrieveFn ?? retrieveRagContext;
  const agentConfig = options.agentConfig ?? loadAgentConfig(config);
  const canary = options.skipCanary
    ? { ok: true, checks: {}, failures: [], ragHealthOk: true }
    : await runRagCanaryPreflight(config, { fetchImpl: options.fetchImpl });

  const failures = [...(canary.failures ?? [])];
  const checks = { ...(canary.checks ?? {}) };
  const runtimeTimeout = runtimeRetrieveTimeoutMs(config);
  const maxAttempts = runtimeRetrieveMaxAttempts(config);
  const probeContext = buildLiveGate3RagProbeContext(options);

  if (!canary.ok) {
    return {
      ok: false,
      checks,
      failures,
      canary,
      live: null,
      product_scope: PROBE_PRODUCT_SCOPE,
      used_rag: false,
      result_count: 0,
      fallback_reason: "canary_preflight_failed",
      timeout_ms: runtimeTimeout,
      max_attempts: maxAttempts,
      normalized_query_type: "combined_product_inquiry",
      query_chars: probeContext.transcript.length,
    };
  }

  let payload;
  try {
    payload = buildV4RagQuery({
      config,
      agentConfig,
      transcript: probeContext.transcript,
      memory: probeContext.memory,
      stateMachine: probeContext.stateMachine,
    });
  } catch (err) {
    failures.push(`rag_payload_build_${String(err?.message ?? "failed").slice(0, 40)}`);
    return {
      ok: false,
      checks,
      failures,
      canary,
      live: null,
      product_scope: PROBE_PRODUCT_SCOPE,
      used_rag: false,
      result_count: 0,
      fallback_reason: "payload_invalid",
      timeout_ms: runtimeTimeout,
      max_attempts: maxAttempts,
      normalized_query_type: "combined_product_inquiry",
      query_chars: probeContext.transcript.length,
    };
  }

  const ragResult = await retrieveV4RagAnswer({
    config,
    agentConfig,
    transcript: probeContext.transcript,
    memory: probeContext.memory,
    stateMachine: probeContext.stateMachine,
    retrieveFn,
  });

  const validation = validateLiveRagResult(ragResult, payload);
  checks.live_rag_used = Boolean(ragResult?.used_rag);
  checks.live_product_scope = ragResult?.rag_product_scope === PROBE_PRODUCT_SCOPE;
  checks.live_result_count = Number(ragResult?.result_count) > 0;
  checks.live_top_score = ragResult?.top_score == null || ragResult.top_score >= Number(payload?.min_score ?? 0.72);
  if (!validation.ok) failures.push(...validation.failures);

  return {
    ok: failures.length === 0,
    checks,
    failures,
    canary,
    live: ragResult,
    product_scope: ragResult?.rag_product_scope ?? PROBE_PRODUCT_SCOPE,
    used_rag: Boolean(ragResult?.used_rag),
    result_count: Number(ragResult?.result_count ?? 0),
    hit: Boolean(ragResult?.used_rag && Number(ragResult?.result_count) > 0),
    top_score: ragResult?.top_score ?? null,
    top_score_before_filter: ragResult?.top_score_before_filter ?? null,
    top_score_after_filter: ragResult?.top_score_after_filter ?? null,
    raw_result_count_before_voice_filter: ragResult?.raw_result_count_before_voice_filter ?? null,
    result_count_after_product_filter: ragResult?.result_count_after_product_filter ?? null,
    fallback_reason: ragResult?.fallback_reason ?? null,
    payload_tenant_id: ragResult?.payload_tenant_id ?? payload?.tenant_id ?? null,
    payload_agent_id: ragResult?.payload_agent_id ?? payload?.agent_id ?? null,
    min_score: payload?.min_score ?? null,
    timeout_ms: runtimeTimeout,
    max_attempts: maxAttempts,
    rag_attempt_count: ragResult?.rag_attempt_count ?? null,
    rag_timeout_count: ragResult?.rag_timeout_count ?? null,
    rag_success_count: ragResult?.rag_success_count ?? null,
    rag_attempt_fallback_reasons: ragResult?.rag_attempt_fallback_reasons ?? [],
    normalized_query_type: "combined_product_inquiry",
    query_chars: probeContext.transcript.length,
  };
}

export function formatRagLivePathPreflightLines(result) {
  const lines = [
    `rag_live_path_preflight=${result?.ok ? "pass" : "fail"}`,
    `used_rag=${safeBoolean(result?.used_rag)}`,
    `product_scope=${result?.product_scope ?? PROBE_PRODUCT_SCOPE}`,
    `result_count=${result?.result_count ?? 0}`,
    `hit=${safeBoolean(result?.hit)}`,
    `top_score=${result?.top_score ?? "none"}`,
    `top_score_before_filter=${result?.top_score_before_filter ?? "none"}`,
    `top_score_after_filter=${result?.top_score_after_filter ?? "none"}`,
    `raw_result_count_before_voice_filter=${result?.raw_result_count_before_voice_filter ?? 0}`,
    `result_count_after_product_filter=${result?.result_count_after_product_filter ?? 0}`,
    `fallback_reason=${result?.fallback_reason ?? "none"}`,
    `normalized_query_type=${result?.normalized_query_type ?? "none"}`,
    `query_chars=${result?.query_chars ?? 0}`,
    `payload_tenant_id=${result?.payload_tenant_id ?? "none"}`,
    `payload_agent_id=${result?.payload_agent_id ?? "none"}`,
    `timeout_ms=${result?.timeout_ms ?? 0}`,
    `max_attempts=${result?.max_attempts ?? 0}`,
    `rag_attempt_count=${result?.rag_attempt_count ?? 0}`,
    `rag_timeout_count=${result?.rag_timeout_count ?? 0}`,
    `rag_success_count=${result?.rag_success_count ?? 0}`,
    `rag_attempt_fallback_reasons=${result?.rag_attempt_fallback_reasons?.join(",") || "none"}`,
    `min_score=${result?.min_score ?? "none"}`,
    `failure_count=${result?.failures?.length ?? 0}`,
    `failures=${result?.failures?.join(",") || "none"}`,
  ];
  return lines.join("\n");
}
