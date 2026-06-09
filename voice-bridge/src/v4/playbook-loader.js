/**
 * Phase 10AM — tenant playbook loader/validator (NON-RUNTIME).
 *
 * This module is intentionally not imported by any live call path. It exists
 * so tests (and later Phase 10AN tooling) can parse and validate the draft
 * playbook artifact under config/playbooks/. The existing agent_config loader
 * (agent-config.js) remains the runtime source of truth.
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

const VALID_STATUSES = new Set(["draft", "published", "archived"]);

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

  if (playbook.status && !VALID_STATUSES.has(playbook.status)) {
    errors.push(`invalid_status:${playbook.status}`);
  }

  if (playbook.runtime_binding?.active === true) {
    errors.push("runtime_binding_must_not_be_active_in_phase_10am");
  }

  const products = Array.isArray(playbook.products) ? playbook.products : [];
  for (const product of products) {
    if (!product?.id) errors.push("product_missing_id");
    if (!Array.isArray(product?.aliases) || product.aliases.length === 0) {
      errors.push(`product_missing_aliases:${product?.id ?? "unknown"}`);
    }
    if (!product?.short_explanation) {
      errors.push(`product_missing_short_explanation:${product?.id ?? "unknown"}`);
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

export function loadTenantPlaybook(filename = DEFAULT_PLAYBOOK_FILENAME) {
  const playbookPath = resolvePlaybookPath(filename);
  if (!fs.existsSync(playbookPath)) {
    return { ok: false, path: playbookPath, error: "playbook_not_found" };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(playbookPath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      path: playbookPath,
      error: "playbook_invalid_json",
      message: err?.message ?? "invalid JSON"
    };
  }

  const validation = validatePlaybook(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      path: playbookPath,
      error: "playbook_validation_failed",
      errors: validation.errors
    };
  }

  return { ok: true, path: playbookPath, playbook: parsed };
}
