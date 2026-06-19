/**
 * Phase 9 (v3 blueprint) — Product Playbook Consolidation tests.
 *
 * Consolidation/validation only: verifies the founder-approved Markdown
 * playbook content is represented in the machine-readable runtime playbook,
 * that the strengthened validator rejects unsafe/incomplete playbooks, and
 * that everything stays runtime-inactive (no live behavior change).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import {
  loadTenantPlaybook,
  validatePlaybook,
  REQUIRED_PLAYBOOK_PRODUCT_IDS,
  PRICING_POLICY_REQUIRED_PRODUCT_IDS,
  REQUIRED_LEAD_TIERS,
} from "../src/v4/playbook-loader.js";
import {
  resolveBehaviorPolicy,
  HARDCODED_BEHAVIOR_DEFAULTS,
} from "../src/v4/behavior-policy.js";
import {
  runPlaybookEvalSuite,
  formatEvalSuiteSnapshot,
} from "../src/v4/playbook-eval-scenarios.js";

const PHASE9_EVAL_COVERAGE_CATEGORIES = [
  "company_general_question",
  "smart_website_explanation",
  "smart_website_price",
  "voice_agent_explanation",
  "voice_agent_price",
  "aiseoq_explanation",
  "aiseoq_price",
  "callback_request_after_product_answer",
  "contact_form_handoff",
  "no_email_capture_by_voice",
  "no_website_url_capture_by_voice",
  "closing",
];

function loadPlaybookOrThrow() {
  const result = loadTenantPlaybook();
  assert.equal(result.ok, true, JSON.stringify(result.errors ?? result.error));
  return result.playbook;
}

function withoutProduct(playbook, productId) {
  return {
    ...playbook,
    products: playbook.products.filter((product) => product.id !== productId),
  };
}

function withProductPatch(playbook, productId, patch) {
  return {
    ...playbook,
    products: playbook.products.map((product) =>
      product.id === productId ? { ...product, ...patch } : product
    ),
  };
}

test("phase9: consolidated playbook loads and validates successfully", () => {
  const playbook = loadPlaybookOrThrow();
  const validation = validatePlaybook(playbook);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.ok(playbook.playbook_version.length > 0);
  assert.equal(playbook.source_of_truth.human_approved_markdown, "docs/TechnoloHit Product Playbook v1.md");
});

test("phase9: missing or empty playbook_version fails validation", () => {
  const playbook = loadPlaybookOrThrow();

  const { playbook_version, ...withoutVersion } = playbook;
  const missing = validatePlaybook(withoutVersion);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.includes("missing_field:playbook_version"));

  const empty = validatePlaybook({ ...playbook, playbook_version: "  " });
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.includes("playbook_version_empty"));
});

test("phase9: missing required product fails validation", () => {
  const playbook = loadPlaybookOrThrow();
  for (const productId of REQUIRED_PLAYBOOK_PRODUCT_IDS) {
    const invalid = validatePlaybook(withoutProduct(playbook, productId));
    assert.equal(invalid.ok, false, productId);
    assert.ok(
      invalid.errors.includes(`missing_required_product:${productId}`),
      `expected missing_required_product:${productId}, got ${JSON.stringify(invalid.errors)}`
    );
  }
});

test("phase9: every product has an explicit priority and phone-safe explanation", () => {
  const playbook = loadPlaybookOrThrow();
  for (const product of playbook.products) {
    assert.ok(product.priority, `missing priority: ${product.id}`);
    assert.ok(product.short_explanation.length > 0, `missing explanation: ${product.id}`);
  }

  const noPriority = validatePlaybook(
    withProductPatch(playbook, "smart_website", { priority: undefined })
  );
  assert.equal(noPriority.ok, false);
  assert.ok(noPriority.errors.includes("product_missing_priority:smart_website"));

  const badPriority = validatePlaybook(
    withProductPatch(playbook, "smart_website", { priority: "urgent" })
  );
  assert.equal(badPriority.ok, false);
  assert.ok(badPriority.errors.includes("product_invalid_priority:smart_website:urgent"));
});

test("phase9: high-priority products carry follow-up questions", () => {
  const playbook = loadPlaybookOrThrow();
  for (const product of playbook.products) {
    if (product.priority === "high") {
      assert.ok(
        product.follow_up_question?.length > 0,
        `high-priority product missing follow-up question: ${product.id}`
      );
    }
  }

  const invalid = validatePlaybook(
    withProductPatch(playbook, "voice_agent", { follow_up_question: "" })
  );
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.includes("product_missing_follow_up_question:voice_agent"));
});

test("phase9: missing pricing policy for core products fails validation", () => {
  const playbook = loadPlaybookOrThrow();
  for (const productId of PRICING_POLICY_REQUIRED_PRODUCT_IDS) {
    const product = playbook.products.find((entry) => entry.id === productId);
    assert.ok(product.price_policy.approved_phrase.length > 0, productId);
    assert.equal(product.price_policy.no_fixed_price, true, productId);

    const invalid = validatePlaybook(
      withProductPatch(playbook, productId, { price_policy: undefined, pricing_answer: undefined })
    );
    assert.equal(invalid.ok, false, productId);
    assert.ok(invalid.errors.includes(`product_missing_pricing_policy:${productId}`));
  }
});

test("phase9: missing contact capture policy fails validation", () => {
  const playbook = loadPlaybookOrThrow();
  const { contact_capture_policy, ...withoutCapture } = playbook;
  const invalid = validatePlaybook(withoutCapture);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.includes("missing_field:contact_capture_policy"));
});

test("phase9: caller ID policy is represented and required", () => {
  const playbook = loadPlaybookOrThrow();
  const callerId = playbook.contact_capture_policy.caller_id_policy;
  assert.equal(callerId.caller_id_available, "ask_permission_only");
  assert.equal(callerId.caller_id_missing, "ask_phone_once");
  assert.equal(callerId.max_phone_asks, 1);
  assert.match(callerId.caller_id_available_phrase, /unter dieser Nummer/i);
  assert.match(callerId.caller_id_missing_phrase, /Telefonnummer/i);

  const invalid = validatePlaybook({
    ...playbook,
    contact_capture_policy: { ...playbook.contact_capture_policy, caller_id_policy: undefined },
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.includes("contact_capture_missing_caller_id_policy"));
});

test("phase9: contact form handoff policy is represented and required", () => {
  const playbook = loadPlaybookOrThrow();
  const handoff = playbook.contact_capture_policy.contact_form_handoff;
  assert.equal(handoff.enabled, true);
  assert.match(handoff.phrase, /Kontaktformular/i);
  for (const useCase of ["E-Mail-Adressen", "Website-URLs", "Firmennamen"]) {
    assert.ok(handoff.use_for.includes(useCase), `missing handoff use case: ${useCase}`);
  }

  const invalid = validatePlaybook({
    ...playbook,
    contact_capture_policy: {
      ...playbook.contact_capture_policy,
      contact_form_handoff: { enabled: true, phrase: "" },
    },
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.includes("contact_capture_missing_contact_form_handoff"));
});

test("phase9: email/URL/company-name voice capture restrictions are represented", () => {
  const playbook = loadPlaybookOrThrow();
  const capture = playbook.contact_capture_policy;
  assert.equal(capture.no_email_capture_by_voice, true);
  assert.equal(capture.no_website_url_capture_by_voice, true);
  assert.equal(capture.no_company_name_capture_by_voice_unless_necessary, true);
  assert.match(capture.email_redirect_phrase, /Kontaktformular/i);
  assert.match(capture.website_or_company_redirect_phrase, /Kontaktformular/i);

  for (const [flag, error] of [
    ["no_email_capture_by_voice", "contact_capture_missing_no_email_rule"],
    ["no_website_url_capture_by_voice", "contact_capture_missing_no_website_url_rule"],
    [
      "no_company_name_capture_by_voice_unless_necessary",
      "contact_capture_missing_no_company_name_rule",
    ],
  ]) {
    const invalid = validatePlaybook({
      ...playbook,
      contact_capture_policy: { ...capture, [flag]: false },
    });
    assert.equal(invalid.ok, false, flag);
    assert.ok(invalid.errors.includes(error), `expected ${error}`);
  }
});

test("phase9: lead tier definitions exist and are required", () => {
  const playbook = loadPlaybookOrThrow();
  for (const tier of REQUIRED_LEAD_TIERS) {
    assert.ok(playbook.lead_tiers[tier], `missing lead tier: ${tier}`);
  }
  assert.ok(playbook.lead_tiers.lead_ready.requires.length >= 4);

  const invalid = validatePlaybook({
    ...playbook,
    lead_tiers: { ...playbook.lead_tiers, manual_review: "" },
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.includes("lead_tiers_missing:manual_review"));

  const { lead_tiers, ...withoutTiers } = playbook;
  const missing = validatePlaybook(withoutTiers);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.includes("missing_field:lead_tiers"));
});

test("phase9: LokalKI is low priority and direct-answer-only", () => {
  const playbook = loadPlaybookOrThrow();
  const lokalki = playbook.products.find((product) => product.id === "lokalki");
  assert.equal(lokalki.priority, "low");
  assert.equal(lokalki.answer_only_when_asked, true);
  assert.ok(lokalki.do_not.length >= 3);

  const promoted = validatePlaybook(withProductPatch(playbook, "lokalki", { priority: "high" }));
  assert.equal(promoted.ok, false);
  assert.ok(promoted.errors.includes("lokalki_must_be_low_priority"));

  const proactive = validatePlaybook(
    withProductPatch(playbook, "lokalki", { answer_only_when_asked: false })
  );
  assert.equal(proactive.ok, false);
  assert.ok(proactive.errors.includes("lokalki_must_be_answer_only_when_asked"));
});

test("phase9: founder-approved company positioning and product answers are represented", () => {
  const playbook = loadPlaybookOrThrow();
  assert.match(playbook.company.positioning_short, /KI praktisch im Alltag/);
  assert.match(playbook.company.diagnostic_follow_up, /Website.*Anrufe.*Google/i);

  const smartWebsite = playbook.products.find((product) => product.id === "smart_website");
  assert.match(smartWebsite.phone_answers.short_10s, /digitaler Assistent/i);
  assert.ok(smartWebsite.phone_answers.medium_25s.length > 0);
  assert.ok(smartWebsite.phone_answers.detailed_45s.length > 0);
  assert.match(smartWebsite.price_policy.approved_phrase, /Umfang/);

  const voiceAgent = playbook.products.find((product) => product.id === "voice_agent");
  assert.match(voiceAgent.price_policy.approved_phrase, /65 Euro pro Monat/);

  const aiseoq = playbook.products.find((product) => product.id === "aiseoq");
  assert.match(aiseoq.price_policy.approved_phrase, /40 Euro pro Seite/);
  assert.match(aiseoq.contact_form_guidance, /Kontaktformular/i);
});

test("phase9: eval coverage maps all required categories to existing scenarios", () => {
  const playbook = loadPlaybookOrThrow();
  const scenarioIds = new Set(playbook.eval_scenarios.map((scenario) => scenario.id));
  for (const category of PHASE9_EVAL_COVERAGE_CATEGORIES) {
    const mapped = playbook.eval_coverage[category];
    assert.ok(Array.isArray(mapped) && mapped.length > 0, `eval coverage missing: ${category}`);
    for (const id of mapped) {
      assert.ok(scenarioIds.has(id), `eval coverage references unknown scenario: ${id}`);
    }
  }
});

test("phase9: eval suite passes and is traceable to playbook_version", async () => {
  const playbook = loadPlaybookOrThrow();
  const suite = await runPlaybookEvalSuite({ playbook });
  assert.equal(suite.ok, true, JSON.stringify(suite.results.filter((r) => r.status === "fail")));
  assert.equal(suite.playbook_version, playbook.playbook_version);
  assert.equal(suite.summary.fail, 0);
  assert.equal(suite.summary.pending, 0);

  const snapshot = JSON.parse(formatEvalSuiteSnapshot(suite));
  assert.equal(snapshot.playbook_version, playbook.playbook_version);
  const serialized = JSON.stringify(snapshot);
  assert.equal(/\+\d{7,}/.test(serialized), false);
  assert.equal(/@\w+\.\w+/.test(serialized), false);
});

test("phase9: playbook stays runtime-inactive and defaults remain off (no live behavior change)", () => {
  const playbook = loadPlaybookOrThrow();
  assert.equal(playbook.status, "draft");
  assert.equal(playbook.runtime_binding.active, false);
  assert.equal(playbook.approval.approved_for_runtime, false);
  assert.equal(playbook.approval.approval_required_before_runtime_binding, true);

  const config = loadConfig();
  assert.equal(config.v4.runtimeVersion, "v3");
  assert.equal(config.v4.playbookRuntimeEnabled, false);
  assert.equal(config.v4.questionnaireRuntimeEnabled, false);

  const policy = resolveBehaviorPolicy({ config });
  assert.equal(policy.source, "hardcoded_default");
  assert.equal(policy.reason, "playbook_runtime_disabled");
  assert.equal(policy.closing_response, HARDCODED_BEHAVIOR_DEFAULTS.closing_response);
});
