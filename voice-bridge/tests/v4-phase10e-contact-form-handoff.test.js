/**
 * Phase 10E — contact form handoff and voice-capture restrictions.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { BEHAVIOR_PRIORITIES, resolveAgentBehaviorDecision } from "../src/v4/agent-behavior-decision.js";
import {
  detectContactFormHandoffIntent,
  CONTACT_FORM_HANDOFF_INTENTS,
} from "../src/v4/contact-form-handoff-intent.js";
import {
  DEFAULT_CONTACT_FORM_HANDOFF_PHRASE,
  getContactFormHandoffResponse,
  isContactFormHandoffRuntimeEnabled,
  resetContactFormHandoffPlaybookCache,
} from "../src/v4/contact-form-handoff-policy.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { createCallSessionMemory } from "../src/v4/call-session-memory.js";
import { runDecisionEvalSuite } from "../src/v4/agent-behavior-decision-eval.js";

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
    resetContactFormHandoffPlaybookCache();
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

function handoffConfig() {
  const base = loadConfig();
  return {
    ...base,
    v4: { ...base.v4, contactFormHandoffEnabled: true },
  };
}

function plannerArgs(transcript, overrides = {}) {
  const config = handoffConfig();
  return {
    agentConfig: loadAgentConfig(config),
    memory: createCallSessionMemory({ bridgeCallId: "10e" }),
    stateMachine: { state: "listening" },
    transcript,
    config,
    v4PathActive: true,
    ...overrides,
  };
}

test("10E: flag defaults off", () => {
  withEnv({}, () => {
    const config = loadConfig();
    assert.equal(config.v4.contactFormHandoffEnabled, false);
    assert.equal(isContactFormHandoffRuntimeEnabled(config, true), false);
  });
});

test("10E: email offer by voice => contact_form_handoff", () => {
  withEnv({ VOICE_V4_CONTACT_FORM_HANDOFF_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(plannerArgs("Soll ich Ihnen meine E-Mail-Adresse durchgeben?"));
    assert.equal(plan.response_type, RESPONSE_TYPES.CONTACT_FORM_HANDOFF);
    assert.match(plan.text, /Kontaktformular/i);
    assert.doesNotMatch(plan.text, /buchstabi/i);
    assert.equal(plan.rag_allowed, false);
    assert.equal(plan.lead_transition_allowed, false);
  });
});

test("10E: website URL offer by voice => contact_form_handoff", () => {
  withEnv({ VOICE_V4_CONTACT_FORM_HANDOFF_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(
      plannerArgs("Ich kann Ihnen die Website-Adresse am Telefon vorlesen.")
    );
    assert.equal(plan.response_type, RESPONSE_TYPES.CONTACT_FORM_HANDOFF);
    assert.match(plan.text, /Kontaktformular/i);
    assert.doesNotMatch(plan.text, /www\./i);
  });
});

test("10E: complex details offer => contact_form_handoff", () => {
  withEnv({ VOICE_V4_CONTACT_FORM_HANDOFF_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(plannerArgs("Ich gebe Ihnen Keywords und Wettbewerber durch."));
    assert.equal(plan.response_type, RESPONSE_TYPES.CONTACT_FORM_HANDOFF);
    assert.match(plan.text, /Kontaktformular/i);
  });
});

test("10E: flag off leaves default planner behavior unchanged", () => {
  withEnv({ VOICE_V4_CONTACT_FORM_HANDOFF_ENABLED: "false" }, () => {
    const config = loadConfig();
    const plan = buildResponsePlan({
      ...plannerArgs("Soll ich Ihnen meine E-Mail-Adresse durchgeben?", { config, v4PathActive: true }),
    });
    assert.notEqual(plan.response_type, RESPONSE_TYPES.CONTACT_FORM_HANDOFF);
  });
});

test("10E: callback request still routes to callback flow", () => {
  withEnv({ VOICE_V4_CONTACT_FORM_HANDOFF_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(plannerArgs("Bitte rufen Sie mich zurück."));
    assert.equal(plan.response_type, RESPONSE_TYPES.COLLECT_CONTACT_PREFERENCE);
    assert.notEqual(plan.response_type, RESPONSE_TYPES.CONTACT_FORM_HANDOFF);
  });
});

test("10E: closing still wins over contact form handoff", () => {
  withEnv({ VOICE_V4_CONTACT_FORM_HANDOFF_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(
      plannerArgs("Danke, ich gebe Ihnen meine E-Mail später durch. Das war alles.")
    );
    assert.equal(plan.response_type, RESPONSE_TYPES.CLOSING);
  });
});

test("10E: does not create lead_ready", () => {
  withEnv({ VOICE_V4_CONTACT_FORM_HANDOFF_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(plannerArgs("Ich gebe Ihnen meine Website und E-Mail durch."));
    assert.notEqual(plan.response_type, RESPONSE_TYPES.LEAD_READY_ACK);
    assert.equal(plan.memory_patch?.lead_ready, false);
    assert.equal(plan.questionnaire?.used, undefined);
  });
});

test("10E: invalid playbook uses safe fallback phrase", () => {
  withEnv({ VOICE_V4_CONTACT_FORM_HANDOFF_ENABLED: "true" }, () => {
    const text = getContactFormHandoffResponse({
      intent: CONTACT_FORM_HANDOFF_INTENTS.EMAIL_OFFER_BY_VOICE,
      playbook: { playbook_version: "invalid", contact_capture_policy: {} },
    });
    assert.equal(text, DEFAULT_CONTACT_FORM_HANDOFF_PHRASE);
  });
});

test("10E: decision layer aligns with contact_form_handoff intent", () => {
  const decision = resolveAgentBehaviorDecision({
    intent: CONTACT_FORM_HANDOFF_INTENTS.EMAIL_OFFER_BY_VOICE,
    memory: {},
    playbook: null,
  });
  assert.equal(decision.priority, BEHAVIOR_PRIORITIES.CONTACT_FORM_HANDOFF);
  assert.equal(decision.response_type, RESPONSE_TYPES.CONTACT_FORM_HANDOFF);
  assert.equal(decision.rag_allowed, false);
  assert.equal(decision.questionnaire_allowed, false);
});

test("10E: privacy — no raw email/domain/phone in plan metadata", () => {
  withEnv({ VOICE_V4_CONTACT_FORM_HANDOFF_ENABLED: "true" }, () => {
    const plan = buildResponsePlan(plannerArgs("Soll ich Ihnen meine E-Mail-Adresse durchgeben?"));
    const snapshot = JSON.stringify({
      response_type: plan.response_type,
      plan_reason: plan.plan_reason,
      text_chars: plan.text?.length ?? 0,
    });
    assert.doesNotMatch(snapshot, EMAIL_PATTERN);
    assert.doesNotMatch(snapshot, PHONE_PATTERN);
    assert.doesNotMatch(snapshot, /durchgeben/i);
  });
});

test("10E: intent detection helpers", () => {
  assert.equal(
    detectContactFormHandoffIntent("Soll ich Ihnen meine E-Mail-Adresse durchgeben?"),
    CONTACT_FORM_HANDOFF_INTENTS.EMAIL_OFFER_BY_VOICE
  );
  assert.equal(detectContactFormHandoffIntent("Bitte rufen Sie mich zurück."), null);
});

test("10E: full decision eval suite is 13 pass / 0 fail / 0 pending", async () => {
  const suite = await runDecisionEvalSuite();
  assert.equal(suite.summary.pass, 13);
  assert.equal(suite.summary.fail, 0);
  assert.equal(suite.summary.pending, 0);
  assert.equal(suite.ok, true);
});
