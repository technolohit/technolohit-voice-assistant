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
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";
import {
  detectTranscriptIntent,
  isCallbackPermissionPending,
} from "../src/v4/transcript-intent.js";
import {
  buildResponsePlan,
  applyMemoryPatch,
  RESPONSE_TYPES,
} from "../src/v4/response-planner.js";
import {
  retrieveV4RagAnswer,
  shouldUseRagForTurn,
  isTransientRetrievalFailure,
} from "../src/v4/rag-orchestrator.js";
import { runRagLivePathPreflight } from "../src/v4/rag-live-path-preflight.js";
import { callerNeedFromV4Metadata } from "../src/post-call-summary.js";
import { V4_STATES } from "../src/v4/state-machine.js";

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

function smartWebsiteMemory(state = V4_STATES.LISTENING) {
  return {
    ...setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10at" }), "smart_website"),
    current_product_context: "smart_website",
    current_state: state,
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

function createCanaryOrchestrator({
  ragRetriever = null,
  events = null,
  callerPhoneNormalized = null,
} = {}) {
  const config = loadConfig();
  const orchestrator = createDialogueOrchestrator({
    config,
    runtimeContext: createRuntimeContext(config, { bridgeCallId: "10at" }),
    memory: smartWebsiteMemory(),
    stateMachine: { state: V4_STATES.LISTENING },
    agentConfig: loadAgentConfig(config),
    adapters: ragRetriever ? { ragRetriever } : {},
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

// --- Fix A: callback permission continuation -------------------------------

test("10AT: callback request -> telefonisch -> ja grants permission instead of scoped product QA", async () => {
  await withEnv(canaryEnv(), async () => {
    let ragCalls = 0;
    const orchestrator = createCanaryOrchestrator({
      callerPhoneNormalized: "+4915112345678",
      ragRetriever: async () => {
        ragCalls += 1;
        return smartWebsiteHit();
      },
    });

    const callback = await runTurn(orchestrator, "Bitte rufen Sie mich telefonisch zurück.");
    assert.equal(callback.plan.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
    assert.equal(callback.plan.plan_reason, "callback_request_intent");
    assert.equal(orchestrator.memory.contact_flow_pending, true);

    const preference = await runTurn(orchestrator, "Ich habe doch gesagt, telefonisch.");
    assert.equal(preference.intent, "contact_phone");
    assert.equal(preference.plan.response_type, RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION);
    assert.equal(orchestrator.memory.contact_preference, "phone");
    assert.equal(orchestrator.memory.contact_flow_pending, true);

    const permission = await runTurn(orchestrator, "Ja.");
    assert.equal(permission.intent, "callback_permission_granted");
    assert.notEqual(permission.plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
    assert.notEqual(permission.plan.plan_reason, "scoped_product_qa");
    // Phase 10AU: with a valid caller phone the grant finalizes the callback.
    assert.equal(permission.plan.response_type, RESPONSE_TYPES.CALLBACK_FINALIZED);
    assert.equal(permission.plan.plan_reason, "callback_permission_granted");
    assert.equal(permission.plan.next_state, V4_STATES.VALIDATING_CONTACT);
    assert.equal(orchestrator.memory.callback_permission, "granted");
    assert.equal(orchestrator.memory.contact_preference, "phone");
    assert.equal(orchestrator.memory.callback_flow_state, "callback_finalized");

    // No RAG and no questionnaire on any callback/contact turn.
    assert.equal(ragCalls, 0);
    assert.equal(permission.ragGate.allowed, false);
    assert.equal(permission.plan.follow_up_question ?? null, null);
    assert.equal(permission.plan.questionnaire?.used ?? false, false);
  });
});

test("10AT: 'ja gerne' and 'okay' also grant callback permission", () => {
  const pendingMemory = {
    ...smartWebsiteMemory(V4_STATES.THINKING),
    contact_preference: "phone",
    contact_flow_pending: true,
  };
  for (const transcript of ["Ja gerne.", "Okay.", "Einverstanden."]) {
    assert.equal(
      detectTranscriptIntent(transcript, pendingMemory),
      "callback_permission_granted",
      transcript
    );
    const plan = buildResponsePlan({
      agentConfig: loadAgentConfig(loadConfig()),
      memory: pendingMemory,
      stateMachine: { state: V4_STATES.THINKING },
      transcript,
      callerPhoneNormalized: "+4915112345678",
    });
    assert.equal(plan.response_type, RESPONSE_TYPES.CALLBACK_FINALIZED, transcript);
    assert.equal(plan.plan_reason, "callback_permission_granted", transcript);
    assert.notEqual(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER, transcript);
  }
});

test("10AT: refusal after the permission question does not create a callback-ready lead", async () => {
  await withEnv(canaryEnv(), async () => {
    const orchestrator = createCanaryOrchestrator();
    await runTurn(orchestrator, "Bitte rufen Sie mich telefonisch zurück.");
    await runTurn(orchestrator, "Telefonisch bitte.");

    const refusal = await runTurn(orchestrator, "Nein, bitte nicht.");
    assert.equal(refusal.intent, "callback_permission_denied");
    assert.equal(refusal.plan.response_type, RESPONSE_TYPES.CALLBACK_PERMISSION_DENIED);
    assert.equal(refusal.plan.plan_reason, "callback_permission_denied");
    assert.equal(refusal.plan.lead_transition_allowed, false);
    assert.equal(refusal.plan.rag_allowed, false);
    assert.notEqual(refusal.plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
    assert.equal(orchestrator.memory.callback_permission, "denied");
    assert.equal(orchestrator.memory.lead_ready, false);
    assert.equal(isCallbackPermissionPending(orchestrator.memory), false);
    // Polite alternative contact path, no live-transfer claim.
    assert.match(refusal.plan.text, /e-?mail/i);
    assert.doesNotMatch(refusal.plan.text, /\b(sofort verbinden|jetzt weiterleiten|live transfer)\b/i);
  });
});

test("10AT: callback request with smart_website context runs no RAG and attaches no questionnaire", async () => {
  await withEnv(canaryEnv(), async () => {
    let ragCalls = 0;
    const orchestrator = createCanaryOrchestrator({
      ragRetriever: async () => {
        ragCalls += 1;
        return smartWebsiteHit();
      },
    });

    const action = await runTurn(orchestrator, "Bitte rufen Sie mich zurück, ich möchte das Projekt besprechen.");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
    assert.equal(ragCalls, 0);
    assert.equal(action.ragGate.allowed, false);
    assert.equal(action.plan.questionnaire?.used ?? false, false);
    assert.equal(action.plan.follow_up_question ?? null, null);
  });
});

test("10AT: closing still wins over callback/contact continuation", () => {
  const pendingMemory = {
    ...smartWebsiteMemory(V4_STATES.THINKING),
    contact_preference: "phone",
    contact_flow_pending: true,
  };
  for (const transcript of ["Nein danke, das war alles.", "Danke, das war alles."]) {
    assert.equal(detectTranscriptIntent(transcript, pendingMemory), "closing", transcript);
    const plan = buildResponsePlan({
      agentConfig: loadAgentConfig(loadConfig()),
      memory: pendingMemory,
      stateMachine: { state: V4_STATES.THINKING },
      transcript,
    });
    assert.equal(plan.response_type, RESPONSE_TYPES.CLOSING, transcript);
    assert.equal(plan.plan_reason, "closing_intent", transcript);
  }
});

test("10AT: 'telefonisch' maps to contact_phone when collecting preference; callback wording stays callback_request otherwise", () => {
  assert.equal(
    detectTranscriptIntent("telefonisch", { current_state: "collecting_contact_preference" }),
    "contact_phone"
  );
  assert.equal(
    detectTranscriptIntent("telefonisch", { contact_flow_pending: true }),
    "contact_phone"
  );
  // Outside the contact flow an explicit callback request still wins.
  assert.equal(
    detectTranscriptIntent("Bitte rufen Sie mich telefonisch zurueck.", {}),
    "callback_request"
  );
});

test("10AT: new product question during pending permission still reaches product QA", () => {
  const pendingMemory = {
    ...smartWebsiteMemory(V4_STATES.THINKING),
    contact_preference: "phone",
    contact_flow_pending: true,
  };
  assert.equal(
    detectTranscriptIntent("Ja, aber was kostet LokalKI?", pendingMemory),
    "product_question"
  );
});

test("10AT: RAG gate blocks callback permission intents explicitly", () => {
  for (const intent of ["callback_permission_granted", "callback_permission_denied"]) {
    const gate = shouldUseRagForTurn({
      state: V4_STATES.THINKING,
      intent,
      memory: { contact_preference: "phone" },
      transcript: "Ja.",
    });
    assert.equal(gate.allowed, false, intent);
    assert.equal(gate.reason, `${intent}_intent`, intent);
  }
});

test("10AT: post-call summary does not store a bare permission answer as caller need", () => {
  const ackOnly = callerNeedFromV4Metadata({
    v4_runtime: true,
    v4_memory_snapshot: {
      use_case_summary: null,
      current_problem: null,
      last_user_utterance: "Ja.",
    },
  });
  assert.equal(ackOnly, "");

  const realNeed = callerNeedFromV4Metadata({
    v4_runtime: true,
    v4_memory_snapshot: {
      use_case_summary: null,
      current_problem: null,
      last_user_utterance: "Was ist Smart Website und was kostet sie?",
    },
  });
  assert.equal(realNeed, "Was ist Smart Website und was kostet sie?");
});

// --- Fix B: live RAG transient retry ----------------------------------------

test("10AT: live RAG retries a transient request failure and uses the second hit", async () => {
  await withEnv(canaryEnv(), async () => {
    let calls = 0;
    const result = await retrieveV4RagAnswer({
      config: loadConfig(),
      agentConfig: loadAgentConfig(loadConfig()),
      transcript: "Was ist Smart Website, was macht sie und was kostet sie?",
      memory: smartWebsiteMemory(V4_STATES.THINKING),
      stateMachine: { state: V4_STATES.THINKING },
      retrieveFn: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, reason: "request_failed", latencyMs: 1428 };
        return smartWebsiteHit(206);
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.used_rag, true);
    assert.equal(result.rag_attempt_count, 2);
    assert.equal(result.rag_success_count, 1);
    assert.equal(result.rag_timeout_count, 0);
    assert.deepEqual(result.rag_attempt_fallback_reasons, ["request_failed"]);
  });
});

test("10AT: live RAG retries transient http_503 and stops on success", async () => {
  await withEnv(canaryEnv(), async () => {
    let calls = 0;
    const result = await retrieveV4RagAnswer({
      config: loadConfig(),
      agentConfig: loadAgentConfig(loadConfig()),
      transcript: "Was ist Smart Website, was macht sie und was kostet sie?",
      memory: smartWebsiteMemory(V4_STATES.THINKING),
      stateMachine: { state: V4_STATES.THINKING },
      retrieveFn: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, reason: "http_503", latencyMs: 80 };
        return smartWebsiteHit(206);
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.used_rag, true);
    assert.equal(result.rag_attempt_count, 2);
    assert.deepEqual(result.rag_attempt_fallback_reasons, ["http_503"]);
  });
});

test("10AT: live RAG honors VOICE_RAG_RETRIEVE_MAX_ATTEMPTS before falling back", async () => {
  await withEnv(canaryEnv(), async () => {
    let calls = 0;
    const result = await retrieveV4RagAnswer({
      config: loadConfig(),
      agentConfig: loadAgentConfig(loadConfig()),
      transcript: "Was ist Smart Website, was macht sie und was kostet sie?",
      memory: smartWebsiteMemory(V4_STATES.THINKING),
      stateMachine: { state: V4_STATES.THINKING },
      retrieveFn: async () => {
        calls += 1;
        return { ok: false, reason: "request_failed", latencyMs: 50 };
      },
    });

    assert.equal(calls, 3);
    assert.equal(result.used_rag, false);
    assert.equal(result.rag_attempt_count, 3);
    assert.equal(result.rag_success_count, 0);
    assert.equal(result.fallback_reason, "request_failed");
    assert.equal(result.rag_error_reason, "request_failed");
  });
});

test("10AT: VOICE_RAG_RETRIEVE_MAX_ATTEMPTS=2 limits retries", async () => {
  await withEnv(canaryEnv({ VOICE_RAG_RETRIEVE_MAX_ATTEMPTS: "2" }), async () => {
    let calls = 0;
    const result = await retrieveV4RagAnswer({
      config: loadConfig(),
      agentConfig: loadAgentConfig(loadConfig()),
      transcript: "Was ist Smart Website, was macht sie und was kostet sie?",
      memory: smartWebsiteMemory(V4_STATES.THINKING),
      stateMachine: { state: V4_STATES.THINKING },
      retrieveFn: async () => {
        calls += 1;
        return { ok: false, reason: "timeout", latencyMs: 1500 };
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.rag_attempt_count, 2);
    assert.equal(result.rag_timeout_count, 2);
    assert.equal(result.used_rag, false);
  });
});

test("10AT: deterministic http_404 failure is not retried", async () => {
  await withEnv(canaryEnv(), async () => {
    let calls = 0;
    const result = await retrieveV4RagAnswer({
      config: loadConfig(),
      agentConfig: loadAgentConfig(loadConfig()),
      transcript: "Was ist Smart Website, was macht sie und was kostet sie?",
      memory: smartWebsiteMemory(V4_STATES.THINKING),
      stateMachine: { state: V4_STATES.THINKING },
      retrieveFn: async () => {
        calls += 1;
        return { ok: false, reason: "http_404", latencyMs: 30 };
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.rag_attempt_count, 1);
    assert.equal(result.used_rag, false);
  });
});

test("10AT: transient failure classification matches retry policy", () => {
  assert.equal(isTransientRetrievalFailure({ ok: false, reason: "timeout" }), true);
  assert.equal(isTransientRetrievalFailure({ ok: false, reason: "request_failed" }), true);
  assert.equal(isTransientRetrievalFailure({ ok: false, reason: "rag_unavailable" }), true);
  assert.equal(isTransientRetrievalFailure({ ok: false, reason: "http_503" }), true);
  assert.equal(isTransientRetrievalFailure({ ok: false, reason: "http_429" }), true);
  assert.equal(isTransientRetrievalFailure({ ok: false, reason: "http_404" }), false);
  assert.equal(isTransientRetrievalFailure({ ok: false, reason: "http_400" }), false);
  assert.equal(isTransientRetrievalFailure({ ok: true }), false);
});

test("10AT: orchestrator records rag_retrieval_completed with rag_used after transient retry", async () => {
  await withEnv(canaryEnv(), async () => {
    let calls = 0;
    const events = [];
    const orchestrator = createCanaryOrchestrator({
      events,
      ragRetriever: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, reason: "request_failed", latencyMs: 1428 };
        return smartWebsiteHit(205);
      },
    });

    const transcript = "Was ist Smart Website, was macht sie und was kostet sie?";
    const action = await runTurn(orchestrator, transcript);

    assert.equal(action.ragResult.used_rag, true);
    assert.equal(action.plan.rag_used, true);
    assert.equal(action.plan.rag_fallback_used, false);
    const completed = events.find((event) => event.eventType === "rag_retrieval_completed");
    assert.ok(completed);
    assert.equal(completed.payload.rag_attempt_count, 2);
    assert.equal(completed.payload.rag_success_count, 1);
    assert.deepEqual(completed.payload.rag_attempt_fallback_reasons, ["request_failed"]);
    assert.equal(completed.payload.max_attempts, 3);
    assert.equal(completed.payload.timeout_ms, 1500);
  });
});

test("10AT: orchestrator records rag_retrieval_failed only after all attempts fail, without PII", async () => {
  await withEnv(canaryEnv(), async () => {
    let calls = 0;
    const events = [];
    const orchestrator = createCanaryOrchestrator({
      events,
      ragRetriever: async () => {
        calls += 1;
        return { ok: false, reason: "request_failed", latencyMs: 90 };
      },
    });

    const transcript = "Was ist Smart Website, was macht sie und was kostet sie?";
    const action = await runTurn(orchestrator, transcript);

    assert.equal(calls, 3);
    assert.equal(action.ragResult.used_rag, false);
    assert.equal(action.plan.rag_fallback_used, true);
    const failed = events.find((event) => event.eventType === "rag_retrieval_failed");
    assert.ok(failed);
    assert.equal(failed.payload.rag_attempt_count, 3);
    assert.equal(failed.payload.rag_success_count, 0);
    assert.equal(failed.payload.rag_fallback_used, true);
    assert.equal(failed.payload.rag_error_reason, "request_failed");

    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes(transcript), false);
    assert.equal("transcript" in failed.payload, false);
    assert.equal("query" in failed.payload, false);
    assert.equal(/\+\d{7,}/.test(serialized), false);
    assert.equal(/@\w+\.\w+/.test(serialized), false);
  });
});

test("10AT: preflight shares the live retrieval path including transient retry", async () => {
  await withEnv(canaryEnv(), async () => {
    let calls = 0;
    const config = loadConfig();
    const result = await runRagLivePathPreflight(config, {
      skipCanary: true,
      retrieveFn: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, reason: "request_failed", latencyMs: 700 };
        return smartWebsiteHit(206);
      },
    });

    assert.equal(calls, 2);
    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.equal(result.used_rag, true);
    assert.equal(result.rag_attempt_count, 2);
    assert.equal(result.rag_success_count, 1);
    assert.deepEqual(result.rag_attempt_fallback_reasons, ["request_failed"]);
    assert.equal(result.max_attempts, 3);
    assert.equal(result.timeout_ms, 1500);
  });
});

test("10AT: v3 default route and production flags remain unchanged", () => {
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
