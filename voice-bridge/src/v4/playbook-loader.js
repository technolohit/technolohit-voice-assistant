/**
 * Phase 10AM/10AN — tenant playbook loader/validator.
 *
 * Phase 10AM introduced this as a test-only validator for the draft artifact
 * under config/playbooks/. Phase 10AN consults it from behavior-policy.js,
 * but ONLY when VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=true (default false). With
 * the default env nothing here runs at call time. The existing agent_config
 * loader (agent-config.js) remains the runtime source of truth.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const DEFAULT_PLAYBOOK_FILENAME = "technolohit.main_voice_sales.v1.json";

export const PLAYBOOK_REQUIRED_TOP_LEVEL_FIELDS = [
  "schema_version",
  "tenant_id",
  "agent_id",
  "playbook_version",
  "status",
  "runtime_binding",
  "role",
  "tone",
  "allowed_topics",
  "disallowed_topics",
  "products",
  "product_answer_rules",
  "pricing_policy",
  "contact_capture_policy",
  "lead_tiers",
  "lead_capture_policy",
  "callback_policy",
  "escalation_policy",
  "closing_policy",
  "fallback_policy",
  "notification_policy",
  "qa_criteria",
  "eval_scenarios",
  "changelog",
  "approval"
];

/** Phase 9 (v3 blueprint): products that must always exist in the playbook. */
export const REQUIRED_PLAYBOOK_PRODUCT_IDS = ["smart_website", "voice_agent", "aiseoq", "lokalki"];

/** Phase 9 (v3 blueprint): products that must carry an explicit pricing policy. */
export const PRICING_POLICY_REQUIRED_PRODUCT_IDS = ["smart_website", "voice_agent", "aiseoq"];

/** Phase 9 (v3 blueprint): lead tiers that must be defined. */
export const REQUIRED_LEAD_TIERS = [
  "information_request",
  "qualified_interest",
  "callback_requested",
  "manual_review",
  "lead_ready"
];

const VALID_STATUSES = new Set(["draft", "published", "archived"]);
const VALID_PRODUCT_PRIORITIES = new Set(["high", "medium_high", "medium", "low"]);

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function productHasPhoneSafeExplanation(product) {
  if (hasNonEmptyString(product?.short_explanation)) return true;
  const answers = product?.phone_answers;
  if (answers && typeof answers === "object") {
    return Object.values(answers).some((answer) => hasNonEmptyString(answer));
  }
  return false;
}

export function resolvePlaybookPath(filename = DEFAULT_PLAYBOOK_FILENAME) {
  return path.join(packageRoot, "config", "playbooks", filename);
}

