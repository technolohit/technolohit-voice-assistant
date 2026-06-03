/**
 * v4 dialogue orchestrator — canary/test-harness turn lifecycle (Phase 5).
 * Connects memory, state machine, response planner, barge-in, quality sink.
 */

import { createAudioSession, closeAudioSession, markPlaybackStarted } from "./audio-session.js";
import {
  updateMemoryFromUserTurn,
  updateMemoryFromAssistantTurn,
  setSelectedProduct,
  setContactPreference
} from "./call-session-memory.js";
import {
  V4_STATES,
  transitionState,
  validateStateTransition
} from "./state-machine.js";
import {
  validateCallbackReadyLead,
  validateLeadReadyTransition,
  ragAnswerMustNotCreateLead
} from "./lead-validator.js";
import {
  buildResponsePlan,
  applyMemoryPatch,
  detectTranscriptIntent,
  sanitizeResponseText
} from "./response-planner.js";
import {
  shouldUseRagForTurn,
  retrieveV4RagAnswer
} from "./rag-orchestrator.js";
import {
  resolveClosedDomainIntent,
  closedDomainQualityPayload
} from "./closed-domain-intent.js";
import { planContextQualityPayload } from "./product-context-persistence.js";
import { resolveRagProductScope } from "./rag-product-scope.js";
import {
  resolveInterruptionRecovery,
  captureInterruptedAssistantState
} from "./interruption-context.js";
import {
  buildCallStartedEvent,
  buildTurnStartedEvent,
  buildQualityEventInput
} from "./quality-events.js";
import { finalizeV4PostCallHandoff } from "./post-call-bridge.js";
import { buildLeadCandidateFromMemory } from "./lead-candidate.js";
import { createQualityEventSink } from "./quality-event-sink.js";
import {
  createPlaybackController,
  startPlayback,
  requestPlaybackCancel,
  finalizePlayback
} from "./playback-controller.js";

function bufferEvent(orchestrator, eventType, payload = {}, metricValue = null) {
  const event = buildQualityEventInput({
    config: orchestrator.config,
    agentConfigResult: orchestrator.agentConfig,
    callSessionId: orchestrator.memory?.call_session_id,
    eventType,
    payload: {
      bridge_call_id: orchestrator.memory?.bridge_call_id,
      turn_index: orchestrator.turnIndex,
      ...payload
    },
    metricValue
  });
  orchestrator.qualitySink.bufferQualityEvent(event);
  return event;
}

export function createDialogueOrchestrator({
  config,
  runtimeContext,
  audioSession = null,
  memory = null,
  stateMachine = null,
  agentConfig = null,
  adapters = {},
  qualitySink = null,
  v4PathActive = false,
  callerPhoneNormalized = null,
  callerPhoneRaw = null
} = {}) {
  return {
    phase: "phase5_dialogue_orchestrator",
    config,
    runtimeContext,
    memory: memory ?? runtimeContext?.memory ?? null,
    stateMachine: stateMachine ?? runtimeContext?.stateMachine ?? null,
    audioSession,
    agentConfig: agentConfig ?? runtimeContext?.agentConfig ?? null,
    adapters: {
      stt: adapters.stt ?? null,
      tts: adapters.tts ?? null,
      ragAnswerer: adapters.ragAnswerer ?? null,
      ragRetriever: adapters.ragRetriever ?? null
    },
    qualitySink: qualitySink ?? createQualityEventSink({ v4PathActive }),
    v4PathActive: Boolean(v4PathActive),
    turnIndex: 0,
    currentTurn: null,
    lastPlan: null,
    lastAssistantText: null,
    leadCandidate: null,
    postCallHandoff: null,
    callerPhoneNormalized: callerPhoneNormalized ?? null,
    callerPhoneRaw: callerPhoneRaw ?? null,
    playback: null,
    status: "created"
  };
}

