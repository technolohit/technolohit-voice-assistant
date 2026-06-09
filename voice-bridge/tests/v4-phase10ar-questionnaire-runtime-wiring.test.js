import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import {
  applyQuestionnaireRuntimeToPlan,
  evaluateQuestionnaireRuntimeEligibility,
  isQuestionnaireRuntimeEnabled,
  questionnaireQualityPayload,
  resetQuestionnaireRuntimePlaybookCache,
  QUESTIONNAIRE_RUNTIME_BLOCK_REASONS,
} from "../src/v4/questionnaire-runtime.js";
import { COMBINED_LIVE_TTS_CHAR_LIMIT } from "../src/v4/playbook-short-answer.js";
import { validateCallbackReadyLead } from "../src/v4/lead-validator.js";
import {
  runPlaybookEvalSuite,
  loadDefaultPlaybookEvalSuite,
  formatEvalSuiteSnapshot,
} from "../src/v4/playbook-eval-scenarios.js";
import {
  createDialogueOrchestrator,
  startTurn,
  acceptUserTranscript,
  decideNextAction,
  commitAssistantPlanWithoutPlayback,
} from "../src/v4/dialogue-orchestrator.js";
import { createRuntimeContext } from "../src/v4/runtime-context.js";
import { createQualityEventSink } from "../src/v4/quality-event-sink.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const finish = () => {
    resetQuestionnaireRuntimePlaybookCache();
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

function questionnaireOnConfig() {
  return {
    v4: {
      questionnaireRuntimeEnabled: true,
    },
  };
}

function basePlannerArgs(transcript, overrides = {}) {
  const config = loadConfig();
  const agentConfig = loadAgentConfig(config);
  return {
    agentConfig,
    memory: setSelectedProduct(createCallSessionMemory(), "smart_website"),
    stateMachine: { state: "listening" },
    transcript,
    config: questionnaireOnConfig(),
    v4PathActive: true,
    ...overrides,
  };
}

test("10AR: questionnaire runtime flag defaults off", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.v4.questionnaireRuntimeEnabled, false);
    assert.equal(isQuestionnaireRuntimeEnabled(config), false);
  });
});

test("10AR: flag off leaves response plan unchanged", () => {
  withEnv({ VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "false" }, () => {
    const args = basePlannerArgs("Was ist Smart Website?", { config: loadConfig(), v4PathActive: true });
    const plan = buildResponsePlan(args);
    assert.equal(plan.questionnaire, undefined);
    assert.equal(plan.follow_up_question, undefined);
    assert.match(plan.text, /Smart Website/i);
  });
});

test("10AR: flag on + Smart Website product answer adds one safe follow-up", () => {
  withEnv({ VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(basePlannerArgs("Was ist Smart Website?"));
    assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
    assert.equal(plan.questionnaire?.used, true);
    assert.equal(plan.questionnaire?.question_count, 1);
    assert.ok(plan.follow_up_question);
    assert.match(plan.follow_up_question, /Website|Relaunch|Ziele/i);
    assert.match(plan.text, /Smart Website/i);
    assert.match(plan.text, /Website|Relaunch|Ziele|möchten/i);
  });
});

test("10AR: flag on + pricing answer keeps answer first then soft question when length safe", () => {
  withEnv({ VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(basePlannerArgs("Was kostet die Smart Website?"));
    assert.equal(plan.plan_reason, "product_pricing_fallback");
    assert.match(plan.text, /Umfang|individuell|kalkuliert/i);
    assert.equal(plan.questionnaire?.used, true);
    const answerOnly = plan.text.replace(plan.follow_up_question ?? "", "").trim();
    assert.ok(answerOnly.length > 0);
    assert.ok(plan.text.length >= answerOnly.length);
  });
});

test("10AR: closing blocks questionnaire runtime", () => {
  withEnv({ VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(
      basePlannerArgs("Danke, das reicht erstmal.", {
        memory: setSelectedProduct(createCallSessionMemory(), "smart_website"),
      })
    );
    assert.equal(plan.response_type, RESPONSE_TYPES.CLOSING);
    assert.notEqual(plan.questionnaire?.used, true);
  });
});

test("10AR: out-of-scope and technical escalation block questionnaire", () => {
  withEnv({ VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true" }, () => {
    for (const transcript of [
      "Wer hat die Relativitätstheorie entwickelt?",
      "Können Sie LokalKI mit SAP über Middleware verbinden?",
    ]) {
      const plan = buildResponsePlan(basePlannerArgs(transcript));
      assert.notEqual(plan.questionnaire?.used, true, transcript);
    }
  });
});

