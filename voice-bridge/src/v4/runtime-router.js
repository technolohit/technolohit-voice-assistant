/**
 * v4 runtime router — selects v3 vs v4 without activating realtime audio in Phase 1.
 */

export function resolveRuntimeRoute(config) {
  const runtimeVersion = String(config?.v4?.runtimeVersion ?? "v3")
    .trim()
    .toLowerCase();
  const v4RealtimeEnabled = Boolean(config?.v4?.realtimeEnabled);

  if (runtimeVersion === "v4" && v4RealtimeEnabled) {
    return {
      runtime: "v4",
      active: false,
      stub: true,
      reason: "v4_realtime_not_implemented_phase1"
    };
  }

  if (runtimeVersion === "v4" && !v4RealtimeEnabled) {
    return {
      runtime: "v3",
      active: true,
      stub: false,
      reason: "v4_requested_but_realtime_disabled"
    };
  }

  return {
    runtime: "v3",
    active: true,
    stub: false,
    reason: "default_v3"
  };
}

export function isV4RuntimeRequested(config) {
  return String(config?.v4?.runtimeVersion ?? "v3")
    .trim()
    .toLowerCase() === "v4";
}

export function isV4RuntimeActive(config) {
  const route = resolveRuntimeRoute(config);
  return route.runtime === "v4" && route.active === true;
}

export function describeRuntimeRoute(config) {
  const route = resolveRuntimeRoute(config);
  return {
    runtime_version_env: String(config?.v4?.runtimeVersion ?? "v3"),
    v4_realtime_enabled: Boolean(config?.v4?.realtimeEnabled),
    selected_runtime: route.runtime,
    v4_active: route.active,
    stub: route.stub,
    reason: route.reason
  };
}
