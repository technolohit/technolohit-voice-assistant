/**
 * Phase 10C — Agent Behavior Decision vs planner eval harness tests.
 * Non-live comparison only; must not change runtime behavior.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { isAgentBehaviorDecisionEnabled } from "../src/v4/agent-behavior-decision-runtime.js";
import {
  CALLBACK_FLOW_ACTUAL_RESPONSE_TYPES,
  DECISION_EVAL_PENDING_STATUS,
  DECISION_EVAL_SCENARIOS,
  compareDecisionToActual,
  formatDecisionEvalSnapshot,
  responseTypesAligned,
  runDecisionEvalScenario,
  runDecisionEvalSuite,
  summarizeDecisionEvalMismatches,
} from "../src/v4/agent-behavior-decision-eval.js";
import { BEHAVIOR_PRIORITIES } from "../src/v4/agent-behavior-decision.js";
import { RESPONSE_TYPES } from "../src/v4/response-planner.js";

const EMAIL_PATTERN = /@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_PATTERN = /\+?\d{10,}/;

test("formatDecisionEvalSnapshot is privacy-safe (no transcript/phone/email)", () => {
  const suite = {
    playbook_version: "technolohit-playbook-v1-20260611",
    ok: false,
    summary: { total: 2, pass: 1, fail: 1, pending: 0 },
    results: [
      {
        scenario_id: "explicit_product_question",
        category: "product_question",
        caller_chars: 22,
        decision_priority: BEHAVIOR_PRIORITIES.EXPLICIT_PRODUCT_QUESTION,
        decision_response_type: RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
        actual_response_type: RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
        decision_rag_allowed: true,
        actual_rag_used: false,
        decision_questionnaire_allowed: false,
        actual_questionnaire_used: false,
        status: "pass",
        failures: [],
      },
      {
        scenario_id: "questionnaire_eligible_after_product_answer",
        category: "questionnaire",
        caller_chars: 22,
        decision_priority: BEHAVIOR_PRIORITIES.EXPLICIT_PRODUCT_QUESTION,
        decision_response_type: RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
        actual_response_type: RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
        decision_rag_allowed: true,
        actual_rag_used: false,
        decision_questionnaire_allowed: false,
        actual_questionnaire_used: true,
        status: "fail",
        failures: ["questionnaire_used_when_decision_disallows"],
        known_mismatch: "questionnaire_attached_same_turn_while_decision_blocks",
      },
    ],
  };

  const snapshot = formatDecisionEvalSnapshot(suite);
  assert.doesNotMatch(snapshot, /Was ist Smart Website/i);
  assert.doesNotMatch(snapshot, EMAIL_PATTERN);
  assert.doesNotMatch(snapshot, PHONE_PATTERN);
  const parsed = JSON.parse(snapshot);
  assert.equal(parsed.results[0].caller_chars, 22);
  assert.ok(!("caller" in parsed.results[0]));
});

test("contact form handoff scenarios pass with runtime flag (Phase 10E)", async () => {
  for (const id of [
    "contact_form_handoff",
    "no_email_capture_by_voice",
    "no_website_url_capture_by_voice",
  ]) {
    const scenario = DECISION_EVAL_SCENARIOS.find((s) => s.id === id);
    const result = await runDecisionEvalScenario({ scenario });
    assert.equal(result.status, "pass", `${id}: ${result.failures.join(",")}`);
    assert.equal(result.actual_response_type, RESPONSE_TYPES.CONTACT_FORM_HANDOFF, id);
  }
});

test("compareDecisionToActual reports mismatch with useful failure reason", () => {
  const decision = {
    priority: BEHAVIOR_PRIORITIES.EXPLICIT_PRODUCT_QUESTION,
    response_type: RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
    rag_allowed: true,
    questionnaire_allowed: false,
  };
  const actual = {
    plan: {
      response_type: RESPONSE_TYPES.CLOSING,
      questionnaire: { used: true },
    },
    ragResult: { used_rag: true },
  };

  const failures = compareDecisionToActual(decision, actual);
  assert.ok(failures.includes(`response_type:${RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER}!=${RESPONSE_TYPES.CLOSING}`));
  assert.ok(failures.includes("questionnaire_used_when_decision_disallows"));
});

test("responseTypesAligned accepts callback_flow planner variants", () => {
  for (const actualType of CALLBACK_FLOW_ACTUAL_RESPONSE_TYPES) {
    assert.equal(
      responseTypesAligned(
        RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE,
        actualType,
        BEHAVIOR_PRIORITIES.CALLBACK_FLOW
      ),
      true,
      actualType
    );
  }
});

test("runDecisionEvalSuite covers required categories", async () => {
  const suite = await runDecisionEvalSuite();
  assert.equal(suite.results.length, DECISION_EVAL_SCENARIOS.length);
  assert.ok(suite.summary.total >= 13);
  assert.equal(suite.summary.pending, 0);
  assert.ok(suite.playbook_version);

  const byId = new Map(suite.results.map((r) => [r.scenario_id, r]));
  const required = [
    "closing_after_product_answer",
    "callback_request_after_product_answer",
    "callback_permission_continuation",
    "callback_attention_reassurance",
    "out_of_scope_general_question",
    "technical_escalation",
    "explicit_product_question",
    "product_context_continuation",
    "questionnaire_eligible_after_product_answer",
    "fallback_unclear",
    "contact_form_handoff",
    "no_email_capture_by_voice",
    "no_website_url_capture_by_voice",
  ];
  for (const id of required) {
    assert.ok(byId.has(id), `missing scenario ${id}`);
  }
});

test("implemented scenarios that align with planner pass", async () => {
  const passCandidates = [
    "closing_after_product_answer",
    "out_of_scope_general_question",
    "technical_escalation",
    "explicit_product_question",
    "fallback_unclear",
    "callback_attention_reassurance",
    "questionnaire_eligible_after_product_answer",
  ];

  for (const id of passCandidates) {
    const scenario = DECISION_EVAL_SCENARIOS.find((s) => s.id === id);
    const result = await runDecisionEvalScenario({ scenario });
    assert.equal(result.status, "pass", `${id}: ${result.failures.join(",")}`);
  }
});

test("questionnaire scenario passes with decision guard enabled (Phase 10D)", async () => {
  const scenario = DECISION_EVAL_SCENARIOS.find(
    (s) => s.id === "questionnaire_eligible_after_product_answer"
  );
  const result = await runDecisionEvalScenario({ scenario });
  assert.equal(result.status, "pass", result.failures.join(","));
  assert.equal(result.decision_questionnaire_allowed, false);
  assert.equal(result.actual_questionnaire_used, false);
  assert.equal(summarizeDecisionEvalMismatches({ results: [result] }).length, 0);
});

test("full eval suite is 13 pass / 0 fail / 0 pending (Phase 10E contact form)", async () => {
  const suite = await runDecisionEvalSuite();
  assert.equal(suite.summary.pass, 13);
  assert.equal(suite.summary.fail, 0);
  assert.equal(suite.summary.pending, 0);
  assert.equal(suite.ok, true);
});

test("default production config unchanged (decision flag off)", () => {
  const config = loadConfig();
  assert.equal(isAgentBehaviorDecisionEnabled(config), false);
  assert.equal(config.v4.agentBehaviorDecisionEnabled, false);
  assert.equal(config.v4.questionnaireRuntimeEnabled, false);
});
