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
} from "../src/v4/dialogue-orchestrator.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { V4_STATES } from "../src/v4/state-machine.js";
import { createQualityEventSink } from "../src/v4/quality-event-sink.js";
import { prepareLiveAssistantSpeechText } from "../src/v4/live-tts-playback-endpoint.js";
import { callerNeedFromV4Metadata } from "../src/post-call-summary.js";

const COMBINED =
  "Was ist Smart Website, was macht sie und was kostet sie?";

async function withEnv(patch, fn) {
  const old = {};
  for (const [key, value] of Object.entries(patch)) {
    old[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function ragEnv() {
  return {
    VOICE_RUNTIME_VERSION: "v4",
    VOICE_V4_REALTIME_ENABLED: "true",
    VOICE_V4_CANARY_ENABLED: "true",
    VOICE_V4_LIVE_AUDIOSOCKET_ENABLED: "true",
    VOICE_RAG_ENABLED: "true",
    VOICE_RAG_SALES_ANSWERER_ENABLED: "true",
    VOICE_RAG_API_URL: "http://127.0.0.1:8080",
    VOICE_RAG_RETRIEVE_TIMEOUT_MS: "1500",
    VOICE_RAG_RETRIEVE_MAX_ATTEMPTS: "3",
    VOICE_ASSISTANT_MAX_RESPONSE_CHARS: undefined,
  };
}

async function smartWebsiteRagHit() {
  return {
    ok: true,
    hit: true,
    hitCount: 1,
    topScore: 0.82,
    status: 200,
    latencyMs: 210,
    data: {
      answer_context: [
        {
          content:
            "Smart Website verbindet moderne Firmenwebseiten, Leistungsseiten, lokale Sichtbarkeit, klare Antworten und vorbereitete Anfragen.",
          title: "Smart Website Produktwissen",
          score: 0.82,
          metadata: { product_id: "smart_website" },
        },
      ],
    },
  };
}

test("10AJ: combined Smart Website RAG answer is richer and survives live TTS prep", async () => {
  await withEnv(ragEnv(), async () => {
    const config = loadConfig();
    const events = [];
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: createRuntimeContext(config, { bridgeCallId: "10aj-rich" }),
      memory: setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10aj-rich" }), "smart_website"),
      stateMachine: { state: V4_STATES.THINKING },
      agentConfig: loadAgentConfig(config),
      adapters: { ragRetriever: smartWebsiteRagHit },
      qualitySink: createQualityEventSink({ v4PathActive: true }),
      v4PathActive: true,
    });
    const originalBuffer = orchestrator.qualitySink.bufferQualityEvent.bind(orchestrator.qualitySink);
    orchestrator.qualitySink.bufferQualityEvent = (event) => {
      events.push(event);
      return originalBuffer(event);
    };

    startTurn(orchestrator);
    acceptUserTranscript(orchestrator, COMBINED);
    const action = await decideNextAction(orchestrator, { transcript: COMBINED });
    assert.equal(action.ragResult.used_rag, true);
    assert.equal(action.plan.plan_reason, "combined_product_inquiry");
    assert.equal(action.plan.response_type, "product_question_answer");
    assert.equal(action.plan.rag_used, true);
    assert.equal(action.plan.rag_product_scope, "smart_website");
    assert.ok(action.plan.text.length >= 220, action.plan.text);
    assert.match(action.plan.text, /moderne Firmenwebsite/i);
    assert.match(action.plan.text, /qualifizierte Anfragen/i);
    assert.match(action.plan.text, /Preis h.+ngt vom Umfang/i);

    const prepared = prepareLiveAssistantSpeechText(config, action.plan.text, {
      maxChars: action.plan.max_spoken_chars,
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.usedFallback, false);
    assert.equal(prepared.text, action.plan.text);
    assert.doesNotMatch(prepared.text, /…|â€¦/);

    commitAssistantPlanWithoutPlayback(orchestrator, action.plan.text, action.plan);
    const completed = events.find((event) => event.eventType === "rag_retrieval_completed");
    assert.ok(completed);
    assert.equal(completed.payload.rag_answer_preview.includes("Telefon"), false);
    assert.match(completed.payload.answer_context_preview, /Leistungsseiten/i);
    assert.equal(completed.payload.rag_source_title_preview, "Smart Website Produktwissen");
    assert.equal("transcript" in completed.payload, false);
    assert.equal("query" in completed.payload, false);

    const planEvent = events.find((event) => event.eventType === "response_plan_created");
    assert.ok(planEvent);
    assert.match(planEvent.payload.assistant_response_preview, /moderne Firmenwebsite/i);
    assert.equal(planEvent.payload.rag_used, true);
    assert.equal(planEvent.payload.rag_product_scope, "smart_website");
    assert.equal("assistant_text" in planEvent.payload, false);
  });
});

test("10AJ: v4 post-call caller need ignores closing thanks utterance", () => {
  const callerNeed = callerNeedFromV4Metadata({
    v4_runtime: true,
    caller_need: "Danke, das reicht erstmal",
    v4_memory_snapshot: {
      use_case_summary: null,
      current_problem: null,
      last_user_utterance: "Danke, das reicht erstmal",
    },
  });
  assert.equal(callerNeed, "");
});

test("10AJ: v3/RAG defaults stay off", () => {
  return withEnv(
    {
      VOICE_RUNTIME_VERSION: undefined,
      VOICE_RAG_ENABLED: undefined,
      VOICE_RAG_SALES_ANSWERER_ENABLED: undefined,
    },
    () => {
      const config = loadConfig();
      assert.equal(config.v4.runtimeVersion, "v3");
      assert.equal(config.rag.enabled, false);
      assert.equal(config.rag.salesAnswererEnabled, false);
    },
  );
});
