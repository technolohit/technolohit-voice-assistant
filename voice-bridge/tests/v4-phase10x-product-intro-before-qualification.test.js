import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { loadAgentConfig } from "../src/v4/agent-config.js";
import { createCallSessionMemory } from "../src/v4/call-session-memory.js";
import { createStateMachine, V4_STATES } from "../src/v4/state-machine.js";
import { detectTranscriptIntent } from "../src/v4/transcript-intent.js";
import { resolveClosedDomainIntent } from "../src/v4/closed-domain-intent.js";
import { buildResponsePlan, RESPONSE_TYPES } from "../src/v4/response-planner.js";
import { shouldEnterSalesQualification } from "../src/v4/product-context-persistence.js";
import {
  acceptUserTranscript,
  commitAssistantPlanWithoutPlayback,
  createDialogueOrchestrator,
  decideNextAction,
  startTurn
} from "../src/v4/dialogue-orchestrator.js";

function planFor(transcript) {
  const config = loadConfig();
  const agentConfig = loadAgentConfig(config);
  const memory = createCallSessionMemory({ bridgeCallId: "10x-product-intro" });
  const stateMachine = createStateMachine();
  const intent = detectTranscriptIntent(transcript, memory, agentConfig);
  const closedDomain = resolveClosedDomainIntent({ agentConfig, transcript, memory });
  const plan = buildResponsePlan({
    agentConfig,
    memory,
    stateMachine,
    transcript,
    intent,
    closedDomain
  });
  return { intent, closedDomain, plan };
}

for (const transcript of [
  "Hallo, ich interessiere mich für die Smart Website.",
  "Hallo, ich interessiere mich für die Smart-Webseite.",
  "Ich interessiere mich für die smarte Webseite."
]) {
  test(`10X: product opening introduces Smart Website before qualification: ${transcript}`, () => {
    const { intent, closedDomain, plan } = planFor(transcript);
    assert.equal(intent, "product_selection");
    assert.equal(closedDomain.matched_product, "smart_website");
    assert.equal(plan.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
    assert.notEqual(plan.response_type, RESPONSE_TYPES.FALLBACK_CLARIFICATION);
    assert.notEqual(plan.response_type, RESPONSE_TYPES.COLLECT_SALES_CONTEXT);
    assert.equal(plan.plan_reason, "product_selection_intro");
    assert.equal(plan.memory_patch.selected_product_id, "smart_website");
    assert.equal(plan.memory_patch.current_product_context, "smart_website");
  });
}

test("10X: product selection alone is not a sales qualification signal", () => {
  assert.equal(
    shouldEnterSalesQualification("Ich interessiere mich für die Smart Website.", "product_selection"),
    false
  );
});

test("10X: explicit project discussion may enter sales qualification", () => {
  assert.equal(
    shouldEnterSalesQualification("Ich möchte ein Projekt besprechen.", "product_selection"),
    true
  );
});

test("10X: explicit customer type remains a qualification signal", () => {
  assert.equal(shouldEnterSalesQualification("Wir sind Neukunde.", "sales_customer_type"), true);
});

test("10X: response plan telemetry uses post-plan product context", async () => {
  const config = loadConfig();
  const agentConfig = loadAgentConfig(config);
  const memory = createCallSessionMemory({ bridgeCallId: "10x-telemetry" });
  const stateMachine = { state: V4_STATES.LISTENING };
  const events = [];
  const orchestrator = createDialogueOrchestrator({
    config,
    runtimeContext: { agentConfig, memory, stateMachine },
    memory,
    stateMachine,
    agentConfig,
    qualitySink: {
      v4PathActive: true,
      bufferQualityEvent(event) {
        events.push(event);
        return { ok: true };
      }
    },
    v4PathActive: true
  });

  const transcript = "Hallo, ich interessiere mich für die Smart Website.";
  startTurn(orchestrator);
  acceptUserTranscript(orchestrator, transcript);
  const action = await decideNextAction(orchestrator, { transcript });
  commitAssistantPlanWithoutPlayback(orchestrator, action.plan.text, action.plan);

  const event = events.find((candidate) => candidate.eventType === "response_plan_created");
  assert.ok(event);
  assert.equal(event.payload.response_type, RESPONSE_TYPES.PRODUCT_QUESTION_ANSWER);
  assert.equal(event.payload.current_product_context, "smart_website");
  assert.equal(event.payload.matched_product, "smart_website");
  assert.equal(event.payload.plan_reason, "product_selection_intro");
});
