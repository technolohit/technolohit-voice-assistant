import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import {
  createDialogueOrchestrator,
  startTurn,
  acceptUserTranscript,
  decideNextAction,
  commitAssistantPlanWithoutPlayback,
  handleInterruption,
} from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { createQualityEventSink } from "../src/v4/quality-event-sink.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";
import { createLiveCanaryRuntime } from "../src/v4/canary-runtime-loop.js";
import { runLiveDialogueOnCallerTranscript } from "../src/v4/live-dialogue-endpoint.js";
import { runLiveTtsAndPlayback } from "../src/v4/live-tts-playback-endpoint.js";
import { CLOSING_RESPONSE_TEXT, isClosingIntent, isBareStopWord } from "../src/v4/closing-intent.js";
import { detectTranscriptIntent, getWarmGoodbyeResponseText } from "../src/v4/transcript-intent.js";
import { shouldUseRagForTurn } from "../src/v4/rag-orchestrator.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { V4_STATES } from "../src/v4/state-machine.js";

const CLOSING_PHRASES = [
  "Danke, das reicht erstmal.",
  "Passt so, danke.",
  "Danke, passt.",
  "Tschüss.",
  "Auf Wiederhören.",
  "Ich habe keine weiteren Fragen.",
  "Das war's.",
  "Stopp, danke, tschüss.",
];

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

function ragEnv(overrides = {}) {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "true",
    VOICE_V4_LIVE_CANARY_ALLOWLIST: "bridge:",
    VOICE_RAG_ENABLED: "true",
    VOICE_RAG_SALES_ANSWERER_ENABLED: "true",
    VOICE_RAG_API_URL: "http://127.0.0.1:8080",
    VOICE_RAG_RETRIEVE_TIMEOUT_MS: "1500",
    VOICE_RAG_RETRIEVE_MAX_ATTEMPTS: "3",
    ...overrides,
  };
}

function makeWritableSocket() {
  const writes = [];
  return {
    writable: true,
    writes,
    write(frame) {
      writes.push(frame);
      return true;
    },
    once() {}
  };
}

