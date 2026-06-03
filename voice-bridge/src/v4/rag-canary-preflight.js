/**
 * Hard, privacy-safe Gate 3 preflight for supervised v4 RAG-on canaries.
 */

import { checkRagApiHealth } from "../rag-client.js";

const REQUIRED_V4_GATES = [
  ["VOICE_RUNTIME_VERSION", (config) => config?.v4?.runtimeVersion === "v4", "v4"],
  ["VOICE_V4_REALTIME_ENABLED", (config) => config?.v4?.realtimeEnabled === true, "true"],
  ["VOICE_V4_CANARY_ENABLED", (config) => config?.v4?.canaryEnabled === true, "true"],
  ["VOICE_V4_LIVE_AUDIOSOCKET_ENABLED", (config) => config?.v4?.liveAudioSocketEnabled === true, "true"],
  ["VOICE_RAG_ENABLED", (config) => config?.rag?.enabled === true, "true"],
  ["VOICE_RAG_SALES_ANSWERER_ENABLED", (config) => config?.rag?.salesAnswererEnabled === true, "true"]
];

function safeBoolean(value) {
  return value ? "true" : "false";
}

export async function runRagCanaryPreflight(config, options = {}) {
  const failures = [];
  const checks = {};

  for (const [name, predicate, expected] of REQUIRED_V4_GATES) {
    const ok = Boolean(predicate(config));
    checks[name] = ok;
    if (!ok) failures.push(`${name}_expected_${expected}`);
  }

  const allowlistPresent = Boolean(String(config?.v4?.liveCanaryAllowlist ?? "").trim());
  checks.VOICE_V4_LIVE_CANARY_ALLOWLIST = allowlistPresent;
  if (!allowlistPresent) failures.push("VOICE_V4_LIVE_CANARY_ALLOWLIST_required");

  const apiUrlPresent = Boolean(String(config?.rag?.apiUrl ?? "").trim());
  checks.VOICE_RAG_API_URL = apiUrlPresent;
  if (!apiUrlPresent) failures.push("VOICE_RAG_API_URL_required");

  let health = { ok: false, reason: "not_checked", latencyMs: null };
  if (apiUrlPresent && failures.length === 0) {
    health = await checkRagApiHealth(config, {
      timeoutMs: config.rag.timeoutMs,
      fetchImpl: options.fetchImpl
    });
    if (!health.ok) failures.push(`rag_health_${health.reason ?? "failed"}`);
  }

  return {
    ok: failures.length === 0,
    checks,
    failures,
    ragHealthOk: Boolean(health.ok),
    ragHealthReason: health.reason ?? null,
    ragHealthLatencyMs: health.latencyMs ?? null
  };
}

export function formatRagCanaryPreflightLines(result) {
  const checks = result?.checks ?? {};
  return [
    `rag_canary_preflight=${result?.ok ? "pass" : "fail"}`,
    `runtime_v4=${safeBoolean(checks.VOICE_RUNTIME_VERSION)}`,
    `v4_realtime_enabled=${safeBoolean(checks.VOICE_V4_REALTIME_ENABLED)}`,
    `v4_canary_enabled=${safeBoolean(checks.VOICE_V4_CANARY_ENABLED)}`,
    `v4_live_audiosocket_enabled=${safeBoolean(checks.VOICE_V4_LIVE_AUDIOSOCKET_ENABLED)}`,
    `v4_live_canary_allowlist_present=${safeBoolean(checks.VOICE_V4_LIVE_CANARY_ALLOWLIST)}`,
    `rag_enabled=${safeBoolean(checks.VOICE_RAG_ENABLED)}`,
    `rag_sales_answerer_enabled=${safeBoolean(checks.VOICE_RAG_SALES_ANSWERER_ENABLED)}`,
    `rag_api_url_present=${safeBoolean(checks.VOICE_RAG_API_URL)}`,
    `rag_health_ok=${safeBoolean(result?.ragHealthOk)}`,
    `rag_health_reason=${result?.ragHealthReason ?? "none"}`,
    `rag_health_latency_ms=${result?.ragHealthLatencyMs ?? 0}`,
    `failure_count=${result?.failures?.length ?? 0}`,
    `failures=${result?.failures?.join(",") || "none"}`
  ].join("\n");
}
