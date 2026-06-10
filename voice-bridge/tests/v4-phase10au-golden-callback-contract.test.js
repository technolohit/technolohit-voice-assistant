/**
 * Phase 10AU — Golden Conversation Contract for the callback flow.
 *
 * Replays the exact v1.35.2 live canary failure sequence
 * (call session 1fb2e144-86d3-4925-9345-f133c5419209) turn-by-turn and pins
 * the contract:
 *   1. product_question_answer / combined_product_inquiry
 *   2. collect_contact_preference / callback_request_intent
 *   3. collect_callback_permission / contact_phone_preference
 *   4. callback grant finalization (callback_finalized / callback_manual_review)
 *   5. callback reassurance after "Hallo?" — never product QA
 *
 * Forbidden after turn 2 (unless the caller explicitly asks a new product
 * question): product_question_answer, scoped_product_qa, RAG retrieval,
 * questionnaire_used=true.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import {
  createDialogueOrchestrator,
  startTurn,
  acceptUserTranscript,
  decideNextAction,
} from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { createQualityEventSink } from "../src/v4/quality-event-sink.js";
import { createCallSessionMemory } from "../src/v4/call-session-memory.js";
import { detectTranscriptIntent } from "../src/v4/transcript-intent.js";
import {
  applyMemoryPatch,
  RESPONSE_TYPES,
} from "../src/v4/response-planner.js";
import {
  retrieveV4RagAnswer,
  shouldUseRagForTurn,
  normalizeRetrievalFailure,
} from "../src/v4/rag-orchestrator.js";
import {
  CALLBACK_FLOW_STATES,
  resolveCallbackFlowState,
  isCallbackFlowActive,
  isCallbackFlowAttentionPhrase,
  hasValidCallerPhone,
} from "../src/v4/callback-flow-policy.js";
import { buildLeadCandidateFromMemory } from "../src/v4/lead-candidate.js";
import { callerNeedFromV4Metadata } from "../src/post-call-summary.js";
import { V4_STATES } from "../src/v4/state-machine.js";

const VALID_CALLER_PHONE = "+4915112345678";

const GOLDEN_TURNS = Object.freeze([
  "Was ist eine Smart Webseite, was macht sie und was kostet sie?",
  "Bitte rufen Sie mich telefonisch einfach zurück.",
  "Dankeschön, telefonisch bitte.",
  "Ja.",
  "Hallo?",
]);

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const finish = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result?.then) return result.finally(finish);
    finish();
    return result;
  } catch (err) {
    finish();
    throw err;
  }
}

function canaryEnv(extra = {}) {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_RAG_ENABLED: "true",
    VOICE_RAG_SALES_ANSWERER_ENABLED: "true",
    VOICE_RAG_API_URL: "http://127.0.0.1:8080",
    VOICE_RAG_RETRIEVE_TIMEOUT_MS: "1500",
    VOICE_RAG_RETRIEVE_MAX_ATTEMPTS: "3",
    VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true",
    ...extra,
  };
}

function smartWebsiteHit(latencyMs = 206) {
  return {
    ok: true,
    hit: true,
    hitCount: 1,
    topScore: 0.88,
    status: 200,
    data: {
      answer_context: [{
        snippet: "Smart Website strukturiert Inhalte und verbessert qualifizierte Anfragen.",
        title: "Smart Website",
        source_uri: "kb://products.technolohit.json#smart_website",
        score: 0.88,
        metadata: { product_id: "smart_website" },
      }],
    },
    latencyMs,
  };
}

function createGoldenOrchestrator({ callerPhoneNormalized = null, events = null, ragState = null } = {}) {
  const config = loadConfig();
  const orchestrator = createDialogueOrchestrator({
    config,
    runtimeContext: createRuntimeContext(config, { bridgeCallId: "10au" }),
    memory: createCallSessionMemory({ bridgeCallId: "10au" }),
    stateMachine: { state: V4_STATES.LISTENING },
    agentConfig: loadAgentConfig(config),
    adapters: {
      ragRetriever: async () => {
        if (ragState) ragState.calls += 1;
        return smartWebsiteHit();
      },
    },
    qualitySink: createQualityEventSink({ v4PathActive: true }),
    v4PathActive: true,
    callerPhoneNormalized,
  });
  if (events) {
    const originalBuffer = orchestrator.qualitySink.bufferQualityEvent.bind(orchestrator.qualitySink);
    orchestrator.qualitySink.bufferQualityEvent = (event) => {
      events.push(event);
      return originalBuffer(event);
    };
  }
  return orchestrator;
}

/** Run one live-like turn: detect, plan, then commit memory patch + state churn. */
async function runTurn(orchestrator, transcript) {
  startTurn(orchestrator);
  acceptUserTranscript(orchestrator, transcript);
  const action = await decideNextAction(orchestrator, { transcript });
  orchestrator.memory = applyMemoryPatch(orchestrator.memory, action.plan?.memory_patch ?? {});
  // Mirror live state churn: memory.current_state never stays on the
  // collecting_* states between turns (speaking -> listening -> thinking).
  orchestrator.memory = { ...orchestrator.memory, current_state: V4_STATES.SPEAKING };
  orchestrator.stateMachine = { state: action.plan?.next_state ?? V4_STATES.LISTENING };
  orchestrator.lastAssistantText = action.plan?.text ?? orchestrator.lastAssistantText;
  return action;
}

