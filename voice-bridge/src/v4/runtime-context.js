/**
 * v4 runtime context assembly — shared by router and canary media skeleton.
 */

import { loadAgentConfig, getAgentVersionMetadata } from "./agent-config.js";
import { createCallSessionMemory } from "./call-session-memory.js";
import { createStateMachine, V4_STATES } from "./state-machine.js";
import { buildPersistMetadata } from "./persist-metadata.js";
import { buildCallStartedEvent } from "./quality-events.js";

export function createRuntimeContext(config, input = {}, route = null) {
  const resolvedRoute = route ?? {
    runtime: "v3",
    active: true,
    stub: false,
    reason: "default_v3"
  };

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
      runtime: resolvedRoute.runtime,
      stub: resolvedRoute.stub
    }
  });

  return {
    route: resolvedRoute,
    agentConfig: agentConfigResult,
    memory,
    stateMachine,
    persistMetadata,
    qualityEventSeed,
    phase: resolvedRoute.runtime === "v4" ? "v4_stub" : "v3_delegated"
  };
}
