import test from "node:test";
import assert from "node:assert/strict";
import { isFollowupQuestionOnlySignal, routePostCompletionTurn } from "../src/post-completion-router.js";

test("isFollowupQuestionOnlySignal accepts bare question announcement", () => {
  assert.equal(isFollowupQuestionOnlySignal("Danke. Kann ich eine Frage stellen?"), true);
  assert.equal(isFollowupQuestionOnlySignal("Ich habe noch eine kurze Frage."), true);
});

test("isFollowupQuestionOnlySignal rejects actual product question", () => {
  const q =
    "Kannst du ein bisschen über intelligente Website erklären? Hat sie zu tun mit KI-Assistent?";
  assert.equal(isFollowupQuestionOnlySignal(q), false);
});

test("routePostCompletionTurn answers product relation question", async () => {
  const intake = {
    completed: true,
    closingPending: true,
    postCompletionFollowupUsed: true,
    waitingFor: "post_completion_actual_question",
    contactPermissionGranted: true
  };
  const result = await routePostCompletionTurn({
    config: { rag: { enabled: false } },
    callerText:
      "Kannst du ein bisschen über intelligente Website erklären? Hat sie zu tun mit KI-Assistent?",
    intake,
    productState: { selectedProduct: "voice_agent" },
    normalizeResponse: (t) => t
  });
  assert.ok(result?.text);
  assert.equal(result.detectedIntent, "post_completion_product_answer");
  assert.match(result.text, /Website/i);
  assert.equal(result.text.includes("Welche Frage haben Sie?"), false);
});
