/**
 * Phase 10F — playbook-driven company and product content.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { loadTenantPlaybook } from "../src/v4/playbook-loader.js";
import { resolveBehaviorPolicy } from "../src/v4/behavior-policy.js";
import {
  resolveCompanyAnswer,
  resolveProductExplanation,
  resolveProductPricingAnswer,
  resolveProductFollowUpQuestion,
  isPlaybookProductContentRuntimeEnabled,
  filterPlaybookProductMatch,
} from "../src/v4/playbook-product-content.js";
import { isCompanyGeneralQuestion } from "../src/v4/company-general-intent.js";
import { isCallbackLeadCaptureRequest } from "../src/v4/role-boundary-intent.js";
import { COMBINED_LIVE_TTS_CHAR_LIMIT } from "../src/v4/playbook-short-answer.js";
import { buildResponsePlan, RESPONSE_TYPES, detectTranscriptIntent } from "../src/v4/response-planner.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";
import { runPlaybookEvalSuite } from "../src/v4/playbook-eval-scenarios.js";
import { BEHAVIOR_PRIORITIES, resolveAgentBehaviorDecision } from "../src/v4/agent-behavior-decision.js";
import { CALLBACK_FLOW_STATES } from "../src/v4/callback-flow-policy.js";
import { V4_STATES } from "../src/v4/state-machine.js";

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const finish = () => {
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

function loadPlaybookOrThrow() {
  const result = loadTenantPlaybook();
  assert.equal(result.ok, true, JSON.stringify(result.errors ?? result.error));
  return result.playbook;
}

function playbookRuntimeConfig() {
  const base = loadConfig();
  return {
    ...base,
    v4: {
      ...base.v4,
      playbookRuntimeEnabled: true,
      playbookAllowDraft: true,
    },
  };
}

function plannerArgs(transcript, overrides = {}) {
  const config = playbookRuntimeConfig();
  const playbook = loadPlaybookOrThrow();
  const behaviorPolicy = resolveBehaviorPolicy({ config, playbook, allowDraft: true });
  return {
    agentConfig: loadAgentConfig(config),
    memory: createCallSessionMemory({ bridgeCallId: "10f" }),
    stateMachine: { state: "listening" },
    transcript,
    config,
    behaviorPolicy,
    playbook,
    v4PathActive: true,
    ...overrides,
  };
}

test("10F: playbook runtime flag defaults off", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.v4.playbookRuntimeEnabled, false);
    assert.equal(isPlaybookProductContentRuntimeEnabled(config, null), false);
  });
});

test("10F: pure resolvers return TTS-safe approved content", () => {
  const playbook = loadPlaybookOrThrow();
  const company = resolveCompanyAnswer(playbook);
  assert.ok(company);
  assert.ok(company.length <= COMBINED_LIVE_TTS_CHAR_LIMIT);
  assert.match(company, /KI praktisch/i);
  assert.match(company, /\?/);

  for (const [productId, pattern] of [
    ["smart_website", /Assistent|Website/i],
    ["voice_agent", /Anruf|Telefon/i],
    ["aiseoq", /Ranking|SEO|Google/i],
    ["lokalki", /lokal|Dokument/i],
  ]) {
    const explanation = resolveProductExplanation(playbook, productId);
    assert.ok(explanation, productId);
    assert.ok(explanation.length <= COMBINED_LIVE_TTS_CHAR_LIMIT, productId);
    assert.match(explanation, pattern, productId);
  }

  const smartPricing = resolveProductPricingAnswer(playbook, "smart_website");
  assert.match(smartPricing, /Umfang/i);
  assert.doesNotMatch(smartPricing, /\b\d{2,}\s*(?:€|eur|euro)\b/i);

  const voicePricing = resolveProductPricingAnswer(playbook, "voice_agent");
  assert.match(voicePricing, /Anrufvolumen/i);
  assert.match(voicePricing, /65 Euro/i);
  assert.match(voicePricing, /hängt/i);

  const aiseoqPricing = resolveProductPricingAnswer(playbook, "aiseoq");
  assert.match(aiseoqPricing, /Anzahl der Seiten/i);
  assert.match(aiseoqPricing, /40 Euro/i);

  const followUps = [
    resolveProductFollowUpQuestion(playbook, "smart_website"),
    resolveProductFollowUpQuestion(playbook, "voice_agent"),
    resolveProductFollowUpQuestion(playbook, "aiseoq"),
  ].filter(Boolean);
  assert.ok(followUps.length >= 3);
  for (const question of followUps) {
    assert.equal((question.match(/\?/g) ?? []).length, 1);
  }
});

test("10F: company-general intent is narrow and excludes product-specific questions", () => {
  assert.equal(isCompanyGeneralQuestion("Was macht TechnoloHit?"), true);
  assert.equal(isCompanyGeneralQuestion("Was bietet TechnoloHit an?"), true);
  assert.equal(isCompanyGeneralQuestion("Was ist Smart Website?"), false);
  assert.equal(isCompanyGeneralQuestion("Wer hat die Relativitätstheorie entwickelt?"), false);
});

test("10F: flag off leaves planner output unchanged", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "false" }, () => {
    const config = loadConfig();
    const baseArgs = {
      agentConfig: loadAgentConfig(config),
      memory: createCallSessionMemory({ bridgeCallId: "10f-off" }),
      stateMachine: { state: "listening" },
      config,
      v4PathActive: true,
    };
    const companyPlan = buildResponsePlan({
      ...baseArgs,
      transcript: "Was macht TechnoloHit?",
    });
    assert.notEqual(companyPlan.response_type, RESPONSE_TYPES.COMPANY_GENERAL);
    assert.notEqual(companyPlan.plan_reason, "company_ecosystem_answer");

    const pricingPlan = buildResponsePlan({
      ...baseArgs,
      memory: setSelectedProduct(baseArgs.memory, "voice_agent"),
      transcript: "Was kostet der Voice Agent?",
    });
    assert.notEqual(pricingPlan.plan_reason, "playbook_product_explanation");
    assert.ok(companyPlan.text.length > 0);
    assert.ok(pricingPlan.text.length > 0);
  });
});

test("10F: company-general question uses playbook positioning when runtime enabled", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(plannerArgs("Was macht TechnoloHit?"));
    assert.equal(plan.response_type, RESPONSE_TYPES.COMPANY_GENERAL);
    assert.equal(plan.plan_reason, "company_ecosystem_answer");
    assert.match(plan.text, /KI praktisch/i);
    assert.match(plan.text, /\?/);
    assert.doesNotMatch(plan.text, /smart website/i);
    assert.equal(plan.rag_allowed, false);
    assert.equal(plan.lead_transition_allowed, false);
  });
});

test("10F: product explanations and pricing use approved playbook content", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const voiceExplain = buildResponsePlan(
      plannerArgs("Was ist der KI-Telefonassistent?", {
        memory: setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10f-va" }), "voice_agent"),
      })
    );
    assert.equal(voiceExplain.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
    assert.match(voiceExplain.text, /Anruf|Anliegen|Rückruf/i);

    const voicePrice = buildResponsePlan(
      plannerArgs("Was kostet der Voice Agent?", {
        memory: setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10f-vp" }), "voice_agent"),
      })
    );
    assert.equal(voicePrice.plan_reason, "product_pricing_fallback");
    assert.match(voicePrice.text, /Anrufvolumen/i);

    const aiseoqExplain = buildResponsePlan(
      plannerArgs("Was ist AiseoQ?", {
        memory: setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10f-aq" }), "aiseoq"),
      })
    );
    assert.match(aiseoqExplain.text, /Google|Sichtbarkeit|Wettbewerb/i);

    const aiseoqPrice = buildResponsePlan(
      plannerArgs("Was kostet AiseoQ?", {
        memory: setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10f-ap" }), "aiseoq"),
      })
    );
    assert.equal(aiseoqPrice.plan_reason, "product_pricing_fallback");
    assert.match(aiseoqPrice.text, /Anzahl der Seiten/i);

    const smartPrice = buildResponsePlan(
      plannerArgs("Was kostet die Smart Website?", {
        memory: setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10f-sw" }), "smart_website"),
      })
    );
    assert.match(smartPrice.text, /Umfang/i);
    assert.doesNotMatch(smartPrice.text, /\bgarantiert\b/i);
  });
});

test("10F: LokalKI answers only when directly asked", () => {
  const playbook = loadPlaybookOrThrow();
  assert.equal(filterPlaybookProductMatch(playbook, "lokalki", "Was ist Smart Website?"), null);
  assert.equal(filterPlaybookProductMatch(playbook, "lokalki", "Was ist LokalKI?"), "lokalki");

  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const direct = buildResponsePlan(plannerArgs("Was ist LokalKI?"));
    assert.match(direct.text, /lokalki|lokal|Dokument/i);

    const smartOnly = buildResponsePlan(plannerArgs("Was ist Smart Website?"));
    assert.doesNotMatch(smartOnly.text, /lokalki/i);
  });
});

test("10F: RAG success is preserved over playbook fallback", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const ragAnswer = "RAG-spezifische Antwort aus der Wissensbasis.";
    const plan = buildResponsePlan({
      ...plannerArgs("Was kostet die Smart Website?", {
        memory: setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10f-rag" }), "smart_website"),
      }),
      ragAnswer,
      ragResult: { used_rag: true, max_spoken_chars: 400 },
      ragGate: { allowed: true, used_rag: true },
    });
    assert.equal(plan.text, ragAnswer);
  });
});

test("10F: closing and callback still win over playbook product content", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const closing = buildResponsePlan(plannerArgs("Danke, das war alles."));
    assert.equal(closing.response_type, RESPONSE_TYPES.CLOSING);

    const callback = buildResponsePlan(plannerArgs("Bitte rufen Sie mich zurück."));
    assert.equal(callback.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
  });
});

test("10F: invalid playbook fails closed to hardcoded planner behavior", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const args = plannerArgs("Was macht TechnoloHit?");
    const broken = { ...args.playbook, company: { positioning_short: "" } };
    const plan = buildResponsePlan({ ...args, playbook: broken });
    assert.notEqual(plan.response_type, RESPONSE_TYPES.COMPANY_GENERAL);
    assert.ok(plan.text.length > 0);
  });
});

test("10F: product answers do not trigger questionnaire or lead_ready", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(
      plannerArgs("Was ist der KI-Telefonassistent?", {
        memory: setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10f-nq" }), "voice_agent"),
      })
    );
    assert.notEqual(plan.response_type, RESPONSE_TYPES.COLLECT_SALES_CONTEXT);
    assert.notEqual(plan.response_type, RESPONSE_TYPES.LEAD_READY_ACK);
    assert.equal(plan.questionnaire?.used, undefined);
    assert.equal(plan.lead_transition_allowed, false);
  });
});

test("10F: behavior decision metadata for company-general", () => {
  const decision = resolveAgentBehaviorDecision({
    transcript: "Was macht TechnoloHit?",
    memory: {},
    intent: "company_general",
    playbook: loadPlaybookOrThrow(),
    config: playbookRuntimeConfig(),
  });
  assert.equal(decision.priority, BEHAVIOR_PRIORITIES.COMPANY_GENERAL);
  assert.equal(decision.questionnaire_allowed, false);
  assert.equal(decision.rag_allowed, false);
});

test("10F: mixed company-general + callback enters callback flow", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const args = plannerArgs("Was macht TechnoloHit und können Sie mich bitte anrufen?");
    for (const transcript of [
      "Was macht TechnoloHit und können Sie mich bitte anrufen?",
      "Was macht TechnoloHit und koennen Sie mich bitte anrufen?",
      "Was bietet TechnoloHit an? Bitte rufen Sie mich zurück.",
      "Bitte rufen Sie mich zurück. Was macht TechnoloHit?",
    ]) {
      const plan = buildResponsePlan({ ...args, transcript });
      assert.equal(
        plan.response_type,
        RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE,
        transcript
      );
      assert.equal(plan.plan_reason, "callback_request_intent", transcript);
      assert.notEqual(plan.plan_reason, "company_ecosystem_answer", transcript);
      assert.equal(
        detectTranscriptIntent(
          transcript,
          {},
          args.agentConfig,
          args.behaviorPolicy,
          false,
          true
        ),
        "callback_request",
        transcript
      );
    }
  });
});

test("10F: callback modal variants with company-general yield callback flow", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const args = plannerArgs("Was macht TechnoloHit?");
    for (const callbackPhrase of [
      "können Sie mich anrufen",
      "koennen Sie mich anrufen",
      "könnten Sie mich anrufen",
      "koennten Sie mich anrufen",
      "kann mich jemand anrufen",
    ]) {
      const transcript = `Was macht TechnoloHit und ${callbackPhrase}?`;
      assert.equal(isCallbackLeadCaptureRequest(transcript), true, callbackPhrase);
      const plan = buildResponsePlan({ ...args, transcript });
      assert.equal(plan.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE, callbackPhrase);
      assert.equal(plan.plan_reason, "callback_request_intent", callbackPhrase);
    }
  });
});

test("10F: generic anrufen mentions are not callback requests", () => {
  const negatives = [
    "Kann der Voice Agent Kunden anrufen?",
    "Was bedeutet anrufen?",
  ];
  for (const transcript of negatives) {
    assert.equal(isCallbackLeadCaptureRequest(transcript), false, transcript);
    assert.notEqual(detectTranscriptIntent(transcript), "callback_request", transcript);
  }

  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const productPlan = buildResponsePlan(
      plannerArgs("Kann der Voice Agent Kunden anrufen?")
    );
    assert.notEqual(productPlan.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
    assert.notEqual(productPlan.plan_reason, "callback_request_intent");

    const generalPlan = buildResponsePlan(plannerArgs("Was bedeutet anrufen?"));
    assert.notEqual(generalPlan.plan_reason, "callback_request_intent");
    assert.notEqual(generalPlan.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
  });
});

test("10F: company-general-only still returns company_general", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(plannerArgs("Was macht TechnoloHit?"));
    assert.equal(plan.response_type, RESPONSE_TYPES.COMPANY_GENERAL);
    assert.equal(plan.plan_reason, "company_ecosystem_answer");
  });
});

test("10F: active callback permission + company phrase stays in callback flow", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const memory = {
      ...createCallSessionMemory({ bridgeCallId: "10f-cb-co" }),
      current_state: V4_STATES.COLLECTING_CALLBACK_PERMISSION,
      contact_preference: "phone",
      contact_flow_pending: true,
      callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_PERMISSION_PENDING,
    };
    const args = plannerArgs("Was macht TechnoloHit?", { memory });
    const plan = buildResponsePlan(args);
    assert.notEqual(plan.response_type, RESPONSE_TYPES.COMPANY_GENERAL);
    assert.notEqual(plan.plan_reason, "company_ecosystem_answer");
    assert.equal(plan.response_type, RESPONSE_TYPES.CALLBACK_REASSURANCE);
  });
});

test("10F: closing wins over mixed company-general and callback", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(
      plannerArgs("Danke, das war alles. Was macht TechnoloHit? Bitte rufen Sie mich zurück.")
    );
    assert.equal(plan.response_type, RESPONSE_TYPES.CLOSING);
  });
});

test("10F: explicit product question still overrides active callback flow", () => {
  withEnv({ VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "true" }, () => {
    const memory = {
      ...setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10f-prod-cb" }), "aiseoq"),
      callback_permission: "granted",
      contact_preference: "phone",
      callback_flow_state: CALLBACK_FLOW_STATES.CALLBACK_FINALIZED,
      current_state: V4_STATES.LISTENING,
    };
    const plan = buildResponsePlan(plannerArgs("Was ist AiseoQ?", { memory }));
    assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
    assert.notEqual(plan.response_type, RESPONSE_TYPES.COMPANY_GENERAL);
  });
});

test("10F: playbook eval includes mixed company+callback priority scenario", async () => {
  const playbook = loadPlaybookOrThrow();
  const suite = await runPlaybookEvalSuite({ playbook });
  const mixed = suite.results.find((entry) => entry.id === "company_general_with_callback_request");
  assert.ok(mixed, "missing eval scenario");
  assert.equal(mixed.status, "pass", mixed.reason);
  assert.equal(mixed.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
});

test("10F: playbook eval suite has zero fail and zero pending", async () => {
  const playbook = loadPlaybookOrThrow();
  const suite = await runPlaybookEvalSuite({ playbook });
  assert.equal(suite.summary.fail, 0, JSON.stringify(suite.results.filter((r) => r.status === "fail")));
  assert.equal(suite.summary.pending, 0);
  assert.equal(suite.ok, true);
});