function assertNoProductQaLeak(action, label) {
  assert.notEqual(action.plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, label);
  assert.notEqual(action.plan.plan_reason, "scoped_product_qa", label);
  assert.equal(action.plan.questionnaire?.used ?? false, false, label);
  assert.equal(action.plan.follow_up_question ?? null, null, label);
}

// --- Golden sequence ---------------------------------------------------------

test("10AU golden contract: live failure sequence with valid caller ID finalizes the callback", async () => {
  await withEnv(canaryEnv(), async () => {
    const ragState = { calls: 0 };
    const orchestrator = createGoldenOrchestrator({
      callerPhoneNormalized: VALID_CALLER_PHONE,
      ragState,
    });

    // Turn 1: combined product inquiry answers the product question.
    const turn1 = await runTurn(orchestrator, GOLDEN_TURNS[0]);
    assert.equal(turn1.plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
    assert.equal(turn1.plan.plan_reason, "combined_product_inquiry");
    const ragCallsAfterProductTurn = ragState.calls;

    // Turn 2: callback request starts the contact flow.
    const turn2 = await runTurn(orchestrator, GOLDEN_TURNS[1]);
    assert.equal(turn2.plan.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
    assert.equal(turn2.plan.plan_reason, "callback_request_intent");
    assert.equal(
      resolveCallbackFlowState(orchestrator.memory),
      CALLBACK_FLOW_STATES.CONTACT_PREFERENCE_PENDING
    );
    assertNoProductQaLeak(turn2, "turn 2");

    // Turn 3: phone preference keeps the flow and asks for permission.
    const turn3 = await runTurn(orchestrator, GOLDEN_TURNS[2]);
    assert.equal(turn3.intent, "contact_phone");
    assert.equal(turn3.plan.response_type, RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION);
    assert.equal(turn3.plan.plan_reason, "contact_phone_preference");
    assert.equal(orchestrator.memory.contact_preference, "phone");
    assert.equal(
      resolveCallbackFlowState(orchestrator.memory),
      CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING
    );
    assertNoProductQaLeak(turn3, "turn 3");

    // Turn 4: "Ja." finalizes the callback (valid caller phone exists).
    const turn4 = await runTurn(orchestrator, GOLDEN_TURNS[3]);
    assert.equal(turn4.intent, "callback_permission_granted");
    assert.equal(turn4.plan.response_type, RESPONSE_TYPES.CALLBACK_FINALIZED);
    assert.equal(turn4.plan.plan_reason, "callback_permission_granted");
    assert.match(turn4.plan.text, /Anfrage aufgenommen/);
    assert.match(turn4.plan.text, /telefonisch/);
    assert.equal(orchestrator.memory.callback_permission, "granted");
    assert.equal(
      resolveCallbackFlowState(orchestrator.memory),
      CALLBACK_FLOW_STATES.CALLBACK_FINALIZED
    );
    assertNoProductQaLeak(turn4, "turn 4");

    // Turn 5: "Hallo?" is attention recovery inside the callback flow —
    // reassurance, never product QA (the v1.35.2 live failure).
    const turn5 = await runTurn(orchestrator, GOLDEN_TURNS[4]);
    assert.equal(turn5.intent, "callback_flow_attention");
    assert.equal(turn5.plan.response_type, RESPONSE_TYPES.CALLBACK_REASSURANCE);
    assert.equal(turn5.plan.plan_reason, "callback_flow_reassurance");
    assert.match(turn5.plan.text, /noch da/i);
    assert.match(turn5.plan.text, /telefonisch/);
    assertNoProductQaLeak(turn5, "turn 5");

    // RAG never ran after the contact flow started.
    assert.equal(ragState.calls, ragCallsAfterProductTurn);
    assert.equal(turn2.ragGate.allowed, false);
    assert.equal(turn3.ragGate.allowed, false);
    assert.equal(turn4.ragGate.allowed, false);
    assert.equal(turn5.ragGate.allowed, false);

    // Lead validator can mark callback-ready (all guards pass).
    const candidate = buildLeadCandidateFromMemory(orchestrator.memory, {
      callerPhoneNormalized: VALID_CALLER_PHONE,
    });
    assert.equal(candidate.callback_ready, true);
    assert.equal(candidate.next_action, "team_callback");
  });
});

test("10AU golden contract: same sequence without caller ID confirms manual review and never pretends callback-ready", async () => {
  await withEnv(canaryEnv(), async () => {
    const ragState = { calls: 0 };
    const orchestrator = createGoldenOrchestrator({ callerPhoneNormalized: null, ragState });

    await runTurn(orchestrator, GOLDEN_TURNS[0]);
    const ragCallsAfterProductTurn = ragState.calls;
    await runTurn(orchestrator, GOLDEN_TURNS[1]);
    await runTurn(orchestrator, GOLDEN_TURNS[2]);

    // Turn 4: no valid phone source — manual-review confirmation, the caller
    // is not left hanging and the assistant does not pretend callback-ready.
    const turn4 = await runTurn(orchestrator, GOLDEN_TURNS[3]);
    assert.equal(turn4.intent, "callback_permission_granted");
    assert.equal(turn4.plan.response_type, RESPONSE_TYPES.CALLBACK_MANUAL_REVIEW);
    assert.equal(turn4.plan.plan_reason, "callback_manual_review_no_phone");
    assert.match(turn4.plan.text, /manuellen Pr[üu]fung/);
    assert.equal(turn4.plan.lead_transition_allowed, false);
    assert.equal(orchestrator.memory.lead_ready, false);
    assert.equal(
      resolveCallbackFlowState(orchestrator.memory),
      CALLBACK_FLOW_STATES.CALLBACK_MANUAL_REVIEW
    );
    assertNoProductQaLeak(turn4, "turn 4");

    // Turn 5: "Hallo?" repeats the manual-review reassurance.
    const turn5 = await runTurn(orchestrator, GOLDEN_TURNS[4]);
    assert.equal(turn5.intent, "callback_flow_attention");
    assert.equal(turn5.plan.response_type, RESPONSE_TYPES.CALLBACK_REASSURANCE);
    assert.match(turn5.plan.text, /manuellen Pr[üu]fung/);
    assertNoProductQaLeak(turn5, "turn 5");

    assert.equal(ragState.calls, ragCallsAfterProductTurn);

    // Validator keeps the lead guard_not_met / manual review.
    const candidate = buildLeadCandidateFromMemory(orchestrator.memory, {
      callerPhoneNormalized: "",
    });
    assert.equal(candidate.callback_ready, false);
    assert.equal(candidate.next_action, "manual_review");
    assert.equal(candidate.validation.allowed, false);
  });
});

// --- Variants ----------------------------------------------------------------

test("10AU variant: closing after the permission grant still wins", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createGoldenOrchestrator({ callerPhoneNormalized: VALID_CALLER_PHONE });
    await runTurn(orchestrator, GOLDEN_TURNS[0]);
    await runTurn(orchestrator, GOLDEN_TURNS[1]);
    await runTurn(orchestrator, GOLDEN_TURNS[2]);
    await runTurn(orchestrator, GOLDEN_TURNS[3]);

    const closing = await runTurn(orchestrator, "Danke, das reicht erstmal.");
    assert.equal(closing.intent, "closing");
    assert.equal(closing.plan.response_type, RESPONSE_TYPES.CLOSING);
  });
});

