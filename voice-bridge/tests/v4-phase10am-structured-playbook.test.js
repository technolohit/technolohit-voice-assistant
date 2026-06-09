import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  loadTenantPlaybook,
  resolvePlaybookPath,
  validatePlaybook,
  PLAYBOOK_REQUIRED_TOP_LEVEL_FIELDS,
} from "../src/v4/playbook-loader.js";
import { isClosingIntent } from "../src/v4/closing-intent.js";

const REQUIRED_CLOSING_PHRASES = [
  "Danke, das reicht erstmal.",
  "Passt so, danke.",
  "Danke, passt.",
  "Tschüss.",
  "Auf Wiederhören.",
  "Ich habe keine weiteren Fragen.",
  "Das war's.",
  "Stopp, danke, tschüss.",
];

function loadPlaybookOrThrow() {
  const result = loadTenantPlaybook();
  assert.equal(result.ok, true, JSON.stringify(result.errors ?? result.error));
  return result.playbook;
}

test("10AM: playbook JSON exists and parses", () => {
  const playbookPath = resolvePlaybookPath();
  assert.ok(fs.existsSync(playbookPath), `playbook missing at ${playbookPath}`);
  const parsed = JSON.parse(fs.readFileSync(playbookPath, "utf8"));
  assert.equal(typeof parsed, "object");
});

test("10AM: required top-level fields exist and validator passes", () => {
  const playbook = loadPlaybookOrThrow();
  for (const field of PLAYBOOK_REQUIRED_TOP_LEVEL_FIELDS) {
    assert.ok(field in playbook, `missing top-level field: ${field}`);
  }
  assert.equal(playbook.tenant_id, "technolohit");
  assert.equal(playbook.agent_id, "main_voice_sales");
  assert.equal(playbook.status, "draft");
  assert.ok(playbook.playbook_version.length > 0);
  const validation = validatePlaybook(playbook);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
});

test("10AM: playbook is not runtime-active", () => {
  const playbook = loadPlaybookOrThrow();
  assert.equal(playbook.runtime_binding.active, false);
  assert.equal(playbook.approval.approved_for_runtime, false);
  const invalid = validatePlaybook({
    ...playbook,
    runtime_binding: { active: true },
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.includes("draft_playbook_must_not_be_runtime_active"));
});

test("10AM: all three required products exist with aliases", () => {
  const playbook = loadPlaybookOrThrow();
  const byId = new Map(playbook.products.map((product) => [product.id, product]));
  for (const id of ["smart_website", "voice_agent", "lokalki"]) {
    const product = byId.get(id);
    assert.ok(product, `missing product: ${id}`);
    assert.ok(product.aliases.length > 0, `missing aliases: ${id}`);
    assert.ok(product.short_explanation.length > 0, `missing explanation: ${id}`);
  }
  assert.equal(byId.get("voice_agent").display_name, "Digitale Rezeption");
});

test("10AM: closing policy includes Phase 10AK phrases and contract response", () => {
  const playbook = loadPlaybookOrThrow();
  const phrases = playbook.closing_policy.phrases;
  for (const phrase of REQUIRED_CLOSING_PHRASES) {
    assert.ok(phrases.includes(phrase), `missing closing phrase: ${phrase}`);
    assert.equal(isClosingIntent(phrase), true, `runtime closing detection disagrees: ${phrase}`);
  }
  assert.equal(
    playbook.closing_policy.response,
    "Sehr gerne. Dann wünsche ich Ihnen noch einen schönen Tag. Auf Wiederhören."
  );
  assert.equal(playbook.closing_policy.priority, "highest");
  for (const override of ["rag", "fallback_clarification", "product_continuation", "lead_capture"]) {
    assert.ok(playbook.closing_policy.overrides.includes(override), `missing override: ${override}`);
  }
  assert.equal(
    playbook.closing_policy.context_sensitive_stop.during_playback,
    "barge_in_interruption_wait"
  );
});

test("10AM: role boundary disallows general chatbot behavior", () => {
  const playbook = loadPlaybookOrThrow();
  assert.equal(playbook.role.is_general_chatbot, false);
  const boundaries = playbook.role.boundaries.join(" ");
  assert.match(boundaries, /allgemeiner Chatbot/i);
  assert.match(boundaries, /keine exakten Preise erfinden/i);
  const disallowed = playbook.disallowed_topics.join(" ");
  assert.match(disallowed, /Allgemeinwissen/i);
  assert.match(disallowed, /Rechtsberatung/i);
});

test("10AM: pricing policy forbids invented fixed prices", () => {
  const playbook = loadPlaybookOrThrow();
  assert.equal(playbook.pricing_policy.no_invented_fixed_prices, true);
  assert.equal(playbook.pricing_policy.pricing_is_scope_dependent, true);
  assert.match(playbook.pricing_policy.scope_language, /Umfang/);
  const rules = playbook.pricing_policy.rules.join(" ");
  assert.match(rules, /niemals exakte Preise erfinden/i);
});

test("10AM: lead capture policy answers first and captures only when appropriate", () => {
  const playbook = loadPlaybookOrThrow();
  assert.equal(playbook.lead_capture_policy.answer_first, true);
  assert.equal(playbook.lead_capture_policy.capture_only_when_appropriate, true);
  assert.ok(playbook.lead_capture_policy.appropriate_when.length >= 3);
  const never = playbook.lead_capture_policy.never_when.join(" ");
  assert.match(never, /nach jeder Produktfrage/i);
  assert.match(never, /RAG/);
  assert.equal(playbook.callback_policy.no_live_transfer_claims, true);
});

test("10AM: eval scenarios cover required categories", () => {
  const playbook = loadPlaybookOrThrow();
  const categories = new Set(playbook.eval_scenarios.map((scenario) => scenario.category));
  for (const category of ["closing", "out_of_scope", "technical_escalation", "pricing", "callback", "fallback"]) {
    assert.ok(categories.has(category), `missing eval scenario category: ${category}`);
  }
  for (const scenario of playbook.eval_scenarios) {
    assert.ok(scenario.id, "scenario missing id");
    if (scenario.category === "questionnaire") {
      assert.ok(scenario.caller_intent, `scenario missing caller_intent: ${scenario.id}`);
    } else {
      assert.ok(scenario.caller, `scenario missing caller transcript: ${scenario.id}`);
    }
    assert.ok(scenario.expected, `scenario missing expected: ${scenario.id}`);
  }
});

test("10AM: validator flags missing fields and invalid status", () => {
  const missing = validatePlaybook({ tenant_id: "technolohit" });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.startsWith("missing_field:")));

  const playbook = loadPlaybookOrThrow();
  const badStatus = validatePlaybook({ ...playbook, status: "live" });
  assert.equal(badStatus.ok, false);
  assert.ok(badStatus.errors.includes("invalid_status:live"));
});