export function startCall(orchestrator, input = {}) {
  const greetingPlan = buildResponsePlan({
    agentConfig: orchestrator.agentConfig,
    memory: orchestrator.memory,
    stateMachine: orchestrator.stateMachine,
    transcript: "",
    intent: "greeting"
  });

  let memory = orchestrator.memory;
  let stateMachine = orchestrator.stateMachine;

  memory = applyMemoryPatch(memory, greetingPlan.memory_patch);
  memory = updateMemoryFromAssistantTurn(memory, greetingPlan.text);
  stateMachine = transitionState(stateMachine, V4_STATES.GREETING, "call_start");
  stateMachine = transitionState(stateMachine, greetingPlan.next_state, "greeting_complete");

  if (!orchestrator.audioSession) {
    orchestrator.audioSession = createAudioSession({
      bridgeCallId: memory.bridge_call_id,
      callSessionId: memory.call_session_id,
      memory,
      stateMachine
    });
  }

  bufferEvent(orchestrator, "call_started", { runtime: "v4_canary_stub" });
  bufferEvent(orchestrator, greetingPlan.quality_event_type, { response_type: greetingPlan.response_type });

  orchestrator.memory = memory;
  orchestrator.stateMachine = stateMachine;
  orchestrator.status = "active";
  orchestrator.lastPlan = greetingPlan;
  orchestrator.lastAssistantText = greetingPlan.text;

  return {
    ok: true,
    plan: greetingPlan,
    memory,
    stateMachine
  };
}

export function startTurn(orchestrator, input = {}) {
  orchestrator.turnIndex = Number(orchestrator.turnIndex ?? 0) + 1;
  orchestrator.currentTurn = {
    turnIndex: orchestrator.turnIndex,
    startedAt: Date.now(),
    transcript: null,
    plan: null,
    completed: false
  };

  let stateMachine = transitionState(
    orchestrator.stateMachine,
    V4_STATES.LISTENING,
    "turn_start"
  );
  orchestrator.stateMachine = stateMachine;
  orchestrator.memory = {
    ...orchestrator.memory,
    current_state: V4_STATES.LISTENING,
    updated_at: Date.now()
  };

  return { ok: true, turnIndex: orchestrator.turnIndex, stateMachine };
}

export function acceptUserTranscript(orchestrator, transcript = "") {
  let memory = updateMemoryFromUserTurn(orchestrator.memory, transcript);
  let stateMachine = transitionState(
    orchestrator.stateMachine,
    V4_STATES.TRANSCRIBING,
    "transcript_received"
  );
  stateMachine = transitionState(stateMachine, V4_STATES.THINKING, "transcript_accepted");

  memory = { ...memory, current_state: V4_STATES.THINKING };
  orchestrator.memory = memory;
  orchestrator.stateMachine = stateMachine;
  if (orchestrator.currentTurn) {
    orchestrator.currentTurn.transcript = transcript;
  }

  bufferEvent(orchestrator, "stt_completed", { chars: String(transcript).length });

  return {
    ok: true,
    memory,
    stateMachine,
    intent: detectTranscriptIntent(transcript, memory, orchestrator.agentConfig)
  };
}