test("10AU variant: explicit new product question after the callback flow may resume product QA", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createGoldenOrchestrator({ callerPhoneNormalized: VALID_CALLER_PHONE });
    await runTurn(orchestrator, GOLDEN_TURNS[0]);
    await runTurn(orchestrator, GOLDEN_TURNS[1]);
    await runTurn(orchestrator, GOLDEN_TURNS[2]);
    await runTurn(orchestrator, GOLDEN_TURNS[3]);

    const productReturn = await runTurn(orchestrator, "Was kostet eigentlich LokalKI?");
    assert.equal(productReturn.intent, "product_question");
    assert.equal(productReturn.plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
    // Even on the explicit product return, no questionnaire attaches after
    // the callback flow has started.
    assert.equal(productReturn.plan.questionnaire?.used ?? false, false);
    assert.equal(productReturn.plan.follow_up_question ?? null, null);
  });
});

test("10AU variant: refusal after the permission question keeps the lead non-callback-ready", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createGoldenOrchestrator({ callerPhoneNormalized: VALID_CALLER_PHONE });
    await runTurn(orchestrator, GOLDEN_TURNS[0]);
    await runTurn(orchestrator, GOLDEN_TURNS[1]);
    await runTurn(orchestrator, GOLDEN_TURNS[2]);

    const refusal = await runTurn(orchestrator, "Nein, lieber nicht.");
    assert.equal(refusal.intent, "callback_permission_denied");
    assert.equal(refusal.plan.response_type, RESPONSE_TYPES.CALLBACK_PERMISSION_DENIED);
    assert.match(refusal.plan.text, /e-?mail/i);
    assert.equal(orchestrator.memory.callback_permission, "denied");
    assert.equal(
      resolveCallbackFlowState(orchestrator.memory),
      CALLBACK_FLOW_STATES.CALLBACK_DENIED
    );

    const candidate = buildLeadCandidateFromMemory(orchestrator.memory, {
      callerPhoneNormalized: VALID_CALLER_PHONE,
    });
    assert.equal(candidate.callback_ready, false);
  });
});

