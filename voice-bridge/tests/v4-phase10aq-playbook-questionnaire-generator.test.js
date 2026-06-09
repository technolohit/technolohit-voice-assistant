import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadTenantPlaybook } from "../src/v4/playbook-loader.js";
import { validateCallbackReadyLead } from "../src/v4/lead-validator.js";
import {
  generatePlaybookQuestionnaire,
  evaluateQuestionnaireRules,
  formatQuestionnaireEvalSnapshot,
  assertQuestionnaireExpectations,
  HARDCODED_QUESTIONNAIRE_DEFAULTS,
  QUESTIONNAIRE_BLOCK_REASONS,
  QUESTIONNAIRE_CALLER_INTENTS,
  MAX_PHONE_QUESTION_CHARS,
} from "../src/v4/playbook-questionnaire-generator.js";
import {
  runPlaybookEvalSuite,
  loadDefaultPlaybookEvalSuite,
  formatEvalSuiteSnapshot,
} from "../src/v4/playbook-eval-scenarios.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";

function loadPlaybook() {
  const loaded = loadTenantPlaybook();
  assert.equal(loaded.ok, true);
  return loaded.playbook;
}

test("10AQ: Smart Website questionnaire asks project-context question after answer", () => {
  const playbook = loadPlaybook();
  const result = generatePlaybookQuestionnaire({
    productId: "smart_website",
    callerIntent: QUESTIONNAIRE_CALLER_INTENTS.PRODUCT_QUESTION_ANSWERED,
    playbook,
    productAnswered: true,
  });
  assert.equal(result.blocked, false);
  assert.equal(result.mode, "project_context");
  assert.equal(result.questions.length, 1);
  assert.match(result.questions[0].text, /Website|Relaunch|Ziele/i);
  assert.equal(result.questions[0].asks_pii, false);
  assert.ok(result.questions[0].text.length <= MAX_PHONE_QUESTION_CHARS);
});

test("10AQ: Voice Agent questionnaire asks call-handling use-case question", () => {
  const playbook = loadPlaybook();
  const result = generatePlaybookQuestionnaire({
    productId: "voice_agent",
    callerIntent: QUESTIONNAIRE_CALLER_INTENTS.PRODUCT_QUESTION_ANSWERED,
    playbook,
    productAnswered: true,
  });
  assert.match(result.questions[0].text, /Anruf|Anliegen|telefonisch/i);
  assert.equal(result.questions[0].field_key, "use_case_summary");
});

test("10AQ: LokalKI questionnaire asks local visibility / document context question", () => {
  const playbook = loadPlaybook();
  const result = generatePlaybookQuestionnaire({
    productId: "lokalki",
    callerIntent: QUESTIONNAIRE_CALLER_INTENTS.PRODUCT_QUESTION_ANSWERED,
    playbook,
    productAnswered: true,
  });
  assert.match(result.questions[0].text, /Dokument|lokal|Sichtbarkeit/i);
});

test("10AQ: closing blocks questionnaire generation", () => {
  const result = generatePlaybookQuestionnaire({
    productId: "smart_website",
    callerIntent: QUESTIONNAIRE_CALLER_INTENTS.CLOSING,
    callClosing: true,
  });
  assert.equal(result.blocked, true);
  assert.equal(result.block_reason, QUESTIONNAIRE_BLOCK_REASONS.CLOSING);
  assert.equal(result.questions.length, 0);
  const gate = evaluateQuestionnaireRules({ callerIntent: "closing", callClosing: true });
  assert.equal(gate.allowed, false);
});

test("10AQ: out-of-scope and technical escalation do not trigger questionnaire", () => {
  for (const intent of ["out_of_scope", "technical_escalation"]) {
    const result = generatePlaybookQuestionnaire({
      productId: "smart_website",
      callerIntent: intent,
      productAnswered: true,
    });
    assert.equal(result.blocked, true, intent);
    assert.equal(result.block_reason, QUESTIONNAIRE_BLOCK_REASONS.ROLE_BOUNDARY, intent);
  }
});