test("10AR: callback request uses contact preference flow without lead_ready", () => {
  withEnv({ VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(basePlannerArgs("Können Sie mich zurückrufen lassen?"));
    assert.equal(plan.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
    assert.equal(plan.lead_transition_allowed, false);
    assert.notEqual(plan.questionnaire?.used, true);
    const validation = validateCallbackReadyLead({}, { source: "questionnaire_runtime" });
    assert.equal(validation.allowed, false);
  });
});

test("10AR: long product answer does not get truncated by appended questionnaire", () => {
  withEnv({ VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true" }, () => {
    const longAnswer = "A".repeat(COMBINED_LIVE_TTS_CHAR_LIMIT - 5);
    const basePlan = {
      response_type: RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
      text: longAnswer,
      plan_reason: "scoped_product_qa",
      max_spoken_chars: COMBINED_LIVE_TTS_CHAR_LIMIT,
      memory_patch: { selected_product_id: "smart_website" },
    };
    const enriched = applyQuestionnaireRuntimeToPlan(basePlan, {
      config: questionnaireOnConfig(),
      v4PathActive: true,
      resolvedIntent: "product_question",
      memory: setSelectedProduct(createCallSessionMemory(), "smart_website"),
      transcript: "Erzählen Sie mehr.",
    });
    assert.equal(enriched.text, longAnswer);
    assert.equal(enriched.questionnaire?.used, true);
    assert.equal(enriched.questionnaire?.spoken_attached, false);
    assert.equal(enriched.questionnaire?.block_reason, QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.LENGTH_LIMIT);
    assert.ok(enriched.follow_up_question);
  });
});

test("10AR: duplicate response guard blocks questionnaire", () => {
  const answer = "Smart Website ist eine moderne Firmenwebsite.";
  const eligibility = evaluateQuestionnaireRuntimeEligibility({
    config: questionnaireOnConfig(),
    v4PathActive: true,
    plan: {
      response_type: RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
      text: answer,
      plan_reason: "combined_product_inquiry",
    },
    resolvedIntent: "product_question",
    memory: { selected_product_id: "smart_website" },
    lastAssistantText: answer,
  });
  assert.equal(eligibility.allowed, false);
  assert.equal(eligibility.reason, QUESTIONNAIRE_RUNTIME_BLOCK_REASONS.DUPLICATE_RESPONSE);
});

test("10AR: quality payload contains safe questionnaire fields only", async () => {
  await withEnv({ VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true" }, async () => {
    const config = { ...loadConfig(), v4: { ...loadConfig().v4, questionnaireRuntimeEnabled: true } };
    const events = [];
    const orchestrator = createDialogueOrchestrator({
      config,
      runtimeContext: createRuntimeContext(config, { bridgeCallId: "qa-10ar" }),
      memory: setSelectedProduct(createCallSessionMemory({ bridgeCallId: "qa-10ar" }), "smart_website"),
      stateMachine: { state: "listening" },
      agentConfig: loadAgentConfig(config),
      qualitySink: createQualityEventSink({ v4PathActive: true }),
      v4PathActive: true,
    });
    const originalBuffer = orchestrator.qualitySink.bufferQualityEvent.bind(orchestrator.qualitySink);
    orchestrator.qualitySink.bufferQualityEvent = (event) => {
      events.push(event);
      return originalBuffer(event);
    };

    startTurn(orchestrator);
    acceptUserTranscript(orchestrator, "Was ist Smart Website?");
    const action = await decideNextAction(orchestrator, { transcript: "Was ist Smart Website?" });
    commitAssistantPlanWithoutPlayback(orchestrator);

    const planEvent = events.find((entry) => entry.eventType === "response_plan_created");
    assert.ok(planEvent);
    assert.equal(planEvent.payload.questionnaire_enabled, true);
    assert.equal(typeof planEvent.payload.questionnaire_used, "boolean");
    assert.equal(planEvent.payload.questionnaire_product_id, "smart_website");
    const serialized = JSON.stringify(events.map((entry) => entry.payload));
    assert.equal(serialized.includes("Was ist Smart Website?"), false);
    assert.equal(/\+\d{7,}/.test(serialized), false);
    assert.equal(/@\w+\.\w+/.test(serialized), false);
    if (planEvent.payload.questionnaire_follow_up_preview) {
      assert.ok(planEvent.payload.questionnaire_follow_up_preview.length <= 80);
    }
  });
});

test("10AR: questionnaireQualityPayload omits fields when runtime disabled", () => {
  const payload = questionnaireQualityPayload({
    response_type: RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER,
    text: "Antwort",
  });
  assert.deepEqual(payload, {});
});

test("10AR: v3 defaults unchanged", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.v4.runtimeVersion, "v3");
    assert.equal(config.v4.questionnaireRuntimeEnabled, false);
    assert.equal(config.v4.playbookRuntimeEnabled, false);
    assert.equal(config.rag?.enabled ?? false, false);
  });
});

test("10AR: playbook eval suite still passes 16/16", async () => {
  const loaded = loadDefaultPlaybookEvalSuite();
  const suite = await runPlaybookEvalSuite({ playbook: loaded.playbook });
  assert.equal(suite.ok, true);
  assert.equal(suite.summary.fail, 0);
  assert.equal(suite.summary.pass, suite.summary.total);
  assert.ok(suite.summary.total >= 16);
  const snapshot = JSON.parse(formatEvalSuiteSnapshot(suite));
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("Wer hat die Relativitätstheorie"), false);
});

test("10AR: voice agent product answer gets relevant follow-up when enabled", () => {
  withEnv({ VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(
      basePlannerArgs("Was ist die digitale Rezeption?", {
        memory: setSelectedProduct(createCallSessionMemory(), "voice_agent"),
      })
    );
    assert.equal(plan.questionnaire?.used, true);
    assert.match(plan.follow_up_question ?? "", /Anruf|Anliegen|telefonisch/i);
  });
});

test("10AR: product intro before qualification does not trigger questionnaire", () => {
  withEnv({ VOICE_V4_QUESTIONNAIRE_RUNTIME_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(
      basePlannerArgs("Smart Website", {
        memory: createCallSessionMemory(),
      })
    );
    assert.notEqual(plan.questionnaire?.used, true);
  });
});