test("10AU variant: attention phrases after grant resolve inside the callback flow", () => {
  const finalizedMemory = {
    contact_preference: "phone",
    callback_permission: "granted",
    callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_FINALIZED,
  };
  for (const transcript of ["Hallo?", "Sind Sie noch da?", "Ja?", "Okay?"]) {
    assert.equal(
      detectTranscriptIntent(transcript, finalizedMemory),
      "callback_flow_attention",
      transcript
    );
  }
  // A repeated callback request after finalization is reassurance, not a restart.
  assert.equal(
    detectTranscriptIntent("Bitte rufen Sie mich zurück.", finalizedMemory),
    "callback_flow_attention"
  );
  // Outside the callback flow these phrases keep their previous handling.
  assert.notEqual(detectTranscriptIntent("Hallo?", {}), "callback_flow_attention");
});

test("10AU: callback flow policy lifecycle helpers", () => {
  assert.equal(resolveCallbackFlowState({}), CALLBACK_FLOW_STATES.NONE);
  assert.equal(isCallbackFlowActive({}), false);
  assert.equal(
    resolveCallbackFlowState({ contact_flow_pending: true }),
    CALLBACK_FLOW_STATES.CONTACT_PREFERENCE_PENDING
  );
  assert.equal(
    resolveCallbackFlowState({ contact_preference: "phone" }),
    CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING
  );
  assert.equal(
    resolveCallbackFlowState({ contact_preference: "phone", callback_permission: "granted" }),
    CALLBACK_FLOW_STATES.CALLBACK_FINALIZED
  );
  assert.equal(
    resolveCallbackFlowState({ callback_permission: "denied" }),
    CALLBACK_FLOW_STATES.CALLBACK_DENIED
  );
  assert.equal(isCallbackFlowActive({ callback_permission: "denied" }), false);
  assert.equal(isCallbackFlowActive({ contact_preference: "phone" }), true);

  assert.equal(isCallbackFlowAttentionPhrase("Hallo?"), true);
  assert.equal(isCallbackFlowAttentionPhrase("Sind Sie noch da?"), true);
  assert.equal(isCallbackFlowAttentionPhrase("Was kostet Smart Website?"), false);

  assert.equal(hasValidCallerPhone({ callerPhoneNormalized: VALID_CALLER_PHONE }), true);
  assert.equal(hasValidCallerPhone({ callerPhoneNormalized: "" }), false);
  assert.equal(hasValidCallerPhone({ callerPhoneNormalized: "anonymous" }), false);
});

