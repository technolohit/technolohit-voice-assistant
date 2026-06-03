import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";
import { createStateMachine, V4_STATES } from "../src/v4/state-machine.js";
import { detectTranscriptIntent, sanitizeResponseText } from "../src/v4/transcript-intent.js";
import { resolveClosedDomainIntent } from "../src/v4/closed-domain-intent.js";
import {
  COMBINED_LIVE_TTS_CHAR_LIMIT,
  SMART_WEBSITE_COMBINED_LIVE_ANSWER,
  buildPlaybookCombinedProductAnswer,
  detectCombinedProductInquiry
} from "../src/v4/playbook-short-answer.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { shouldEnterSalesQualification } from "../src/v4/product-context-persistence.js";
import {
  maxLiveResponseChars,
  prepareLiveAssistantSpeechText
} from "../src/v4/live-tts-playback-endpoint.js";

const TRANSCRIPT_VARIANTS = [
  "Was ist Smart Website, was macht sie und was kostet sie?",
  "Was ist die Smart-Webseite und was kostet sie?",
  "Was macht die smarte Webseite und wie viel kostet das?"
];

function buildCombinedInquiryPlan(transcript) {
  const config = loadConfig();
  const agentConfig = loadAgentConfig(config);
  const memory = createCallSessionMemory({ bridgeCallId: "10ab-live-tts" });
  const intent = detectTranscriptIntent(transcript, memory, agentConfig);
  const closedDomain = resolveClosedDomainIntent({ agentConfig, transcript, memory });
  const plan = buildResponsePlan({
    agentConfig,
    memory,
    stateMachine: createStateMachine(),
    transcript,
    intent,
    closedDomain
  });
  return { config, plan, intent, closedDomain };
}

test("10AB: Smart Website combined live answer fits default TTS limit", () => {
  assert.ok(SMART_WEBSITE_COMBINED_LIVE_ANSWER.length <= COMBINED_LIVE_TTS_CHAR_LIMIT);
});

test("10AB: sanitizeResponseText fixes Rückruf article to eine Kontaktaufnahme", () => {
  assert.equal(
    sanitizeResponseText("Möchten Sie dazu einen Rückruf oder eine kurze Beratung?"),
    "Möchten Sie dazu eine Kontaktaufnahme oder eine kurze Beratung?"
  );
  assert.doesNotMatch(
    sanitizeResponseText("Möchten Sie dazu einen Rückruf oder eine kurze Beratung?"),
    /einen Kontaktaufnahme/
  );
});

for (const transcript of TRANSCRIPT_VARIANTS) {
  test(`10AB: live-heard combined inquiry passes TTS prep: ${transcript}`, () => {
    const { config, plan, intent, closedDomain } = buildCombinedInquiryPlan(transcript);
    assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
    assert.equal(plan.plan_reason, "combined_product_inquiry");
    assert.notEqual(plan.response_type, RESPONSE_TYPES.COLLECT_SALES_CONTEXT);
    assert.equal(shouldEnterSalesQualification(transcript, intent), false);
    assert.equal(closedDomain.matched_product, "smart_website");

    const prepared = prepareLiveAssistantSpeechText(config, plan.text);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.usedFallback, false);
    assert.ok(prepared.text);
    assert.doesNotMatch(prepared.text, /…/);
    assert.ok(prepared.text.length <= maxLiveResponseChars(config));
    assert.match(prepared.text, /Smart Website ist eine moderne Firmenwebsite/i);
    assert.match(prepared.text, /Anfragen besser vor|Anfragen vor/i);
    assert.match(prepared.text, /Preis hängt vom Umfang/i);
    assert.doesNotMatch(prepared.text, /Neukunde|bestehender Kunde/i);
  });
}

test("10AB: scoped product context keeps combined answer audible on live path", () => {
  const config = loadConfig();
  const agentConfig = loadAgentConfig(config);
  const transcript = TRANSCRIPT_VARIANTS[0];
  const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10ab-scoped" }), "smart_website");
  memory.current_product_context = "smart_website";
  const plan = buildResponsePlan({
    agentConfig,
    memory,
    stateMachine: { state: V4_STATES.LISTENING },
    transcript,
    intent: "product_question",
    closedDomain: resolveClosedDomainIntent({ agentConfig, transcript, memory })
  });
  const prepared = prepareLiveAssistantSpeechText(config, plan.text);
  assert.equal(plan.plan_reason, "combined_product_inquiry");
  assert.equal(prepared.text, SMART_WEBSITE_COMBINED_LIVE_ANSWER);
});

test("10AB: default prepared live TTS text snapshot", () => {
  const config = loadConfig();
  const answer = buildPlaybookCombinedProductAnswer(
    loadAgentConfig(config),
    "smart_website",
    TRANSCRIPT_VARIANTS[0]
  );
  const prepared = prepareLiveAssistantSpeechText(config, answer);
  assert.equal(prepared.text, SMART_WEBSITE_COMBINED_LIVE_ANSWER);
  assert.equal(prepared.text.length, SMART_WEBSITE_COMBINED_LIVE_ANSWER.length);
});
