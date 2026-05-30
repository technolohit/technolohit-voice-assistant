import test from "node:test";
import assert from "node:assert/strict";
import { answerProductQuestionWithRag, isRagSalesAnswererEnabled } from "../src/rag-sales-answerer.js";

test("isRagSalesAnswererEnabled requires explicit flags", () => {
  assert.equal(
    isRagSalesAnswererEnabled({
      rag: { enabled: true, salesAnswererEnabled: false, qaMode: true },
      assistant: { qaTextMode: true }
    }),
    false
  );
  assert.equal(
    isRagSalesAnswererEnabled({
      rag: { enabled: true, salesAnswererEnabled: true, qaMode: true },
      assistant: { qaTextMode: true }
    }),
    true
  );
});

test("answerProductQuestionWithRag fails closed to playbook without RAG URL", async () => {
  const result = await answerProductQuestionWithRag({
    config: {
      rag: { enabled: true, salesAnswererEnabled: true, qaMode: true, apiUrl: "" },
      assistant: { qaTextMode: true }
    },
    callerText: "Was bringt mir der AI Assistant?",
    productId: "voice_agent"
  });
  assert.equal(result.used_rag, false);
  assert.ok(result.answer.length > 10);
  assert.ok(result.next_question.length > 5);
  assert.equal(result.safety.contains_private_data, false);
});

test("answerProductQuestionWithRag uses playbook when RAG disabled", async () => {
  const result = await answerProductQuestionWithRag({
    config: { rag: { enabled: false, salesAnswererEnabled: false } },
    callerText: "Kurze Erklärung bitte",
    productId: "voice_agent"
  });
  assert.match(result.answer, /rezeption|anrufe|leads/i);
});