test("10AU: RAG gate blocks callback attention turns explicitly", () => {
  const gate = shouldUseRagForTurn({
    state: V4_STATES.THINKING,
    intent: "callback_flow_attention",
    memory: {
      contact_preference: "phone",
      callback_permission: "granted",
      callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_FINALIZED,
    },
    transcript: "Hallo?",
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "callback_flow_attention_intent");
});

// --- Summary cleanup ---------------------------------------------------------

test("10AU: summary ignores attention/acknowledgement phrases as caller need", () => {
  for (const utterance of ["Hallo?", "Ja.", "Okay.", "Danke schön.", "telefonisch bitte", "Dankeschön, telefonisch bitte."]) {
    const callerNeed = callerNeedFromV4Metadata({
      v4_runtime: true,
      v4_memory_snapshot: {
        use_case_summary: null,
        current_problem: null,
        last_user_utterance: utterance,
      },
    });
    assert.equal(callerNeed, "", utterance);
  }

  const realNeed = callerNeedFromV4Metadata({
    v4_runtime: true,
    v4_memory_snapshot: {
      use_case_summary: null,
      current_problem: null,
      last_user_utterance: "Was ist eine Smart Webseite, was macht sie und was kostet sie?",
    },
  });
  assert.equal(realNeed, "Was ist eine Smart Webseite, was macht sie und was kostet sie?");
});

// --- RAG failure normalization -----------------------------------------------

test("10AU: empty failure reason is normalized to request_failed and retried", async () => {
  await withEnv(canaryEnv(), async () => {
    let calls = 0;
    const config = loadConfig();
    const result = await retrieveV4RagAnswer({
      config,
      agentConfig: loadAgentConfig(config),
      transcript: "Was ist eine Smart Webseite, was macht sie und was kostet sie?",
      memory: {
        ...createCallSessionMemory({ bridgeCallId: "10au" }),
        selected_product_id: "smart_website",
        current_product_context: "smart_website",
        current_state: V4_STATES.THINKING,
      },
      stateMachine: { state: V4_STATES.THINKING },
      retrieveFn: async () => {
        calls += 1;
        // Live anomaly from 1fb2e144: ok=false with an empty reason — must
        // not suppress retries or produce empty fallback-reason evidence.
        return { ok: false, reason: "", latencyMs: 476 };
      },
    });

    assert.equal(calls, 3);
    assert.equal(result.used_rag, false);
    assert.equal(result.rag_attempt_count, 3);
    assert.deepEqual(result.rag_attempt_fallback_reasons, ["request_failed"]);
    assert.equal(result.fallback_reason, "request_failed");
    assert.equal(result.rag_error_reason, "request_failed");
  });
});

test("10AU: missing failure result/reason normalizes to request_failed", () => {
  assert.deepEqual(normalizeRetrievalFailure(null), {
    ok: false,
    reason: "request_failed",
    latencyMs: 0,
  });
  assert.equal(normalizeRetrievalFailure({ ok: false }).reason, "request_failed");
  assert.equal(normalizeRetrievalFailure({ ok: false, reason: "  " }).reason, "request_failed");
  assert.equal(normalizeRetrievalFailure({ ok: false, reason: "timeout" }).reason, "timeout");
  assert.equal(normalizeRetrievalFailure({ ok: true }).ok, true);
});

test("10AU: thrown retriever errors are normalized, retried, and carry non-empty reasons", async () => {
  await withEnv(canaryEnv(), async () => {
    let calls = 0;
    const config = loadConfig();
    const result = await retrieveV4RagAnswer({
      config,
      agentConfig: loadAgentConfig(config),
      transcript: "Was ist eine Smart Webseite, was macht sie und was kostet sie?",
      memory: {
        ...createCallSessionMemory({ bridgeCallId: "10au" }),
        selected_product_id: "smart_website",
        current_product_context: "smart_website",
        current_state: V4_STATES.THINKING,
      },
      stateMachine: { state: V4_STATES.THINKING },
      retrieveFn: async () => {
        calls += 1;
        if (calls < 3) throw new Error("socket hang up");
        return smartWebsiteHit(206);
      },
    });

    assert.equal(calls, 3);
    assert.equal(result.used_rag, true);
    assert.equal(result.rag_attempt_count, 3);
    assert.equal(result.rag_success_count, 1);
    assert.deepEqual(result.rag_attempt_fallback_reasons, ["request_failed"]);
  });
});

// --- Production defaults ------------------------------------------------------

test("10AU: v3 default route and production flags remain unchanged", () => {
  withEnv({
    VOICE_RUNTIME_VERSION: undefined,
    VOICE_RAG_ENABLED: undefined,
    VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: undefined,
  }, () => {
    const config = loadConfig();
    assert.equal(config.v4.runtimeVersion, "v3");
    assert.equal(config.rag?.enabled ?? false, false);
    assert.equal(config.v4.questionnaireRuntimeEnabled, false);
  });
});
