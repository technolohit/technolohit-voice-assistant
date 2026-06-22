/**
 * Privacy-safe Phase 12A playbook canary readiness preflight.
 */

import {
  isV4CanaryPathActive,
  loadPlaybookRuntimeBinding,
} from "./playbook-runtime-binding.js";

function bool(value) {
  return value ? "true" : "false";
}

export function runPlaybookCanaryPreflight(config, { testOnlyRoots } = {}) {
  const failures = [];
  const checks = {
    runtime_v4: config?.v4?.runtimeVersion === "v4",
    v4_realtime_enabled: config?.v4?.realtimeEnabled === true,
    v4_canary_enabled: config?.v4?.canaryEnabled === true,
    v4_live_audiosocket_enabled: config?.v4?.liveAudioSocketEnabled === true,
    playbook_runtime_enabled: config?.v4?.playbookRuntimeEnabled === true,
    binding_path_present: Boolean(String(config?.v4?.playbookBindingPath ?? "").trim()),
  };
  for (const [key, ok] of Object.entries(checks)) {
    if (!ok) failures.push(`${key}_required`);
  }

  let bindingResult = { ok: false, reason: "not_checked" };
  if (
    isV4CanaryPathActive(config) &&
    checks.playbook_runtime_enabled &&
    checks.binding_path_present
  ) {
    bindingResult = loadPlaybookRuntimeBinding({
      bindingPath: config.v4.playbookBindingPath,
      tenantId: config.v4.tenantId,
      agentId: config.v4.agentId,
      testOnlyRoots,
    });
    if (!bindingResult.ok) failures.push(bindingResult.reason ?? "binding_load_failed");
  }

  return {
    ok: failures.length === 0 && bindingResult.ok,
    checks,
    failures,
    bindingOk: bindingResult.ok,
    bindingReason: bindingResult.reason ?? "unknown",
    bindingVersion: bindingResult.bindingVersion ?? "none",
    playbookVersion: bindingResult.playbookVersion ?? "none",
    checksumVerified: bindingResult.ok,
  };
}

export function formatPlaybookCanaryPreflight(result) {
  const checks = result?.checks ?? {};
  return [
    `playbook_canary_preflight=${result?.ok ? "pass" : "fail"}`,
    `runtime_v4=${bool(checks.runtime_v4)}`,
    `v4_realtime_enabled=${bool(checks.v4_realtime_enabled)}`,
    `v4_canary_enabled=${bool(checks.v4_canary_enabled)}`,
    `v4_live_audiosocket_enabled=${bool(checks.v4_live_audiosocket_enabled)}`,
    `playbook_runtime_enabled=${bool(checks.playbook_runtime_enabled)}`,
    `binding_path_present=${bool(checks.binding_path_present)}`,
    `binding_valid=${bool(result?.bindingOk)}`,
    `binding_reason=${result?.bindingReason ?? "unknown"}`,
    `binding_version=${result?.bindingVersion ?? "none"}`,
    `playbook_version=${result?.playbookVersion ?? "none"}`,
    `checksum_verified=${bool(result?.checksumVerified)}`,
    `failure_count=${result?.failures?.length ?? 0}`,
    `failures=${result?.failures?.join(",") || "none"}`,
  ].join("\n");
}

export function assertPlaybookCanaryPreflightOutputIsSafe(output) {
  if (
    /[\\/](?:app|opt|home|users|config)[\\/]/i.test(output) ||
    /@|(?:sk-|AKIA)[A-Za-z0-9]+/i.test(output)
  ) {
    throw new Error("playbook_canary_preflight_output_unsafe");
  }
}
