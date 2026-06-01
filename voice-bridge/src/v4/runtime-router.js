/**
 * v4 runtime router — v3 default; prepares v4 runtime context when explicitly enabled.
 */

import { loadAgentConfig, getAgentVersionMetadata } from "./agent-config.js";
import { createCallSessionMemory } from "./call-session-memory.js";
import { createStateMachine, V4_STATES } from "./state-machine.js";
import { buildPersistMetadata } from "./persist-metadata.js";
import { buildCallStartedEvent } from "./quality-events.js";

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
      reason: "v4_realtime_stub_phase2"
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
    selected_runtime: route.runtime,
    v4_active: route.active,
    stub: route.stub,
    reason: route.reason
  };
}

export function createRuntimeContext(config, input = {}) {
  const route = resolveRuntimeRoute(config);
  const agentConfigResult = loadAgentConfig(config);
  const versionMeta = agentConfigResult.ok
    ? getAgentVersionMetadata(agentConfigResult.config)
    : {
        tenant_id: config?.v4?.tenantId ?? "technolohit",
        agent_id: config?.v4?.agentId ?? "main_voice_sales"
      };

  const memory = createCallSessionMemory({
    bridgeCallId: input.bridgeCallId ?? input.bridge_call_id ?? "pending",
    callSessionId: input.callSessionId ?? input.call_session_id ?? null,
    tenantId: versionMeta.tenant_id,
    agentId: versionMeta.agent_id,
    currentState: V4_STATES.GREETING
  });

  const stateMachine = createStateMachine(V4_STATES.GREETING);
  const persistMetadata = buildPersistMetadata(config, agentConfigResult.ok ? agentConfigResult : null);
  const qualityEventSeed = buildCallStartedEvent({
    config,
    agentConfigResult: agentConfigResult.ok ? agentConfigResult : null,
    callSessionId: memory.call_session_id,
    payload: {
      bridge_call_id: memory.bridge_call_id,
      runtime: route.runtime,
      stub: route.stub
    }
  });

  return {
    route,
    agentConfig: agentConfigResult,
    memory,
    stateMachine,
    persistMetadata,
    qualityEventSeed,
    phase: route.runtime === "v4" ? "v4_stub" : "v3_delegated"
  };
}

export function routeIncomingCallToRuntime(config, input = {}) {
  const route = resolveRuntimeRoute(config);
  if (route.runtime !== "v4" || !route.active) {
    return {
      handler: "v3",
      route,
      context: null
    };
  }
  return {
    handler: "v4",
    route,
    context: createRuntimeContext(config, input)
  };
}
