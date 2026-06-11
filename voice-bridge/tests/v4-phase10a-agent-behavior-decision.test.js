/**
 * Phase 10A — Agent Behavior Decision Layer skeleton tests.
 * Pure decision logic only; no live runtime wiring.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadTenantPlaybook } from "../src/v4/playbook-loader.js";
import { CALLBACK_FLOW_STATES } from "../src/v4/callback-flow-policy.js";
import {
  resolveAgentBehaviorDecision,
  formatAgentBehaviorDecisionSnapshot,
  isAgentBehaviorDecisionRuntimeEnabled,
  BEHAVIOR_PRIORITIES,
  LEAD_TIERS,
  DECISION_RESPONSE_TYPES,
} from "../src/v4/agent-behavior-decision.js";

function loadPlaybookOrThrow() {
  const loaded = loadTenantPlaybook();
  assert.equal(loaded.ok, true);
  return loaded.playbook;
}

function decide(overrides = {}) {
  return resolveAgentBehaviorDecision(overrides);
}

test("10A: closing priority wins and disables RAG/questionnaire", () => {
  const decision = decide({
    intent: "closing",
    closingIntent: true,
    memory: { selected_product_id: "smart_website", product_answered: true },
    productAnswered: true,
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(decision.priority, BEHAVIOR_PRIORITIES.CLOSING);
  assert.equal(decision.response_type, DECISION_RESPONSE_TYPES.CLOSING);
  assert.equal(decision.rag_allowed, false);
  assert.equal(decision.questionnaire_allowed, false);
  assert.ok(decision.suppressed_intents.includes("questionnaire"));
  assert.ok(decision.suppressed_intents.includes("rag"));
});

test("10A: active callback flow wins over product continuation", () => {
  const decision = decide({
    intent: "scoped_product_qa",
    callbackFlowState: CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING,
    memory: { selected_product_id: "smart_website" },
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(decision.priority, BEHAVIOR_PRIORITIES.CALLBACK_FLOW);
  assert.equal(decision.response_type, DECISION_RESPONSE_TYPES.COLLECT_CALLBACK_PERMISSION);
  assert.equal(decision.rag_allowed, false);
  assert.equal(decision.questionnaire_allowed, false);
  assert.ok(decision.suppressed_intents.includes("product_context_continuation"));
});

test("10A: callback request starts callback flow with callback_requested lead tier", () => {
  const decision = decide({
    intent: "callback_request",
    transcript: "Bitte rufen Sie mich zurück.",
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(decision.priority, BEHAVIOR_PRIORITIES.CALLBACK_FLOW);
  assert.equal(decision.response_type, DECISION_RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
  assert.equal(decision.lead_tier, LEAD_TIERS.CALLBACK_REQUESTED);
  assert.equal(decision.rag_allowed, false);
});

test("10A: role boundary out-of-scope wins before product QA", () => {
  const decision = decide({
    intent: "out_of_scope",
    roleBoundaryIntent: "out_of_scope",
    memory: { selected_product_id: "smart_website" },
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(decision.priority, BEHAVIOR_PRIORITIES.ROLE_BOUNDARY);
  assert.equal(decision.response_type, DECISION_RESPONSE_TYPES.ROLE_BOUNDARY_REDIRECT);
  assert.equal(decision.rag_allowed, false);
  assert.equal(decision.questionnaire_allowed, false);
});

test("10A: technical escalation is role boundary with manual_review tier", () => {
  const decision = decide({
    intent: "technical_escalation",
    roleBoundaryIntent: "technical_escalation",
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(decision.priority, BEHAVIOR_PRIORITIES.ROLE_BOUNDARY);
  assert.equal(decision.response_type, DECISION_RESPONSE_TYPES.TECHNICAL_ESCALATION);
  assert.equal(decision.lead_tier, LEAD_TIERS.MANUAL_REVIEW);
  assert.equal(decision.next_action, "escalate_to_team");
});

test("10A: explicit product question may override active callback flow", () => {
  const decision = decide({
    intent: "product_question",
    callbackFlowState: CALLBACK_FLOW_STATES.CALLBACK_FINALIZED,
    productContext: { product_id: "aiseoq" },
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(decision.priority, BEHAVIOR_PRIORITIES.EXPLICIT_PRODUCT_QUESTION);
  assert.equal(decision.response_type, DECISION_RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
  assert.equal(decision.product_id, "aiseoq");
  assert.equal(decision.rag_allowed, true);
  assert.equal(decision.questionnaire_allowed, false);
  assert.ok(decision.suppressed_intents.includes("callback_flow"));
});

test("10A: explicit product question without callback allows RAG", () => {
  const decision = decide({
    intent: "product_question",
    productContext: { product_id: "smart_website" },
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(decision.priority, BEHAVIOR_PRIORITIES.EXPLICIT_PRODUCT_QUESTION);
  assert.equal(decision.rag_allowed, true);
  assert.equal(decision.questionnaire_allowed, false);
});

test("10A: product context continuation allows RAG", () => {
  const decision = decide({
    intent: "scoped_product_qa",
    productContext: { product_id: "smart_website" },
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(decision.priority, BEHAVIOR_PRIORITIES.PRODUCT_CONTEXT_CONTINUATION);
  assert.equal(decision.rag_allowed, true);
  assert.equal(decision.questionnaire_allowed, false);
});

test("10A: questionnaire allowed only after eligible product answer path", () => {
  const allowed = decide({
    intent: "unclear",
    questionnaireEligible: true,
    productAnswered: true,
    productContext: { product_id: "voice_agent" },
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(allowed.priority, BEHAVIOR_PRIORITIES.QUESTIONNAIRE);
  assert.equal(allowed.questionnaire_allowed, true);
  assert.equal(allowed.rag_allowed, false);

  const blockedByCallback = decide({
    intent: "unclear",
    questionnaireEligible: true,
    productAnswered: true,
    callbackFlowState: CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING,
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(blockedByCallback.priority, BEHAVIOR_PRIORITIES.CALLBACK_FLOW);
  assert.equal(blockedByCallback.questionnaire_allowed, false);

  const blockedByClosing = decide({
    intent: "closing",
    closingIntent: true,
    questionnaireEligible: true,
    productAnswered: true,
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(blockedByClosing.priority, BEHAVIOR_PRIORITIES.CLOSING);
  assert.equal(blockedByClosing.questionnaire_allowed, false);

  const blockedByRoleBoundary = decide({
    intent: "out_of_scope",
    questionnaireEligible: true,
    productAnswered: true,
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(blockedByRoleBoundary.priority, BEHAVIOR_PRIORITIES.ROLE_BOUNDARY);
  assert.equal(blockedByRoleBoundary.questionnaire_allowed, false);
});

test("10A: fallback is lowest priority for unclear intent", () => {
  const decision = decide({
    intent: "unclear",
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(decision.priority, BEHAVIOR_PRIORITIES.FALLBACK);
  assert.equal(decision.response_type, DECISION_RESPONSE_TYPES.FALLBACK_CLARIFICATION);
  assert.equal(decision.rag_allowed, false);
  assert.equal(decision.questionnaire_allowed, false);
});

test("10A: playbook_version traceability when playbook is valid", () => {
  const playbook = loadPlaybookOrThrow();
  const decision = decide({
    intent: "product_question",
    playbook,
  });
  assert.equal(decision.playbook_version, playbook.playbook_version);
  assert.equal(decision.playbook_valid, true);
  assert.match(decision.reason, /explicit_product_question/);
  assert.equal(decision.rag_allowed, true);
});

test("10A: missing or invalid playbook fails closed with safe metadata", () => {
  const missing = decide({ intent: "product_question", playbook: null });
  assert.equal(missing.playbook_version, null);
  assert.equal(missing.playbook_valid, false);
  assert.match(missing.reason, /playbook_missing/);
  assert.equal(missing.priority, BEHAVIOR_PRIORITIES.EXPLICIT_PRODUCT_QUESTION);
  assert.equal(missing.rag_allowed, false);
  assert.equal(missing.questionnaire_allowed, false);
  assert.ok(missing.suppressed_intents.includes("rag"));

  const invalidProduct = decide({
    intent: "product_question",
    playbook: { playbook_version: "broken", products: [] },
  });
  assert.equal(invalidProduct.playbook_version, "broken");
  assert.equal(invalidProduct.playbook_valid, false);
  assert.match(invalidProduct.reason, /playbook_validation_failed/);
  assert.equal(invalidProduct.priority, BEHAVIOR_PRIORITIES.EXPLICIT_PRODUCT_QUESTION);
  assert.equal(invalidProduct.rag_allowed, false);
  assert.equal(invalidProduct.questionnaire_allowed, false);

  const invalid = decide({
    intent: "unclear",
    playbook: { playbook_version: "broken", products: [] },
  });
  assert.equal(invalid.playbook_valid, false);
  assert.match(invalid.reason, /playbook_validation_failed/);
  assert.equal(invalid.priority, BEHAVIOR_PRIORITIES.FALLBACK);
  assert.equal(invalid.rag_allowed, false);
  assert.equal(invalid.questionnaire_allowed, false);

  const invalidQuestionnaire = decide({
    intent: "unclear",
    questionnaireEligible: true,
    productAnswered: true,
    playbook: { playbook_version: "broken", products: [] },
  });
  assert.equal(invalidQuestionnaire.priority, BEHAVIOR_PRIORITIES.QUESTIONNAIRE);
  assert.equal(invalidQuestionnaire.questionnaire_allowed, false);
  assert.equal(invalidQuestionnaire.rag_allowed, false);
});

test("10A: privacy — no raw transcript, phone, or email in decision output", () => {
  const decision = decide({
    transcript: "Rufen Sie mich unter +491701234567 an oder mailen Sie test@example.com",
    intent: "callback_request",
    memory: { phone: "+491701234567", email: "test@example.com" },
    playbook: loadPlaybookOrThrow(),
  });
  const serialized = JSON.stringify(decision);
  assert.equal(serialized.includes("+491701234567"), false);
  assert.equal(serialized.includes("test@example.com"), false);
  assert.equal(serialized.includes("Rufen Sie mich"), false);
  assert.equal("transcript" in decision, false);

  const snapshot = JSON.parse(
    formatAgentBehaviorDecisionSnapshot({
      ...decision,
      transcript: "should not appear",
      caller_phone: "+491701234567",
    })
  );
  assert.equal(snapshot.transcript, undefined);
  assert.equal(snapshot.caller_phone, undefined);
  assert.ok(snapshot.priority);
});

test("10A: callback attention during finalized flow reassures caller", () => {
  const decision = decide({
    intent: "callback_flow_attention",
    callbackFlowState: CALLBACK_FLOW_STATES.CALLBACK_FINALIZED,
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(decision.priority, BEHAVIOR_PRIORITIES.CALLBACK_FLOW);
  assert.equal(decision.response_type, DECISION_RESPONSE_TYPES.CALLBACK_REASSURANCE);
  assert.equal(decision.next_action, "reassure_caller");
  assert.equal(decision.rag_allowed, false);
});

test("10A: callback finalized without attention uses post_call_notification", () => {
  const decision = decide({
    intent: "callback_permission_granted",
    callbackFlowState: CALLBACK_FLOW_STATES.CALLBACK_FINALIZED,
    playbook: loadPlaybookOrThrow(),
  });
  assert.equal(decision.next_action, "post_call_notification");
});

test("10A: decision runtime flag remains disabled (no live activation)", () => {
  assert.equal(isAgentBehaviorDecisionRuntimeEnabled(), false);
});
