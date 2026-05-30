import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createQaDialogueContext, processTextTurn } from "../src/turn-assistant.js";

function qaConfigV3() {
  process.env.VOICE_ASSISTANT_ENABLED = "true";
  process.env.VOICE_SEMANTIC_INTENT_ENABLED = "true";
  process.env.VOICE_CONVERSATION_REPAIR_ENABLED = "true";
  process.env.VOICE_SEMANTIC_INTENT_MODE = "deterministic";
  process.env.VOICE_RAG_ENABLED = "false";
  const config = loadConfig();
  config.assistant.enabled = true;
  config.assistant.qaTextMode = true;
  config.semanticIntent.enabled = true;
  config.conversationRepair.enabled = true;
  return config;
}

test("v1.2.1 live failure: Eigenunternehmen does not repeat customer-type menu", async () => {
  const config = qaConfigV3();
  const ctx = createQaDialogueContext();
  const turns = ["Ich interessiere mich fuer AI Assistant.", "Eigenunternehmen.", "Eigene Unternehmen."];

  const results = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = await processTextTurn({
      state: ctx,
      transcript: turns[i],
      config,
      turnIndex: i + 1,
      qaMode: true
    });
    results.push(turn);
  }

  const menuSnippet = "sagen sie bitte kurz: eigenes unternehmen, kundenprojekt";
  const t2 = results[1].responseText.toLowerCase();
  const t3 = results[2].responseText.toLowerCase();

  assert.equal(results[1].normalizedIntent, "sales_customer_type_new_prospect");
  assert.equal(t2.includes(menuSnippet), false);
  assert.equal(t3.includes(menuSnippet), false);
  assert.notEqual(results[1].responseText, results[2].responseText);
});