export async function decideNextAction(orchestrator, input = {}) {
  const transcript = input.transcript ?? orchestrator.currentTurn?.transcript ?? "";
  const closedDomain =
    input.closedDomain ??
    resolveClosedDomainIntent({
      agentConfig: orchestrator.agentConfig,
      transcript,
      memory: orchestrator.memory
    });
  orchestrator.lastClosedDomain = closedDomain;

  bufferEvent(orchestrator, "turn_started", {
    turn_index: orchestrator.turnIndex,
    ...closedDomainQualityPayload(closedDomain, orchestrator.memory),
    interrupt_sequence_id:
      input.interrupt_sequence_id ?? orchestrator.activeInterruptSequenceId ?? null,
    effective_transcript_chars: String(transcript ?? "").length,
    waiting_for_interruption_followup: Boolean(input.waitingForInterruptionFollowup),
    interrupt_marker_detected: Boolean(input.interruptMarkerDetected),
    interrupt_followup_timeout: Boolean(input.interruptFollowupTimeout),
  });

  const intent =
    input.intent ??
    detectTranscriptIntent(transcript, orchestrator.memory, orchestrator.agentConfig);
  const interruptionRecovery = input.interruptionRecovery ?? null;

  const ragGate = shouldUseRagForTurn({
    config: orchestrator.config,
    state: orchestrator.stateMachine?.state,
    intent,
    memory: orchestrator.memory,
    transcript
  });

  const retrievalMemory =
    !resolveRagProductScope(orchestrator.memory) && closedDomain?.matched_product
      ? setSelectedProduct(orchestrator.memory, closedDomain.matched_product)
      : orchestrator.memory;
  let ragResult = input.ragResult ?? null;
  const ragProductScope = resolveRagProductScope(retrievalMemory);
  const ragEnabled = Boolean(orchestrator.config?.rag?.enabled);
  const ragSalesAnswererEnabled = Boolean(orchestrator.config?.rag?.salesAnswererEnabled);
  if (ragGate.allowed && !ragResult) {
    bufferEvent(orchestrator, "rag_retrieval_started", {
      rag_reason: ragGate.reason,
      rag_enabled: ragEnabled,
      rag_sales_answerer_enabled: ragSalesAnswererEnabled,
      rag_product_scope: ragProductScope,
      rag_fallback_used: false,
      tenant_id: orchestrator.config?.v4?.tenantId ?? "technolohit",
      agent_id: orchestrator.config?.v4?.agentId ?? "main_voice_sales"
    });

    if (typeof orchestrator.adapters.ragAnswerer === "function") {
      const legacy = orchestrator.adapters.ragAnswerer({
        query: transcript,
        productId: retrievalMemory.selected_product_id,
        memory: retrievalMemory
      });
      ragResult =
        typeof legacy?.then === "function"
          ? await legacy
          : {
              ok: true,
              answer: legacy?.answer ?? legacy,
              used_rag: Boolean(legacy?.used_rag),
              fallback_reason: legacy?.fallback_reason ?? null,
              creates_lead: false
            };
    } else {
      ragResult = await retrieveV4RagAnswer({
        config: orchestrator.config,
        agentConfig: orchestrator.agentConfig,
        transcript,
        memory: retrievalMemory,
        stateMachine: orchestrator.stateMachine,
        retrieveFn: orchestrator.adapters.ragRetriever ?? undefined
      });
    }

    bufferEvent(
      orchestrator,
      ragResult?.used_rag ? "rag_retrieval_completed" : "rag_retrieval_failed",
      {
        used_rag: Boolean(ragResult?.used_rag),
        rag_enabled: ragEnabled,
        rag_sales_answerer_enabled: ragSalesAnswererEnabled,
        rag_product_scope: ragResult?.rag_product_scope ?? ragProductScope,
        rag_result_count: Number(ragResult?.result_count ?? ragResult?.evidence?.hit_count ?? 0),
        rag_fallback_used: !Boolean(ragResult?.used_rag),
        fallback_reason: ragResult?.fallback_reason ?? null,
        rag_reason: ragGate.reason
      },
      ragResult?.latency_ms ?? null
    );
  }

  const ragAnswer = ragResult?.answer ?? null;

  const plan = buildResponsePlan({
    agentConfig: orchestrator.agentConfig,
    memory: orchestrator.memory,
    stateMachine: orchestrator.stateMachine,
    transcript,
    intent,
    ragAnswer,
    ragGate,
    ragResult,
    interruptionRecovery,
    closedDomain,
    interruptFollowupTimeout: Boolean(input.interruptFollowupTimeout)
  });

  const ragGuard = ragAnswerMustNotCreateLead(Boolean(plan.rag_allowed));
  if (plan.lead_transition_allowed && ragGuard.createsLead === false && plan.rag_allowed) {
    plan.lead_transition_allowed = false;
  }

  plan.rag_enabled = ragEnabled;
  plan.rag_sales_answerer_enabled = ragSalesAnswererEnabled;
  plan.rag_product_scope = ragResult?.rag_product_scope ?? ragProductScope;
  plan.rag_used = Boolean(ragResult?.used_rag);
  plan.rag_fallback_used = Boolean(ragGate.allowed && !ragResult?.used_rag);

  orchestrator.lastPlan = plan;
  return { ok: true, plan, intent, ragResult, ragGate };
}

export function prepareAssistantResponse(orchestrator, plan = null) {
  const resolvedPlan = plan ?? orchestrator.lastPlan;
  if (!resolvedPlan) {
    return { ok: false, reason: "no_plan" };
  }

  let stateMachine = orchestrator.stateMachine;
  const validation = validateStateTransition(stateMachine.state, resolvedPlan.next_state, {
    createsLead: false,
    leadPolicy: { allowed: false, reason: "prepare_only" }
  });
  if (!validation.ok && resolvedPlan.next_state !== V4_STATES.ERROR) {
    stateMachine = transitionState(stateMachine, V4_STATES.LISTENING, "plan_transition_fallback");
  }

  orchestrator.lastAssistantText = sanitizeResponseText(resolvedPlan.text);
  return {
    ok: true,
    text: orchestrator.lastAssistantText,
    plan: resolvedPlan,
    stateMachine
  };
}