export function validatePlaybook(playbook) {
  const errors = [];
  if (!playbook || typeof playbook !== "object") {
    return { ok: false, errors: ["playbook_not_an_object"] };
  }

  for (const field of PLAYBOOK_REQUIRED_TOP_LEVEL_FIELDS) {
    if (!(field in playbook)) errors.push(`missing_field:${field}`);
  }

  if ("playbook_version" in playbook && !hasNonEmptyString(playbook.playbook_version)) {
    errors.push("playbook_version_empty");
  }

  if (playbook.status && !VALID_STATUSES.has(playbook.status)) {
    errors.push(`invalid_status:${playbook.status}`);
  }

  // Phase 9: status/approval/runtime-binding metadata must be explicit.
  if (playbook.runtime_binding && typeof playbook.runtime_binding.active !== "boolean") {
    errors.push("runtime_binding_missing_active_flag");
  }
  if (playbook.approval) {
    if (!hasNonEmptyString(playbook.approval.state)) {
      errors.push("approval_missing_state");
    }
    if (typeof playbook.approval.approved_for_runtime !== "boolean") {
      errors.push("approval_missing_approved_for_runtime_flag");
    }
  }

  // Phase 10AN: an active runtime binding is only valid for a published,
  // runtime-approved playbook. Draft/unapproved playbooks must stay inactive.
  if (
    playbook.runtime_binding?.active === true &&
    (playbook.status !== "published" ||
      playbook.approval?.approved_for_runtime !== true)
  ) {
    errors.push("draft_playbook_must_not_be_runtime_active");
  }

  const products = Array.isArray(playbook.products) ? playbook.products : [];
  const productsById = new Map(
    products.filter((product) => product?.id).map((product) => [product.id, product])
  );

  // Phase 9: required products must exist.
  if ("products" in playbook) {
    for (const requiredId of REQUIRED_PLAYBOOK_PRODUCT_IDS) {
      if (!productsById.has(requiredId)) {
        errors.push(`missing_required_product:${requiredId}`);
      }
    }
  }

  for (const product of products) {
    if (!product?.id) errors.push("product_missing_id");
    if (!Array.isArray(product?.aliases) || product.aliases.length === 0) {
      errors.push(`product_missing_aliases:${product?.id ?? "unknown"}`);
    }
    if (!productHasPhoneSafeExplanation(product)) {
      errors.push(`product_missing_short_explanation:${product?.id ?? "unknown"}`);
    }
    // Phase 9: every product needs an explicit, known priority.
    if (!hasNonEmptyString(product?.priority)) {
      errors.push(`product_missing_priority:${product?.id ?? "unknown"}`);
    } else if (!VALID_PRODUCT_PRIORITIES.has(product.priority)) {
      errors.push(`product_invalid_priority:${product?.id ?? "unknown"}:${product.priority}`);
    }
    // Phase 9: high-priority products must carry at least one follow-up question.
    if (product?.priority === "high" && !hasNonEmptyString(product?.follow_up_question)) {
      errors.push(`product_missing_follow_up_question:${product?.id ?? "unknown"}`);
    }
  }

  // Phase 9: explicit pricing policy for the core sellable products.
  for (const productId of PRICING_POLICY_REQUIRED_PRODUCT_IDS) {
    const product = productsById.get(productId);
    if (!product) continue; // missing product already reported above
    const approvedPhrase = product?.price_policy?.approved_phrase;
    if (!hasNonEmptyString(approvedPhrase) && !hasNonEmptyString(product?.pricing_answer)) {
      errors.push(`product_missing_pricing_policy:${productId}`);
    }
  }

  // Phase 9: LokalKI must stay low priority / direct-answer-only.
  const lokalki = productsById.get("lokalki");
  if (lokalki) {
    if (lokalki.priority !== "low") {
      errors.push("lokalki_must_be_low_priority");
    }
    if (lokalki.answer_only_when_asked !== true) {
      errors.push("lokalki_must_be_answer_only_when_asked");
    }
  }

  // Phase 9: contact capture / caller ID / contact form handoff policy.
  const contactCapture = playbook.contact_capture_policy;
  if (contactCapture && typeof contactCapture === "object") {
    if (!contactCapture.caller_id_policy || typeof contactCapture.caller_id_policy !== "object") {
      errors.push("contact_capture_missing_caller_id_policy");
    }
    if (contactCapture.no_email_capture_by_voice !== true) {
      errors.push("contact_capture_missing_no_email_rule");
    }
    if (contactCapture.no_website_url_capture_by_voice !== true) {
      errors.push("contact_capture_missing_no_website_url_rule");
    }
    if (contactCapture.no_company_name_capture_by_voice_unless_necessary !== true) {
      errors.push("contact_capture_missing_no_company_name_rule");
    }
    if (!hasNonEmptyString(contactCapture.contact_form_handoff?.phrase)) {
      errors.push("contact_capture_missing_contact_form_handoff");
    }
  }

  // Phase 9: lead tier definitions.
  const leadTiers = playbook.lead_tiers;
  if (leadTiers && typeof leadTiers === "object") {
    for (const tier of REQUIRED_LEAD_TIERS) {
      const definition = leadTiers[tier];
      const defined =
        hasNonEmptyString(definition) ||
        (definition && typeof definition === "object" && hasNonEmptyString(definition.description));
      if (!defined) errors.push(`lead_tiers_missing:${tier}`);
    }
  }

  const closing = playbook.closing_policy ?? {};
  if (!Array.isArray(closing.phrases) || closing.phrases.length === 0) {
    errors.push("closing_policy_missing_phrases");
  }
  if (!closing.response) errors.push("closing_policy_missing_response");

  const scenarios = Array.isArray(playbook.eval_scenarios) ? playbook.eval_scenarios : [];
  for (const scenario of scenarios) {
    if (!scenario?.id || !scenario?.category || !scenario?.expected) {
      errors.push(`eval_scenario_incomplete:${scenario?.id ?? "unknown"}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Load a playbook from an explicit (absolute or package-relative) path. */
export function loadTenantPlaybookFromPath(playbookPath) {
  const resolved = path.isAbsolute(playbookPath)
    ? playbookPath
    : path.join(packageRoot, playbookPath);
  if (!fs.existsSync(resolved)) {
    return { ok: false, path: resolved, error: "playbook_not_found" };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (err) {
    return {
      ok: false,
      path: resolved,
      error: "playbook_invalid_json",
      message: err?.message ?? "invalid JSON"
    };
  }

  const validation = validatePlaybook(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      path: resolved,
      error: "playbook_validation_failed",
      errors: validation.errors
    };
  }

  return { ok: true, path: resolved, playbook: parsed };
}

export function loadTenantPlaybook(filename = DEFAULT_PLAYBOOK_FILENAME) {
  return loadTenantPlaybookFromPath(resolvePlaybookPath(filename));
}
