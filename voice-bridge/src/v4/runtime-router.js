/**
 * v4 runtime router — v3 default; prepares v4 runtime context when explicitly enabled.
 */

import { createRuntimeContext } from "./runtime-context.js";
import {
  canPrepareV4CanaryMedia,
  canPrepareV4BargeIn,
  routeAudioSocketCall,
  createBargeInRuntimeContext
} from "./audiosocket-runtime.js";

export { createRuntimeContext };

export function resolveRuntimeRoute(config) {
  const runtimeVersion = String(config?.v4?.runtimeVersion ?? "v3")
    .trim()
    .toLowerCase();
  const v4RealtimeEnabled = Boolean(config?.v4?.realtimeEnabled);
  const canaryEnabled = Boolean(config?.v4?.canaryEnabled);
  const bargeInEnabled = Boolean(config?.v4?.bargeInEnabled);

  if (runtimeVersion === "v4" && v4RealtimeEnabled) {
    if (!canaryEnabled) {
      return {
        runtime: "v4",
        active: false,
        stub: true,
        canaryReady: false,
        bargeInReady: false,
        reason: "v4_canary_disabled"
      };
    }
    if (bargeInEnabled) {
      return {
        runtime: "v4",
        active: false,
        stub: true,
        canaryReady: true,
        bargeInReady: true,
        reason: "v4_canary_barge_in_stub_phase4"
      };
    }
    return {
      runtime: "v4",
      active: false,
      stub: true,
      canaryReady: true,
      bargeInReady: false,
      reason: "v4_canary_media_stub_phase3"
    };
  }

  if (runtimeVersion === "v4" && !v4RealtimeEnabled) {
    return {
      runtime: "v3",
      active: true,
      stub: false,
      canaryReady: false,
      bargeInReady: false,
      reason: "v4_requested_but_realtime_disabled"
    };
  }

  return {
    runtime: "v3",
    active: true,
    stub: false,
    canaryReady: false,
    bargeInReady: false,
    reason: "default_v3"
  };
}

export function shouldUseV4Runtime(config) {
  const route = resolveRuntimeRoute(config);
  return route.runtime === "v4" && route.active === true;
}

export function isV4RuntimeRequested(config) {
  return String(config?.v4?.runtimeVersion ?? "v3")
    .trim()
    .toLowerCase() === "v4";
}

export function isV4RuntimeActive(config) {
  return shouldUseV4Runtime(config);
}

export function describeRuntimeRoute(config) {
  const route = resolveRuntimeRoute(config);
  return {
    runtime_version_env: String(config?.v4?.runtimeVersion ?? "v3"),
    v4_realtime_enabled: Boolean(config?.v4?.realtimeEnabled),
    v4_canary_enabled: Boolean(config?.v4?.canaryEnabled),
    v4_barge_in_enabled: Boolean(config?.v4?.bargeInEnabled),
    selected_runtime: route.runtime,
    v4_active: route.active,
    stub: route.stub,
    canary_ready: Boolean(route.canaryReady),
    barge_in_ready: Boolean(route.bargeInReady),
    reason: route.reason
  };
}

export function routeIncomingCallToRuntime(config, input = {}) {
  const route = resolveRuntimeRoute(config);
  if (route.runtime !== "v4" || !route.active) {
    return {
      handler: "v3",
      route,
      context: null,
      canaryReady: Boolean(route.canaryReady),
      bargeInReady: Boolean(route.bargeInReady)
    };
  }
  return {
    handler: "v4",
    route,
    context: createRuntimeContext(config, input, route)
  };
}

export function routeBargeInTestContext(config, input = {}) {
  if (!canPrepareV4BargeIn(config)) {
    return {
      handler: "v3",
      active: false,
      dropCall: false,
      context: null,
      reason: "v4_barge_in_not_available"
    };
  }
  if (!input.harnessExplicit) {
    return {
      handler: "v3",
      active: false,
      dropCall: false,
      context: null,
      reason: "barge_in_harness_required"
    };
  }
  const context = createBargeInRuntimeContext(config, input);
  return {
    handler: context.ok ? "v4_canary_barge_in_stub" : "v3",
    active: false,
    dropCall: false,
    context,
    reason: context.reason
  };
}

export { canPrepareV4CanaryMedia, canPrepareV4BargeIn, routeAudioSocketCall, createBargeInRuntimeContext };