export function recordAssistantResponse(orchestrator, text = null, plan = null) {
  const resolvedPlan = plan ?? orchestrator.lastPlan;
  const responseText = sanitizeResponseText(text ?? resolvedPlan?.text ?? orchestrator.lastAssistantText ?? "");

  let memory = applyMemoryPatch(orchestrator.memory, resolvedPlan?.memory_patch ?? {});
  memory = updateMemoryFromAssistantTurn(memory, responseText);

  let stateMachine = orchestrator.stateMachine;
  if (resolvedPlan?.next_state) {
    const leadPolicy = resolvedPlan.lead_transition_allowed
      ? validateLeadReadyTransition(memory, {
          source: "dialogue_orchestrator",
          callerPhoneNormalized: orchestrator.callerPhoneNormalized,
          callerPhoneRaw: orchestrator.callerPhoneRaw,
          explicitUserPermission: true
        })
      : { allowed: false, reason: "lead_transition_not_requested" };

    if (resolvedPlan.next_state === V4_STATES.LEAD_READY) {
      if (!leadPolicy.allowed) {
        memory = { ...memory, lead_ready: false };
        stateMachine = transitionState(stateMachine, V4_STATES.VALIDATING_CONTACT, leadPolicy.reason);
      } else {
        memory = { ...memory, lead_ready: true, phone_present: true };
        stateMachine = transitionState(stateMachine, V4_STATES.LEAD_READY, "lead_ready", { leadPolicy });
      }
    } else {
      stateMachine = transitionState(stateMachine, resolvedPlan.next_state, "assistant_response", {
        createsLead: false,
        leadPolicy
      });
    }
    memory = { ...memory, current_state: stateMachine.state };
  }

  stateMachine = transitionState(stateMachine, V4_STATES.SPEAKING, "speaking");
  memory = { ...memory, current_state: V4_STATES.SPEAKING };

  orchestrator.playback = startPlayback(
    createPlaybackController({
      enabled: true,
      bridgeCallId: memory.bridge_call_id,
      turnIndex: orchestrator.turnIndex,
      label: resolvedPlan?.response_type ?? "assistant_response"
    }),
    Date.now()
  ).controller;

  if (orchestrator.audioSession) {
    orchestrator.audioSession = markPlaybackStarted(orchestrator.audioSession, Date.now());
  }

  bufferEvent(orchestrator, resolvedPlan?.quality_event_type ?? "tts_started", {
    response_type: resolvedPlan?.response_type
  });

  orchestrator.memory = memory;
  orchestrator.stateMachine = stateMachine;
  orchestrator.lastAssistantText = responseText;

  return { ok: true, memory, stateMachine, text: responseText, playback: orchestrator.playback };
}

/**
 * Apply assistant plan to memory/state without TTS or playback (Phase 10D live canary).
 */
export function commitAssistantPlanWithoutPlayback(orchestrator, text = null, plan = null) {
  const resolvedPlan = plan ?? orchestrator.lastPlan;
  const responseText = sanitizeResponseText(text ?? resolvedPlan?.text ?? orchestrator.lastAssistantText ?? "");
  const fromState = orchestrator.stateMachine?.state ?? orchestrator.memory?.current_state ?? null;

  let memory = applyMemoryPatch(orchestrator.memory, resolvedPlan?.memory_patch ?? {});
  memory = updateMemoryFromAssistantTurn(memory, responseText);

  let stateMachine = orchestrator.stateMachine;
  if (resolvedPlan?.next_state) {
    const leadPolicy = resolvedPlan.lead_transition_allowed
      ? validateLeadReadyTransition(memory, {
          source: "dialogue_orchestrator",
          callerPhoneNormalized: orchestrator.callerPhoneNormalized,
          callerPhoneRaw: orchestrator.callerPhoneRaw,
          explicitUserPermission: true
        })
      : { allowed: false, reason: "lead_transition_not_requested" };

    if (resolvedPlan.next_state === V4_STATES.LEAD_READY) {
      if (!leadPolicy.allowed) {
        memory = { ...memory, lead_ready: false };
        stateMachine = transitionState(stateMachine, V4_STATES.VALIDATING_CONTACT, leadPolicy.reason);
      } else {
        memory = { ...memory, lead_ready: true, phone_present: true };
        stateMachine = transitionState(stateMachine, V4_STATES.LEAD_READY, "lead_ready", { leadPolicy });
      }
    } else {
      stateMachine = transitionState(stateMachine, resolvedPlan.next_state, "assistant_plan", {
        createsLead: false,
        leadPolicy
      });
    }
    memory = { ...memory, current_state: stateMachine.state };
  }

  const toState = stateMachine.state;
  if (fromState && toState && fromState !== toState) {
    bufferEvent(orchestrator, "dialogue_state_transition", {
      from_state: fromState,
      to_state: toState,
      response_type: resolvedPlan?.response_type ?? null
    });
  }

  bufferEvent(orchestrator, "response_plan_created", {
    response_type: resolvedPlan?.response_type ?? null,
    response_chars: responseText.length,
    intent: resolvedPlan?.intent ?? null,
    next_state: toState,
    ...planContextQualityPayload(
      memory,
      orchestrator.lastClosedDomain,
      resolvedPlan,
      { activeInterruptSequenceId: orchestrator.activeInterruptSequenceId },
    ),
  });

  orchestrator.activeInterruptSequenceId = null;

  orchestrator.memory = memory;
  orchestrator.stateMachine = stateMachine;
  orchestrator.lastAssistantText = responseText;
  orchestrator.playback = null;

  return { ok: true, memory, stateMachine, text: responseText, playback: null };
}