function buildOrchestrator({ config, state, ragRetriever, events, bridgeCallId }) {
  const orchestrator = createDialogueOrchestrator({
    config,
    runtimeContext: createRuntimeContext(config, { bridgeCallId }),
    memory: {
      ...setSelectedProduct(createCallSessionMemory({ bridgeCallId }), "smart_website"),
      current_state: state,
    },
    stateMachine: { state },
    agentConfig: loadAgentConfig(config),
    adapters: { ragRetriever },
    qualitySink: createQualityEventSink({ v4PathActive: true }),
    v4PathActive: true,
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

test("10AK: all required closing phrases detect as closing intent", () => {
  for (const phrase of CLOSING_PHRASES) {
    assert.equal(isClosingIntent(phrase), true, `isClosingIntent(${phrase})`);
    assert.equal(
      detectTranscriptIntent(phrase, {}, null),
      "closing",
      `detectTranscriptIntent(${phrase})`
    );
  }
});

test("10AK: closing response text matches contract", () => {
  assert.equal(
    CLOSING_RESPONSE_TEXT,
    "Sehr gerne. Dann wünsche ich Ihnen noch einen schönen Tag. Auf Wiederhören."
  );
  assert.equal(getWarmGoodbyeResponseText(), CLOSING_RESPONSE_TEXT);
});

test("10AK: closing after product answer does not call RAG and completes call", async () => {
  await withEnv(ragEnv(), async () => {
    const config = loadConfig();
    const events = [];
    let retrieverCalls = 0;
    const orchestrator = buildOrchestrator({
      config,
      state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
      ragRetriever: async () => {
        retrieverCalls += 1;
        return { ok: true, hit: true, hitCount: 1, topScore: 0.9, status: 200, data: { answer_context: [] } };
      },
      events,
      bridgeCallId: "10ak-closing-after-answer",
    });

    const transcript = "Danke, das reicht erstmal.";
    startTurn(orchestrator);
    acceptUserTranscript(orchestrator, transcript);
    const action = await decideNextAction(orchestrator, { transcript });

    assert.equal(retrieverCalls, 0, "RAG retriever must not be called on closing");
    assert.equal(action.ragGate.allowed, false);
    assert.equal(action.ragGate.reason, "closing_intent");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.CLOSING);
    assert.equal(action.plan.plan_reason, "closing_intent");
    assert.equal(action.plan.text, CLOSING_RESPONSE_TEXT);
    assert.equal(action.plan.rag_used, false);
    assert.equal(action.plan.rag_fallback_used, false);
    assert.equal(action.plan.lead_transition_allowed, false);

    const ragStarted = events.find((event) => event.eventType === "rag_retrieval_started");
    assert.equal(ragStarted, undefined, "no rag_retrieval_started on closing turn");

    const commit = commitAssistantPlanWithoutPlayback(orchestrator, action.plan.text, action.plan);
    assert.equal(commit.ok, true);
    assert.equal(orchestrator.stateMachine.state, V4_STATES.COMPLETED);
    assert.equal(orchestrator.stateMachine.lastError ?? null, null);
    assert.equal(orchestrator.memory.call_closing, true);

    const planCreated = events.find((event) => event.eventType === "response_plan_created");
    assert.ok(planCreated);
    assert.equal(planCreated.payload.response_type, RESPONSE_TYPES.CLOSING);
    assert.equal(planCreated.payload.plan_reason, "closing_intent");

    const serialized = JSON.stringify(events.map((event) => event.payload));
    assert.equal(serialized.includes("das reicht"), false, "no raw transcript in quality payloads");
    assert.equal(serialized.includes(transcript), false);
    assert.equal(/\+\d{7,}/.test(serialized), false, "no phone-like data in quality payloads");
    assert.equal(/@\w+\.\w+/.test(serialized), false, "no email-like data in quality payloads");
  });
});

test("10AK: live dialogue and playback keep closing turn completed, not error/listening", async () => {
  await withEnv(
    ragEnv({
      VOICE_V4_STT_PROVIDER: "mock",
      VOICE_V4_TTS_PROVIDER: "mock",
      VOICE_RAG_ENABLED: "true",
      VOICE_RAG_SALES_ANSWERER_ENABLED: "true"
    }),
    async () => {
      const config = loadConfig();
      const ctx = {
        bridgeCallId: "10ak-live-closing",
        callSessionId: "00000000-0000-0000-0000-0000000010ac",
        v4LiveSocket: makeWritableSocket()
      };
      const runtime = createLiveCanaryRuntime(config, ctx, {
        allowMockStt: true,
        allowMockTts: true
      });
      assert.equal(runtime.ok, true);
      ctx.v4LiveRuntime = runtime;
      runtime.ttsAdapter = {
        enabled: true,
        provider: "mock-test",
        synthesizeSentenceChunkAsync: async () => ({
          ok: true,
          firstChunkMs: 1,
          fromCache: false,
          chunks: [{ audio: Buffer.alloc(320) }]
        })
      };
      runtime.runtimeContext.stateMachine.state = V4_STATES.ANSWERING_PRODUCT_QUESTION;
      runtime.runtimeContext.memory = {
        ...setSelectedProduct(runtime.runtimeContext.memory, "smart_website"),
        current_state: V4_STATES.ANSWERING_PRODUCT_QUESTION
      };

      const candidate = {
        ok: true,
        transcript: "Danke, das reicht erstmal.",
        endpointIndex: 1,
        dialogueProcessed: false
      };

      const dialogue = await runLiveDialogueOnCallerTranscript(config, ctx, runtime, candidate);
      assert.equal(dialogue.ok, true);
      assert.equal(runtime.runtimeContext.stateMachine.state, V4_STATES.COMPLETED);
      assert.equal(runtime.runtimeContext.stateMachine.lastError ?? null, null);
      assert.equal(runtime.lastAssistantPlanCandidate.response_type, RESPONSE_TYPES.CLOSING);

      const playback = await runLiveTtsAndPlayback(config, ctx, runtime, dialogue);
      assert.equal(playback.ok, true);
      assert.equal(runtime.runtimeContext.stateMachine.state, V4_STATES.COMPLETED);
      assert.equal(runtime.runtimeContext.stateMachine.lastError ?? null, null);
      assert.equal(runtime.runtimeContext.memory.call_closing, true);
      assert.ok(ctx.v4LiveSocket.writes.length > 0);
    }
  );
});

test("10AK: 'Passt so, danke.' yields closing only, no sales context or fallback", async () => {
  await withEnv(ragEnv(), async () => {
    const config = loadConfig();
    const orchestrator = buildOrchestrator({
      config,
      state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
      ragRetriever: async () => {
        throw new Error("retriever must not run");
      },
      bridgeCallId: "10ak-passt-so",
    });

    const transcript = "Passt so, danke.";
    startTurn(orchestrator);
    acceptUserTranscript(orchestrator, transcript);
    const action = await decideNextAction(orchestrator, { transcript });

    assert.equal(action.plan.response_type, RESPONSE_TYPES.CLOSING);
    assert.equal(action.plan.plan_reason, "closing_intent");
    assert.notEqual(action.plan.response_type, "collect_sales_context");
    assert.notEqual(action.plan.response_type, "fallback_clarification");
    assert.equal(action.plan.text, CLOSING_RESPONSE_TEXT);
    assert.deepEqual(action.plan.allowed_tools, []);
  });
});

test("10AK: 'Stopp, danke, tschüss.' is closing, not interruption recovery", async () => {
  await withEnv(ragEnv(), async () => {
    const config = loadConfig();
    const orchestrator = buildOrchestrator({
      config,
      state: V4_STATES.THINKING,
      ragRetriever: async () => {
        throw new Error("retriever must not run");
      },
      bridgeCallId: "10ak-stopp-danke",
    });

    const transcript = "Stopp, danke, tschüss.";
    startTurn(orchestrator);
    acceptUserTranscript(orchestrator, transcript);
    const action = await decideNextAction(orchestrator, { transcript });

    assert.equal(action.intent, "closing");
    assert.equal(action.plan.response_type, RESPONSE_TYPES.CLOSING);
    assert.equal(action.plan.text, CLOSING_RESPONSE_TEXT);

    const commit = commitAssistantPlanWithoutPlayback(orchestrator, action.plan.text, action.plan);
    assert.equal(commit.ok, true);
    assert.equal(orchestrator.stateMachine.state, V4_STATES.COMPLETED);
  });
});

test("10AK: bare 'Stopp' during playback keeps barge-in/interruption wait behavior", async () => {
  assert.equal(isClosingIntent("Stopp"), false);
  assert.equal(isBareStopWord("Stopp"), true);
  assert.equal(detectTranscriptIntent("Stopp", {}, null), "interruption_recovery");

  await withEnv(ragEnv(), async () => {
    const config = loadConfig();
    const orchestrator = buildOrchestrator({
      config,
      state: V4_STATES.SPEAKING,
      ragRetriever: async () => {
        throw new Error("retriever must not run");
      },
      bridgeCallId: "10ak-bare-stopp",
    });
    orchestrator.lastAssistantText = "Smart Website strukturiert Inhalte und Anfragen.";

    const result = await handleInterruption(orchestrator, { callerText: "Stopp" });
    assert.equal(result.ok, true);
    assert.equal(result.recovery.recoveryAction, "interruption_followup");
    assert.notEqual(result.plan.response_type, RESPONSE_TYPES.CLOSING);
    assert.notEqual(orchestrator.stateMachine.state, V4_STATES.COMPLETED);
  });
});

test("10AK: closing overrides interrupt follow-up continuation", () => {
  const agent = loadAgentConfig(loadConfig());
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory: {
      selected_product_id: "smart_website",
      current_product_context: "smart_website",
      interruption_context: { interrupted_product_id: "smart_website" },
      current_state: V4_STATES.WAITING_FOR_INTERRUPTION_FOLLOWUP,
    },
    stateMachine: { state: V4_STATES.WAITING_FOR_INTERRUPTION_FOLLOWUP },
    transcript: "Danke, das reicht erstmal.",
    interruptionRecovery: { recoveryAction: "interruption_followup" },
  });
  assert.equal(plan.response_type, RESPONSE_TYPES.CLOSING);
  assert.equal(plan.plan_reason, "closing_intent");
  assert.equal(plan.next_state, V4_STATES.COMPLETED);
  assert.equal(plan.memory_patch.interruption_context, null);
});

test("10AK: RAG gate refuses closing turns even in answering state", () => {
  for (const phrase of CLOSING_PHRASES) {
    const gate = shouldUseRagForTurn({
      state: V4_STATES.ANSWERING_PRODUCT_QUESTION,
      memory: { selected_product_id: "smart_website" },
      transcript: phrase,
    });
    assert.equal(gate.allowed, false, `gate must refuse: ${phrase}`);
    assert.equal(gate.reason, "closing_intent");
  }
});

test("10AK: follow-up and question phrases are not treated as closing", () => {
  const nonClosing = [
    "Stopp, ich habe noch eine kurze Frage.",
    "Danke, und was kostet das?",
    "Ich habe noch eine Frage.",
    "Wie funktioniert Smart Website?",
    "Stopp",
  ];
  for (const phrase of nonClosing) {
    assert.equal(isClosingIntent(phrase), false, `must not close: ${phrase}`);
  }
});
