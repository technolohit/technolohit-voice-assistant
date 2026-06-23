/**
 * Phase 12E — live playbook provenance, spoken answer integrity, callback abandon.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { resolveBehaviorPolicy } from "../src/v4/behavior-policy.js";
import {
  PHASE12B_APPROVED_BINDING,
  PHASE12B_PLAYBOOK_VERSION,
} from "../src/v4/playbook-canary-artifact-validator.js";
import {
  createDialogueOrchestrator,
  startTurn,
  acceptUserTranscript,
  decideNextAction,
  commitAssistantPlanWithoutPlayback,
  prepareAssistantResponse,
} from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { createQualityEventSink } from "../src/v4/quality-event-sink.js";
import { enrichQualityEventForPersistence } from "../src/v4/quality-persistence.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { resolveCompanyAnswer } from "../src/v4/playbook-product-content.js";
import { prepareLiveAssistantSpeechText } from "../src/v4/live-tts-playback-endpoint.js";
import { COMBINED_LIVE_TTS_CHAR_LIMIT } from "../src/v4/playbook-short-answer.js";
import { describeLiveHandlerReadiness } from "../src/v4/runtime-router.js";
import { buildLeadCandidateFromMemory } from "../src/v4/lead-candidate.js";
import { assertNoRawPhoneInPayload } from "../src/v4/privacy-sanitize.js";
import { V4_STATES } from "../src/v4/state-machine.js";
import { CALLBACK_FLOW_STATES } from "../src/v4/callback-flow-policy.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_AGENT_PLAYBOOK_VERSION = "technolohit-sales-v4-20260601";

function boundCanaryConfig() {
  const base = loadConfig();
  return {
    ...base,
    v4: {
      ...base.v4,
      runtimeVersion: "v4",
      realtimeEnabled: true,
      canaryEnabled: true,
      liveAudioSocketEnabled: true,
      playbookRuntimeEnabled: true,
      playbookBindingPath: path.join(packageRoot, PHASE12B_APPROVED_BINDING),
      tenantId: "technolohit",
      agentId: "main_voice_sales",
      agentBehaviorDecisionEnabled: true,
    },
  };
}

function createBoundOrchestrator(config = boundCanaryConfig()) {
  const runtimeContext = createRuntimeContext(config, { bridgeCallId: "12e-bound" });
  const qualitySink = createQualityEventSink({ v4PathActive: true, insertFn: null });
  return createDialogueOrchestrator({
    config,
    runtimeContext,
    agentConfig: runtimeContext.agentConfig,
    memory: runtimeContext.memory,
    stateMachine: runtimeContext.stateMachine,
    qualitySink,
    v4PathActive: true,
  });
}

async function runOrchestratorTurn(orchestrator, transcript) {
  startTurn(orchestrator);
  acceptUserTranscript(orchestrator, transcript);
  const action = await decideNextAction(orchestrator, { transcript });
  const prepared = prepareAssistantResponse(orchestrator, action.plan);
  commitAssistantPlanWithoutPlayback(orchestrator, prepared.text, action.plan);
  return action;
}

function latestPlanEvent(orchestrator) {
  const events = orchestrator.qualitySink.getBufferedQualityEvents();
  return [...events].reverse().find((event) => event.eventType === "response_plan_created");
}

test("12E: bound live response_plan_created uses published playbook provenance", async () => {
  const config = boundCanaryConfig();
  const orchestrator = createBoundOrchestrator(config);
  await runOrchestratorTurn(orchestrator, "Was macht TechnoloHit?");

  const planEvent = latestPlanEvent(orchestrator);
  assert.ok(planEvent);
  assert.equal(planEvent.payload.playbook_version, PHASE12B_PLAYBOOK_VERSION);
  assert.equal(planEvent.payload.playbook_source, "approved_runtime_binding");
  assert.match(planEvent.payload.playbook_binding_version, /approved-20260622/);
  assert.equal(planEvent.payload.agent_config_playbook_version, LEGACY_AGENT_PLAYBOOK_VERSION);
  assert.notEqual(
    planEvent.payload.playbook_version,
    planEvent.payload.agent_config_playbook_version,
  );

  const enriched = enrichQualityEventForPersistence(planEvent, {
    persistMetadata: orchestrator.persistMetadata,
  });
  assert.equal(enriched.payload.playbook_version, PHASE12B_PLAYBOOK_VERSION);
  assert.equal(enriched.payload.agent_config_playbook_version, LEGACY_AGENT_PLAYBOOK_VERSION);
  assert.ok(assertNoRawPhoneInPayload(enriched.payload));
  assert.ok(!JSON.stringify(enriched.payload).includes("config/playbooks"));
});

test("12E: fail closed when runtime enabled but binding unresolved", () => {
  const config = boundCanaryConfig();
  config.v4.playbookBindingPath = "";
  const policy = resolveBehaviorPolicy({ config, v4PathActive: true });
  const orchestrator = createBoundOrchestrator(config);
  assert.equal(orchestrator.persistMetadata.playbook_version, null);
  assert.equal(orchestrator.persistMetadata.playbook_provenance_ok, false);
  assert.equal(policy.source, "hardcoded_default");
});

test("12E: company answer survives prepareLiveAssistantSpeechText without truncation", async () => {
  const config = boundCanaryConfig();
  const orchestrator = createBoundOrchestrator(config);
  const action = await runOrchestratorTurn(orchestrator, "Was macht TechnoloHit?");
  assert.equal(action.plan.response_type, RESPONSE_TYPES.COMPANY_GENERAL);

  const prepared = prepareLiveAssistantSpeechText(config, action.plan.text);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.usedFallback, false);
  assert.ok(prepared.text.length <= config.assistant.maxResponseChars);
  assert.ok(prepared.text.length <= COMBINED_LIVE_TTS_CHAR_LIMIT);
  assert.match(prepared.text, /TechnoloHit hilft Unternehmen/i);
  assert.match(prepared.text, /[.!?]$/);
  assert.doesNotMatch(prepared.text, /im Alltag Geht es/i);
  assert.doesNotMatch(prepared.text, /\.\.\.$/);
});

test("12E: published playbook company resolver prefers complete sentence within limit", () => {
  const config = boundCanaryConfig();
  const policy = resolveBehaviorPolicy({ config, v4PathActive: true });
  const answer = resolveCompanyAnswer(policy.playbook);
  assert.ok(answer);
  assert.ok(answer.length <= COMBINED_LIVE_TTS_CHAR_LIMIT);
  assert.match(answer, /[.!?]$/);
  const prepared = prepareLiveAssistantSpeechText(config, answer);
  assert.equal(prepared.text, answer);
});

test("12E: closing during callback stages abandons safely without lead or permission", async () => {
  const config = boundCanaryConfig();
  const stages = [
    {
      label: "collecting_contact_preference",
      memory: {
        current_state: V4_STATES.COLLECTING_CONTACT_PREFERENCE,
        contact_flow_pending: true,
        callback_flow_state: CALLBACK_FLOW_STATES.CONTACT_PREFERENCE_PENDING,
      },
      abandonStage: "collecting_contact_preference",
    },
    {
      label: "callback_permission_pending",
      memory: {
        current_state: V4_STATES.COLLECTING_CALLBACK_PERMISSION,
        contact_preference: "phone",
        contact_flow_pending: true,
        callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING,
      },
      abandonStage: "callback_permission_pending",
    },
    {
      label: "phone_number_pending",
      memory: {
        current_state: V4_STATES.COLLECTING_PHONE_NUMBER,
        contact_preference: "phone",
        contact_flow_pending: true,
        callback_flow_state: CALLBACK_FLOW_STATES.PHONE_NUMBER_PENDING,
      },
      abandonStage: "phone_number_pending",
    },
  ];

  for (const stage of stages) {
    const orchestrator = createBoundOrchestrator(config);
    orchestrator.memory = { ...orchestrator.memory, ...stage.memory };
    const action = await runOrchestratorTurn(orchestrator, "Danke, das reicht erstmal.");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.CLOSING, stage.label);
    assert.equal(action.plan.next_state, V4_STATES.COMPLETED, stage.label);
    assert.equal(action.plan.lead_transition_allowed, false, stage.label);

    const lead = buildLeadCandidateFromMemory(orchestrator.memory);
    assert.equal(lead.lead_ready, false, stage.label);
    assert.equal(lead.callback_ready, false, stage.label);
    assert.notEqual(lead.callback_permission, "granted", stage.label);

    const planEvent = latestPlanEvent(orchestrator);
    assert.equal(planEvent.payload.callback_flow_abandoned, true, stage.label);
    assert.equal(planEvent.payload.callback_abandon_stage, stage.abandonStage, stage.label);
    assert.equal(
      planEvent.payload.lead_skipped_reason,
      "caller_closed_before_callback_completion",
      stage.label,
    );
  }
});

test("12E: completed callback path still reaches validated callback behavior", async () => {
  const config = boundCanaryConfig();
  const orchestrator = createBoundOrchestrator(config);
  orchestrator.callerPhoneNormalized = "+4915112345678";

  await runOrchestratorTurn(orchestrator, "Bitte rufen Sie mich zurück.");
  await runOrchestratorTurn(orchestrator, "Telefonisch bitte.");
  const finalAction = await runOrchestratorTurn(orchestrator, "Ja.");

  assert.equal(finalAction.plan.response_type, RESPONSE_TYPES.CALLBACK_FINALIZED);
  const lead = buildLeadCandidateFromMemory(orchestrator.memory, {
    callerPhoneNormalized: orchestrator.callerPhoneNormalized,
  });
  assert.equal(lead.callback_permission, "granted");
  assert.equal(lead.callback_ready, true);
});

test("12E: startup readiness distinguishes legacy router from live per-call handler", () => {
  const config = boundCanaryConfig();
  const readiness = describeLiveHandlerReadiness(config);
  assert.equal(readiness.startup_router_mode, "legacy_startup_router");
  assert.equal(readiness.live_audiosocket_canary_configured, true);
  assert.equal(readiness.live_handler_selection, "per_call");
  assert.match(readiness.per_call_handler_evidence, /v4_live_canary_selected/);
  assert.equal(readiness.selected_runtime_active, false);
});

test("12E: default v3 and playbook runtime remain off without env overrides", () => {
  const previous = { ...process.env };
  try {
    delete process.env.VOICE_RUNTIME_VERSION;
    delete process.env.VOICE_V4_PLAYBOOK_RUNTIME_ENABLED;
    const config = loadConfig();
    assert.equal(config.v4.runtimeVersion, "v3");
    assert.equal(config.v4.playbookRuntimeEnabled, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("12E: planner closing path uses bound playbook not draft reload", () => {
  const config = boundCanaryConfig();
  const policy = resolveBehaviorPolicy({ config, v4PathActive: true });
  const plan = buildResponsePlan({
    agentConfig: loadAgentConfig(config),
    memory: {
      current_state: V4_STATES.COLLECTING_CONTACT_PREFERENCE,
      contact_flow_pending: true,
      callback_flow_state: CALLBACK_FLOW_STATES.CONTACT_PREFERENCE_PENDING,
    },
    stateMachine: { state: V4_STATES.COLLECTING_CONTACT_PREFERENCE },
    transcript: "Danke, das reicht erstmal.",
    config,
    behaviorPolicy: policy,
    v4PathActive: true,
  });
  assert.equal(plan.response_type, RESPONSE_TYPES.CLOSING);
  assert.equal(plan.callback_abandon?.callback_flow_abandoned, true);
  assert.equal(policy.playbook?.playbook_version, PHASE12B_PLAYBOOK_VERSION);
});