export async function handleInterruption(orchestrator, { callerText = "", playback = null, atMs = Date.now() } = {}) {
  const activePlayback = playback ?? orchestrator.playback;
  const cancelled = requestPlaybackCancel(activePlayback, "barge_in", atMs);
  orchestrator.playback = finalizePlayback(cancelled.controller, "cancelled", atMs).controller;

  const interruptionContext = captureInterruptedAssistantState({
    memory: orchestrator.memory,
    stateMachine: orchestrator.stateMachine,
    playback: orchestrator.playback,
    assistantText: orchestrator.lastAssistantText,
    turnIndex: orchestrator.turnIndex
  });

  const recovery = resolveInterruptionRecovery({
    agentConfig: orchestrator.agentConfig,
    memory: orchestrator.memory,
    stateMachine: orchestrator.stateMachine,
    context: interruptionContext,
    callerText
  });

  orchestrator.memory = recovery.memory;
  orchestrator.stateMachine = recovery.stateMachine;

  bufferEvent(orchestrator, "barge_in_detected", {
    recovery_action: recovery.recoveryAction,
    detected_product_id: recovery.context.detected_product_id
  });
  bufferEvent(orchestrator, "interruption_context_captured", {
    recovery_action: recovery.recoveryAction,
    topic_switch_detected: recovery.context.topic_switch_detected
  });

  if (recovery.recoveryAction === "product_switch") {
    bufferEvent(orchestrator, "topic_switch_detected", {
      from_product: interruptionContext.interrupted_product_id,
      to_product: recovery.memory.selected_product_id
    });
  }

  const action = await decideNextAction(orchestrator, {
    transcript: callerText,
    interruptionRecovery: recovery
  });

  return {
    ok: true,
    recovery,
    plan: action.plan,
    memory: orchestrator.memory,
    stateMachine: orchestrator.stateMachine
  };
}

export function tryLeadReadyTransition(orchestrator, options = {}) {
  const candidate = buildLeadCandidateFromMemory(orchestrator.memory, {
    source: options.source ?? "dialogue_orchestrator",
    callerPhoneNormalized: options.callerPhoneNormalized ?? orchestrator.callerPhoneNormalized,
    callerPhoneRaw: options.callerPhoneRaw ?? orchestrator.callerPhoneRaw,
    spokenPhone: options.spokenPhone,
    explicitUserPermission: options.explicitUserPermission ?? true,
    llmGrantedPermission: options.llmGrantedPermission ?? false
  });
  orchestrator.leadCandidate = candidate;

  const validation = candidate.validation ?? validateCallbackReadyLead(orchestrator.memory, options);

  if (!validation.allowed) {
    orchestrator.memory = { ...orchestrator.memory, lead_ready: false };
    return { ok: false, validation, memory: orchestrator.memory };
  }

  const transition = validateStateTransition(
    orchestrator.stateMachine.state,
    V4_STATES.LEAD_READY,
    { leadPolicy: validation }
  );
  if (!transition.ok) {
    orchestrator.stateMachine = transitionState(
      orchestrator.stateMachine,
      V4_STATES.VALIDATING_CONTACT,
      "lead_validation"
    );
  }

  const retryTransition = validateStateTransition(
    orchestrator.stateMachine.state,
    V4_STATES.LEAD_READY,
    { leadPolicy: validation }
  );
  if (!retryTransition.ok) {
    return { ok: false, validation, transition: retryTransition, memory: orchestrator.memory };
  }

  orchestrator.stateMachine = transitionState(
    orchestrator.stateMachine,
    V4_STATES.LEAD_READY,
    "lead_validated",
    { leadPolicy: validation }
  );
  orchestrator.memory = {
    ...orchestrator.memory,
    lead_ready: true,
    phone_present: true,
    current_state: V4_STATES.LEAD_READY
  };

  bufferEvent(orchestrator, "lead_created", { source: "dialogue_orchestrator" });
  return { ok: true, validation, memory: orchestrator.memory, stateMachine: orchestrator.stateMachine };
}

