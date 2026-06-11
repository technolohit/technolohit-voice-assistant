/**
 * Phase 10D — questionnaire attachment guard from Agent Behavior Decision.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { isAgentBehaviorDecisionEnabled } from "../src/v4/agent-behavior-decision-runtime.js";
import { resetAgentBehaviorDecisionQuestionnaireGuardCache } from "../src/v4/agent-behavior-decision-questionnaire-guard.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import {
  applyQuestionnaireRuntimeToPlan,
  evaluateQuestionnaireRuntimeEligibility,
  questionnaireQualityPayload,
  resetQuestionnaireRuntimePlaybookCache,
  QUESTIONNAIRE_RUNTIME_BLOCK_REASONS,
} from "../src/v4/questionnaire-runtime.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";

const EMAIL_PATTERN = /@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_PATTERN = /\+?\d{10,}/;

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const finish = () => {
    resetQuestionnaireRuntimePlaybookCache();
    resetAgentBehaviorDecisionQuestionnaireGuardCache();
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

function bothFlagsConfig() {
  const base = loadConfig();
  return {
    ...base,
    v4: {
      ...base.v4,
      questionnaireRuntimeEnabled: true,
      agentBehaviorDecisionEnabled: true,
    },
  };
}

function basePlannerArgs(transcript, overrides = {}) {
  const config = bothFlagsConfig();
  const agentConfig = loadAgentConfig(config);
  return {
    agentConfig,
    memory: setSelectedProduct(createCallSessionMemory(), "smart_website"),
    stateMachine: { state: "listening" },
    transcript,
    config,
    v4PathActive: true,
    ...overrides,
  };
}

test("10D: decision flag off preserves questionnaire attachment", () => {
  withEnv(
    { VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true", VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED: "false" },
    () => {
      const config = loadConfig();
      const args = basePlannerArgs("Was ist Smart Website?", { config });
      const plan = buildResponsePlan(args);
      assert.equal(plan.questionnaire?.used, true);
      assert.ok(plan.follow_up_question);
    }
  );
});

test("10D: decision flag on blocks questionnaire on explicit product answer turn", () => {
  withEnv(
    {
      VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true",
      VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED: "true",
    },
    () => {
      const plan = buildResponsePlan(basePlannerArgs("Was ist Smart Website?"));
      assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
      assert.equal(plan.questionnaire?.used, false);
      assert.equal(
        plan.questionnaire?.block_reason,
        QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.BEHAVIOR_DECISION_DISALLOWED
      );
      assert.equal(plan.follow_up_question, undefined);
      assert.match(plan.text, /Smart Website/i);
      assert.doesNotMatch(plan.text, /Relaunch|Ziele|möchten Sie/i);
    }
  );
});

test("10D: product answer response type and next_state unchanged with guard", () => {
  withEnv(
    {
      VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true",
      VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED: "true",
    },
    () => {
      const withoutGuard = buildResponsePlan(
        basePlannerArgs("Was ist Smart Website?", {
          config: {
            ...loadConfig(),
            v4: { ...loadConfig().v4, questionnaireRuntimeEnabled: true, agentBehaviorDecisionEnabled: false },
          },
        })
      );
      const withGuard = buildResponsePlan(basePlannerArgs("Was ist Smart Website?"));
      assert.equal(withGuard.response_type, withoutGuard.response_type);
      assert.equal(withGuard.next_state, withoutGuard.next_state);
      assert.equal(withGuard.plan_reason, withoutGuard.plan_reason);
      const answerOnly = withoutGuard.text.replace(withoutGuard.follow_up_question ?? "", "").trim();
      assert.equal(withGuard.text.trim(), answerOnly);
    }
  );
});

test("10D: closing blocks questionnaire with decision guard enabled", () => {
  withEnv(
    {
      VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true",
      VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED: "true",
    },
    () => {
      const eligibility = evaluateQuestionnaireRuntimeEligibility({
        config: bothFlagsConfig(),
        v4PathActive: true,
        plan: {
          response_type: RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
          plan_reason: "combined_product_inquiry",
          text: "Antwort",
        },
        resolvedIntent: "closing",
        memory: setSelectedProduct(createCallSessionMemory(), "smart_website"),
        transcript: "Danke, das reicht.",
      });
      assert.equal(eligibility.allowed, false);
      assert.equal(eligibility.reason, QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.ROLE_BOUNDARY_INTENT);
    }
  );
});

test("10D: callback flow blocks questionnaire with decision guard enabled", () => {
  withEnv(
    {
      VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true",
      VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED: "true",
    },
    () => {
      const eligibility = evaluateQuestionnaireRuntimeEligibility({
        config: bothFlagsConfig(),
        v4PathActive: true,
        plan: {
          response_type: RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
          plan_reason: "combined_product_inquiry",
          text: "Antwort",
        },
        resolvedIntent: "callback_request",
        memory: setSelectedProduct(createCallSessionMemory(), "smart_website"),
        transcript: "Bitte rufen Sie mich zurück.",
      });
      assert.equal(eligibility.allowed, false);
      assert.equal(eligibility.reason, QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.CALLBACK_FLOW);
    }
  );
});

test("10D: invalid playbook fails closed for questionnaire when decision flag enabled", () => {
  withEnv(
    {
      VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true",
      VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED: "true",
    },
    () => {
      const basePlan = {
        response_type: RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
        plan_reason: "combined_product_inquiry",
        text: "Smart Website ist eine KI-gestützte Website-Lösung.",
      };
      const enriched = applyQuestionnaireRuntimeToPlan(basePlan, {
        config: bothFlagsConfig(),
        v4PathActive: true,
        resolvedIntent: "product_question",
        memory: setSelectedProduct(createCallSessionMemory(), "smart_website"),
        transcript: "Was ist Smart Website?",
        playbook: { playbook_version: "invalid", products: [] },
      });
      assert.equal(enriched.questionnaire?.used, false);
      assert.equal(
        enriched.questionnaire?.block_reason,
        QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.BEHAVIOR_DECISION_DISALLOWED
      );
    }
  );
});

test("10D: questionnaire metadata stays privacy-safe", () => {
  withEnv(
    {
      VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true",
      VOICE_V4_AGENT_BEHAVIOR_DECISION_ENABLED: "true",
    },
    () => {
      const plan = buildResponsePlan(basePlannerArgs("Was ist Smart Website?"));
      const payload = JSON.stringify(questionnaireQualityPayload(plan));
      assert.doesNotMatch(payload, /Was ist Smart Website/i);
      assert.doesNotMatch(payload, EMAIL_PATTERN);
      assert.doesNotMatch(payload, PHONE_PATTERN);
    }
  );
});

test("10D: default production flags unchanged", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(isAgentBehaviorDecisionEnabled(config), false);
    assert.equal(config.v4.agentBehaviorDecisionEnabled, false);
    assert.equal(config.v4.questionnaireRuntimeEnabled, false);
  });
});
