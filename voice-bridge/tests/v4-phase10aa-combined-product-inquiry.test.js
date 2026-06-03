import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { createCallSessionMemory, setSelectedProduct } from "../src/v4/call-session-memory.js";
import { createStateMachine, V4_STATES } from "../src/v4/state-machine.js";
import { detectTranscriptIntent } from "../src/v4/transcript-intent.js";
import { resolveClosedDomainIntent } from "../src/v4/closed-domain-intent.js";
import {
  COMBINED_LIVE_TTS_CHAR_LIMIT,
  detectCombinedProductInquiry,
  buildPlaybookCombinedProductAnswer
} from "../src/v4/playbook-short-answer.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { shouldEnterSalesQualification } from "../src/v4/product-context-persistence.js";

const COMBINED_TRANSCRIPT =
  "Was ist Smart Website, was macht sie und was kostet sie?";

test("10AA: detects combined Smart Website inquiry facets", () => {
  const facets = detectCombinedProductInquiry(COMBINED_TRANSCRIPT);
  assert.equal(facets.isCombined, true);
  assert.equal(facets.whatIs, true);
  assert.equal(facets.howItWorks, true);
  assert.equal(facets.pricing, true);
});

test("10AA: combined answer is phone-ready and omits callback offer", () => {
  const config = loadConfig();
  const agentConfig = loadAgentConfig(config);
  const answer = buildPlaybookCombinedProductAnswer(agentConfig, "smart_website", COMBINED_TRANSCRIPT);
  assert.ok(answer);
  assert.ok(answer.length <= COMBINED_LIVE_TTS_CHAR_LIMIT);
  assert.match(answer, /Smart Website ist eine moderne Firmenwebsite/i);
  assert.match(answer, /Anfragen besser vor/i);
  assert.match(answer, /Preis hängt vom Umfang/i);
  assert.doesNotMatch(answer, /Rückruf|Beratung|Neukunde|bestehender Kunde/i);
});

test("10AA: combined inquiry does not enter sales qualification", () => {
  assert.equal(shouldEnterSalesQualification(COMBINED_TRANSCRIPT, "product_question"), false);
});

test("10AA: response plan uses combined_product_inquiry for multi-question Smart Website turn", () => {
  const config = loadConfig();
  const agentConfig = loadAgentConfig(config);
  const memory = createCallSessionMemory({ bridgeCallId: "10aa-combined" });
  const stateMachine = createStateMachine();
  const intent = detectTranscriptIntent(COMBINED_TRANSCRIPT, memory, agentConfig);
  const closedDomain = resolveClosedDomainIntent({ agentConfig, transcript: COMBINED_TRANSCRIPT, memory });
  const plan = buildResponsePlan({
    agentConfig,
    memory,
    stateMachine,
    transcript: COMBINED_TRANSCRIPT,
    intent,
    closedDomain
  });

  assert.equal(intent, "product_question");
  assert.equal(closedDomain.matched_product, "smart_website");
  assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
  assert.equal(plan.plan_reason, "combined_product_inquiry");
  assert.notEqual(plan.response_type, RESPONSE_TYPES.COLLECT_SALES_CONTEXT);
  assert.match(plan.text, /Preis hängt vom Umfang/i);
});

test("10AA: scoped follow-up with product context also uses combined answer", () => {
  const config = loadConfig();
  const agentConfig = loadAgentConfig(config);
  const memory = setSelectedProduct(createCallSessionMemory({ bridgeCallId: "10aa-scoped" }), "smart_website");
  memory.current_product_context = "smart_website";
  const plan = buildResponsePlan({
    agentConfig,
    memory,
    stateMachine: { state: V4_STATES.LISTENING },
    transcript: COMBINED_TRANSCRIPT,
    intent: "product_question",
    closedDomain: resolveClosedDomainIntent({
      agentConfig,
      transcript: COMBINED_TRANSCRIPT,
      memory
    })
  });

  assert.equal(plan.plan_reason, "combined_product_inquiry");
  assert.match(plan.text, /Anfragen besser vor/i);
});