export function markLeadCandidate(orchestrator, patch = {}) {
  orchestrator.memory = applyMemoryPatch(orchestrator.memory, {
    ...patch,
    lead_ready: false,
    current_state: orchestrator.stateMachine?.state ?? V4_STATES.VALIDATING_CONTACT
  });
  orchestrator.leadCandidate = buildLeadCandidateFromMemory(orchestrator.memory, {
    source: "dialogue_orchestrator",
    callerPhoneNormalized: orchestrator.callerPhoneNormalized,
    callerPhoneRaw: orchestrator.callerPhoneRaw
  });
  bufferEvent(orchestrator, "lead_skipped", {
    reason: "needs_contact_validation",
    next_action: orchestrator.leadCandidate?.next_action ?? "manual_review"
  });
  return { ok: true, memory: orchestrator.memory, leadCandidate: orchestrator.leadCandidate };
}

export function completeTurn(orchestrator) {
  let stateMachine = transitionState(orchestrator.stateMachine, V4_STATES.LISTENING, "turn_complete");
  orchestrator.stateMachine = stateMachine;
  orchestrator.memory = {
    ...orchestrator.memory,
    current_state: V4_STATES.LISTENING,
    updated_at: Date.now()
  };
  if (orchestrator.currentTurn) {
    orchestrator.currentTurn.completed = true;
    orchestrator.currentTurn.completedAt = Date.now();
  }
  orchestrator.playback = null;
  return { ok: true, stateMachine, memory: orchestrator.memory };
}

export function closeCall(orchestrator, atMs = Date.now()) {
  let stateMachine = transitionState(orchestrator.stateMachine, V4_STATES.COMPLETED, "call_close");
  orchestrator.stateMachine = stateMachine;
  orchestrator.memory = {
    ...orchestrator.memory,
    current_state: V4_STATES.COMPLETED,
    updated_at: atMs
  };
  if (orchestrator.audioSession) {
    orchestrator.audioSession = closeAudioSession(orchestrator.audioSession, atMs);
  }
  orchestrator.status = "closed";
  orchestrator.postCallHandoff = finalizeV4PostCallHandoff(orchestrator, {
    callerPhoneNormalized: orchestrator.callerPhoneNormalized,
    callerPhoneRaw: orchestrator.callerPhoneRaw
  });
  orchestrator.leadCandidate = orchestrator.postCallHandoff.leadCandidate;
  if (orchestrator.leadCandidate?.callback_ready) {
    bufferEvent(orchestrator, "lead_created", {
      source: "v4_post_call_handoff",
      next_action: orchestrator.leadCandidate.next_action
    });
  } else {
    bufferEvent(orchestrator, "lead_skipped", {
      source: "v4_post_call_handoff",
      reason: orchestrator.leadCandidate?.validation?.reason ?? "not_callback_ready",
      next_action: orchestrator.leadCandidate?.next_action ?? "manual_review"
    });
  }
  bufferEvent(orchestrator, "audio_session_closed", { turn_count: orchestrator.turnIndex });
  return {
    ok: true,
    memory: orchestrator.memory,
    stateMachine,
    leadCandidate: orchestrator.leadCandidate,
    postCallHandoff: orchestrator.postCallHandoff
  };
}

export function applyContactPreference(orchestrator, preference, extras = {}) {
  orchestrator.memory = setContactPreference(orchestrator.memory, {
    preference,
    permission: extras.permission,
    emailPresent: extras.emailPresent,
    phonePresent: extras.phonePresent
  });
  return orchestrator.memory;
}

export function applyProductSelection(orchestrator, productId) {
  orchestrator.memory = setSelectedProduct(orchestrator.memory, productId);
  return orchestrator.memory;
}
