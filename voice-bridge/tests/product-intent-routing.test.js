import test from "node:test";
import assert from "node:assert/strict";
import {
  detectProductRelationQuestion,
  shouldClassifyAsHumanOrAiQuestion,
  buildPostCapturePricingAnswer,
  buildProductRelationAnswer
} from "../src/product-intent-routing.js";

test("live-call product relation question is not human_or_ai", () => {
  const caller =
    "Kannst du ein bisschen über intelligente Website erklären? Hat sie zu tun mit KI-Assistent, also digitaler Assistent?";
  assert.equal(detectProductRelationQuestion(caller), true);
  assert.equal(shouldClassifyAsHumanOrAiQuestion(caller), false);
});

test("question-only signal remains human_or_ai when asking about the assistant itself", () => {
  const caller = "Sind Sie ein echter Mensch oder eine KI?";
  assert.equal(detectProductRelationQuestion(caller), false);
  assert.equal(shouldClassifyAsHumanOrAiQuestion(caller), true);
});

test("post-capture pricing answer omits website redirect when contact captured", () => {
  const text = buildPostCapturePricingAnswer(true);
  assert.match(text, /Kanäle|Umfang/i);
  assert.equal(/Mehr Informationen finden Sie auf unserer Website/i.test(text), false);
});

test("product relation answer mentions website and assistant", () => {
  const text = buildProductRelationAnswer();
  assert.match(text, /Website/i);
  assert.match(text, /KI-Assistent/i);
});