test("10AQ: answer-before-intake rule blocks questionnaire before product/pricing answer", () => {
  const blocked = generatePlaybookQuestionnaire({
    productId: "smart_website",
    callerIntent: "product_question",
    productAnswered: false,
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.block_reason, QUESTIONNAIRE_BLOCK_REASONS.ANSWER_FIRST);
});

test("10AQ: callback request offers contact preference but not lead_ready", () => {
  const result = generatePlaybookQuestionnaire({
    callerIntent: QUESTIONNAIRE_CALLER_INTENTS.CALLBACK_REQUEST,
    callerRequestedContact: true,
    memory: {},
  });
  assert.equal(result.blocked, false);
  assert.equal(result.mode, "contact_only");
  assert.equal(result.lead_ready_allowed, false);
  assert.match(result.questions[0].text, /telefonisch|E-Mail/i);
  const validation = validateCallbackReadyLead({}, { source: "questionnaire_generator" });
  assert.equal(validation.allowed, false);
});

test("10AQ: generated questions avoid exact price and live transfer claims", () => {
  const playbook = loadPlaybook();
  for (const productId of ["smart_website", "voice_agent", "lokalki"]) {
    const result = generatePlaybookQuestionnaire({
      productId,
      callerIntent: QUESTIONNAIRE_CALLER_INTENTS.PRODUCT_QUESTION_ANSWERED,
      playbook,
      productAnswered: true,
    });
    const combined = result.questions.map((q) => q.text).join(" ");
    assert.doesNotMatch(combined, /\b\d{2,}\s*(?:€|eur|euro)\b/i);
    assert.doesNotMatch(combined, /\b(sofort verbinden|live transfer)\b/i);
  }
});

test("10AQ: generic fallback when product-specific data is missing", () => {
  const result = generatePlaybookQuestionnaire({
    productId: "unknown_product",
    callerIntent: QUESTIONNAIRE_CALLER_INTENTS.PRODUCT_QUESTION_ANSWERED,
    productAnswered: true,
  });
  assert.match(result.questions[0].text, /Projekt/i);
});

test("10AQ: questionnaire eval snapshot contains no raw phone/email/transcript", () => {
  const playbook = loadPlaybook();
  const result = generatePlaybookQuestionnaire({
    productId: "smart_website",
    callerIntent: QUESTIONNAIRE_CALLER_INTENTS.PRODUCT_QUESTION_ANSWERED,
    playbook,
    productAnswered: true,
  });
  const snapshot = JSON.parse(formatQuestionnaireEvalSnapshot(result));
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("transcript"), false);
  assert.equal(/\+\d{7,}/.test(serialized), false);
  assert.equal(/@\w+\.\w+/.test(serialized), false);
  for (const question of result.questions) {
    assert.equal(serialized.includes(question.text), false);
  }
});

test("10AQ: playbook eval suite passes questionnaire scenarios", async () => {
  const loaded = loadDefaultPlaybookEvalSuite();
  const suite = await runPlaybookEvalSuite({ playbook: loaded.playbook });
  const questionnaireResults = suite.results.filter((entry) => entry.category === "questionnaire");
  assert.ok(questionnaireResults.length >= 7);
  assert.equal(questionnaireResults.every((entry) => entry.status === "pass"), true);
  assert.equal(suite.summary.fail, 0);
});

test("10AQ: full eval snapshot remains privacy-safe with questionnaire scenarios", async () => {
  const loaded = loadDefaultPlaybookEvalSuite();
  const suite = await runPlaybookEvalSuite({ playbook: loaded.playbook });
  const snapshot = JSON.parse(formatEvalSuiteSnapshot(suite));
  const serialized = JSON.stringify(snapshot);
  for (const scenario of loaded.playbook.eval_scenarios) {
    if (scenario.caller) {
      assert.equal(serialized.includes(scenario.caller), false, scenario.id);
    }
  }
});

test("10AQ: default v3 and playbook runtime flags unchanged", () => {
  const config = loadConfig();
  assert.equal(config.v4.runtimeVersion, "v3");
  assert.equal(config.v4.playbookRuntimeEnabled, false);
  assert.equal(config.rag?.enabled ?? false, false);
});

test("10AQ: hardcoded defaults match when playbook has no questionnaire_policy", () => {
  const stripped = { ...loadPlaybook() };
  delete stripped.questionnaire_policy;
  const result = generatePlaybookQuestionnaire({
    productId: "smart_website",
    callerIntent: QUESTIONNAIRE_CALLER_INTENTS.PRODUCT_QUESTION_ANSWERED,
    playbook: stripped,
    productAnswered: true,
  });
  assert.equal(result.source, "hardcoded_default");
  assert.match(
    result.questions[0].text,
    new RegExp(HARDCODED_QUESTIONNAIRE_DEFAULTS.products.smart_website.slice(0, 20))
  );
});

test("10AQ: closing planner path still blocks collect_sales_context after product answer context", () => {
  const config = loadConfig();
  const agent = loadAgentConfig(config);
  const plan = buildResponsePlan({
    agentConfig: agent,
    memory: { selected_product_id: "smart_website", current_state: "listening" },
    stateMachine: { state: "listening" },
    transcript: "Danke, das reicht erstmal.",
  });
  assert.equal(plan.response_type, RESPONSE_TYPES.CLOSING);
});

test("10AQ: assertQuestionnaireExpectations detects blocked vs ready modes", () => {
  const blocked = generatePlaybookQuestionnaire({ callerIntent: "closing", callClosing: true });
  assert.deepEqual(
    assertQuestionnaireExpectations(blocked, { behavior: "blocked", block_reason: "closing_blocks_intake" }),
    []
  );
  const ready = generatePlaybookQuestionnaire({
    productId: "voice_agent",
    callerIntent: "product_question_answered",
    productAnswered: true,
  });
  assert.deepEqual(
    assertQuestionnaireExpectations(ready, {
      behavior: "project_context_question",
      response_contains: "Anruf|Anliegen",
    }),
    []
  );
});
