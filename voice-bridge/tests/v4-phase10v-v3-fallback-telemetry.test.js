import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createQaDialogueContext, processTextTurn } from "../src/turn-assistant.js";
import {
  recordLiveAssistantResponse,
  recordLiveCallSummary,
  recordLiveHandlerSelected
} from "../src/live-call-quality.js";
import {
  responsesAreNearDuplicate,
  routeKnownProductQuestion
} from "../src/v3/product-question-routing.js";

function qaConfigV3() {
  process.env.VOICE_ASSISTANT_ENABLED = "true";
  process.env.VOICE_SEMANTIC_INTENT_ENABLED = "true";
  process.env.VOICE_CONVERSATION_REPAIR_ENABLED = "true";
  process.env.VOICE_RAG_ENABLED = "false";
  process.env.VOICE_RAG_SALES_ANSWERER_ENABLED = "false";
  const config = loadConfig();
  config.assistant.enabled = true;
  config.assistant.qaTextMode = true;
  config.semanticIntent.enabled = true;
  config.conversationRepair.enabled = true;
  config.rag.enabled = false;
  config.rag.salesAnswererEnabled = false;
  return config;
}

async function runTurns(turns) {
  const config = qaConfigV3();
  const ctx = createQaDialogueContext();
  const results = [];
  for (let index = 0; index < turns.length; index += 1) {
    results.push(await processTextTurn({
      state: ctx,
      transcript: turns[index],
      config,
      turnIndex: index + 1,
      qaMode: true
    }));
  }
  return results;
}

test("10V: Smart Website pricing is answered before customer-type qualification", async () => {
  const results = await runTurns([
    "Hallo, ich interessiere mich für die Smart Website.",
    "Ich möchte wissen, was kostet das?"
  ]);
  assert.equal(results[1].normalizedIntent, "pricing_question");
  assert.match(results[1].responseText, /individuell|umfang/i);
  assert.doesNotMatch(results[1].responseText, /eigenes unternehmen|kundenprojekt/i);
  assert.equal(results[1].metadata.product_intake_stage, "sales_customer_type");
});

test("10V: Smart Website explanation is answered before qualification", async () => {
  const results = await runTurns([
    "Ich interessiere mich für die Smart Website.",
    "Wie funktioniert das?"
  ]);
  assert.equal(results[1].normalizedIntent, "product_more_detail_request");
  assert.doesNotMatch(results[1].responseText, /eigenes unternehmen|kundenprojekt/i);
});

test("10V: Voice Agent pricing is answered directly", async () => {
  const results = await runTurns([
    "Ich interessiere mich für die digitale Rezeption.",
    "Was kostet das?"
  ]);
  assert.equal(results[1].normalizedIntent, "pricing_question");
  assert.match(results[1].responseText, /individuell|umfang/i);
});

test("10V: explicit project discussion is not intercepted by direct question routing", () => {
  const result = routeKnownProductQuestion({
    callerText: "Ich möchte das als Kundenprojekt besprechen.",
    intent: "unknown",
    productId: "smart_website"
  });
  assert.equal(result, null);
});

test("10V: repeated pricing answer is not emitted identically", async () => {
  const results = await runTurns([
    "Ich interessiere mich für die Smart Website.",
    "Was kostet das?",
    "Was kostet das?"
  ]);
  assert.equal(responsesAreNearDuplicate(results[1].responseText, results[2].responseText), false);
  assert.equal(results[2].metadata.final_response_template, "product_question_repeat_guard");
});

test("10V: live telemetry is safe and distinguishes v3 runtime", async () => {
  const inserted = [];
  const insertFn = async (_config, input) => {
    inserted.push(input);
    return String(inserted.length);
  };
  const config = qaConfigV3();
  const ctx = {
    callSessionId: "11111111-1111-4111-8111-111111111111",
    callHandler: "v3",
    inboundAudioFrames: 12,
    assistantTurn: { product: { selectedProduct: "smart_website" } }
  };

  await recordLiveHandlerSelected(config, ctx, { handler: "v3", reason: "default_v3" }, { insertFn });
  await recordLiveAssistantResponse(config, ctx, {
    turnIndex: 2,
    detectedIntent: "pricing_question",
    finalResponseTemplate: "product_question_direct",
    productInterest: "smart_website",
    text: "secret transcript +491701234567"
  }, { insertFn });
  await recordLiveCallSummary(config, ctx, "socket_close", { insertFn });

  assert.deepEqual(inserted.map((row) => row.eventType), [
    "live_runtime_selected",
    "live_response_created",
    "live_runtime_summary"
  ]);
  const serialized = JSON.stringify(inserted);
  assert.match(serialized, /runtime_selected/);
  assert.match(serialized, /smart_website/);
  assert.doesNotMatch(serialized, /secret transcript|\+491701234567|email|rag_query/i);
});

test("10V: live telemetry insertion failure never throws", async () => {
  const config = qaConfigV3();
  const ctx = { callSessionId: "11111111-1111-4111-8111-111111111111", callHandler: "v3" };
  const result = await recordLiveCallSummary(config, ctx, "socket_close", {
    insertFn: async () => {
      throw new Error("db unavailable");
    }
  });
  assert.equal(result, null);
});
