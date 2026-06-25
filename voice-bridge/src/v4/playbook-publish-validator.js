/**
 * Phase 11 — non-live publish-candidate validation (governance only).
 *
 * Validates schema, approval metadata, inactive runtime binding, eval gates,
 * policy completeness, and forbidden pricing/guarantee claims. Never activates
 * runtime or mutates playbooks.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadTenantPlaybookFromPath,
  validatePlaybook,
  REQUIRED_PLAYBOOK_PRODUCT_IDS,
  PRICING_POLICY_REQUIRED_PRODUCT_IDS,
  REQUIRED_LEAD_TIERS,
} from "./playbook-loader.js";
import {
  runPlaybookEvalSuite,
  runPublishedArtifactEvalConformanceSuite,
} from "./playbook-eval-scenarios.js";
import { runDecisionEvalSuite } from "./agent-behavior-decision-eval.js";
import { loadConfig } from "../config.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const DEFAULT_PUBLISH_CANDIDATE_FILENAME =
  "technolohit.main_voice_sales.v1.publish-candidate.json";
export const DEFAULT_PUBLISHED_PLAYBOOK_FILENAME =
  "technolohit.main_voice_sales.v1.published.json";

export const PUBLISH_VALIDATION_MODES = Object.freeze({
  CANDIDATE: "candidate",
  PUBLISHED: "published",
});

export const EXPECTED_SOURCE_MARKDOWN = "docs/TechnoloHit Product Playbook v1.md";
export const APPROVED_FOUNDER = "Mojtaba";
export const APPROVED_CALLBACK_FINALIZED_WORDING =
  "Vielen Dank. Ich habe die Anfrage aufgenommen. Unser Team meldet sich telefonisch bei Ihnen.";
export const APPROVED_NO_VALID_PHONE_WORDING =
  "Vielen Dank. Für eine telefonische Rückmeldung ist es am besten, wenn Sie Ihre Anfrage über unser Kontaktformular auf www.technolohit.com senden. Unser Team prüft das dann gezielt.";

/** Phase 11 required eval coverage categories (mapped via playbook.eval_coverage). */
export const REQUIRED_PUBLISH_EVAL_COVERAGE = [
  "company_general_question",
  "smart_website_explanation",
  "smart_website_price",
  "voice_agent_explanation",
  "voice_agent_price",
  "aiseoq_explanation",
  "aiseoq_price",
  "callback_request_after_product_answer",
  "phone_preference",
  "callback_permission",
  "no_email_capture_by_voice",
  "no_website_url_capture_by_voice",
  "contact_form_handoff",
  "no_rag_after_callback_starts",
  "no_questionnaire_after_callback_starts",
  "caller_id_available_path",
  "caller_id_missing_ask_phone_once",
  "closing",
];

const FORBIDDEN_CLAIM_PATTERNS = [
  /\bgarantiert(?:e|es|en)?\s+(?:top-)?ranking\b/i,
  /\bgarantierte\s+leads\b/i,
  /\b100\s*%\s+garant/i,
  /\bauf jeden fall\b/i,
  /\b(?:ein|einen|unser|der)\s+festpreis\b/i,
  /\bfestpreis\s+für\s+alle\b/i,
];

const PRIVACY_UNSAFE_OUTPUT_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\+?\d{2,}[\d\s().-]{6,}\d\b/,
  /\b(sk-[a-zA-Z0-9]{10,}|AKIA[0-9A-Z]{16})\b/,
  /TechnoloHit hilft Unternehmen/i,
  /Smart Website ist/i,
  /Darf unser Team Sie unter dieser Nummer/i,
];

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function listPlaybookJsonFiles(playbooksDir = path.join(packageRoot, "config", "playbooks")) {
  if (!fs.existsSync(playbooksDir)) return [];
  return fs
    .readdirSync(playbooksDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(playbooksDir, name));
}

export function collectPlaybookVersions(excludePath = null) {
  const versions = new Map();
  for (const filePath of listPlaybookJsonFiles()) {
    if (excludePath && path.resolve(filePath) === path.resolve(excludePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const version = parsed?.playbook_version;
      if (!hasNonEmptyString(version)) continue;
      const existing = versions.get(version) ?? [];
      existing.push(filePath);
      versions.set(version, existing);
    } catch {
      // ignore unreadable files during uniqueness scan
    }
  }
  return versions;
}

function collectStringLeaves(value, pathPrefix = "", out = []) {
  if (typeof value === "string") {
    out.push({ path: pathPrefix, text: value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStringLeaves(entry, `${pathPrefix}[${index}]`, out));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const next = pathPrefix ? `${pathPrefix}.${key}` : key;
      collectStringLeaves(entry, next, out);
    }
  }
  return out;
}

function scanForbiddenClaims(playbook) {
  const failures = [];
  const scanRoots = [
    ["products", playbook.products],
    ["pricing_policy", playbook.pricing_policy],
    ["callback_policy", playbook.callback_policy],
    ["contact_capture_policy", playbook.contact_capture_policy],
  ];
  for (const [rootName, rootValue] of scanRoots) {
    for (const { path: leafPath, text } of collectStringLeaves(rootValue, rootName)) {
      if (leafPath.includes("not_ideal_for") || leafPath.includes("boundaries") || leafPath.includes("do_not")) {
        continue;
      }
      for (const pattern of FORBIDDEN_CLAIM_PATTERNS) {
        if (pattern.test(text)) {
          failures.push(`forbidden_claim:${leafPath}`);
          break;
        }
      }
    }
  }
  return failures;
}

export function validatePublishCandidateMetadata(playbook) {
  const failures = [];
  const meta = playbook?.publish_candidate;
  if (!meta || typeof meta !== "object") {
    failures.push("publish_candidate_metadata_missing");
    return failures;
  }
  if (meta.kind !== "publish_candidate") failures.push("publish_candidate_kind_invalid");
  if (!hasNonEmptyString(meta.generated_date)) failures.push("publish_candidate_missing_generated_date");
  if (!hasNonEmptyString(meta.source_commit_sha)) failures.push("publish_candidate_missing_source_commit_sha");
  if (!hasNonEmptyString(meta.prior_playbook_version)) {
    failures.push("publish_candidate_missing_prior_playbook_version");
  }
  if (meta.founder_approval !== "pending") failures.push("publish_candidate_founder_approval_not_pending");
  if (!hasNonEmptyString(meta.approval_owner)) failures.push("publish_candidate_missing_approval_owner");
  return failures;
}

export function validatePublishedMetadata(playbook) {
  const failures = [];
  const meta = playbook?.published_release;
  if (!meta || typeof meta !== "object") {
    failures.push("published_release_metadata_missing");
    return failures;
  }
  if (meta.kind !== "published_playbook") failures.push("published_release_kind_invalid");
  if (!hasNonEmptyString(meta.publication_date)) failures.push("published_release_missing_date");
  if (!hasNonEmptyString(meta.source_commit_sha)) failures.push("published_release_missing_source_commit_sha");
  if (!hasNonEmptyString(meta.source_candidate_version)) {
    failures.push("published_release_missing_source_candidate_version");
  }
  if (meta.founder_approval !== "approved") failures.push("published_release_founder_approval_required");
  if (meta.approval_owner !== APPROVED_FOUNDER) failures.push("published_release_approval_owner_invalid");
  if (meta.runtime_activation !== "blocked_until_separate_canary_approval") {
    failures.push("published_release_runtime_activation_not_blocked");
  }
  return failures;
}

export function validateApprovalMetadata(playbook) {
  const failures = [];
  const approval = playbook?.approval;
  if (!approval || typeof approval !== "object") {
    failures.push("approval_metadata_missing");
    return failures;
  }
  if (!hasNonEmptyString(approval.approval_owner)) failures.push("approval_missing_owner");
  if (typeof approval.approved_for_runtime !== "boolean") {
    failures.push("approval_missing_approved_for_runtime_flag");
  }
  if (Object.prototype.hasOwnProperty.call(playbook, "approved_for_runtime")) {
    failures.push("unexpected_top_level_approved_for_runtime");
  }
  if (approval.approved_for_runtime === true && playbook.status !== "published") {
    failures.push("approved_for_runtime_requires_published_status");
  }
  if (
    playbook.runtime_binding?.active === true &&
    (playbook.status !== "published" || approval.approved_for_runtime !== true)
  ) {
    failures.push("runtime_binding_active_without_publish_approval");
  }
  return failures;
}

export function validateGovernanceMode(playbook, mode) {
  const failures = [];
  if (!Object.values(PUBLISH_VALIDATION_MODES).includes(mode)) {
    return ["publish_validation_mode_invalid"];
  }

  if (playbook?.runtime_binding?.active === true) {
    failures.push("governance_artifact_runtime_binding_must_be_inactive");
  }

  if (mode === PUBLISH_VALIDATION_MODES.CANDIDATE) {
    failures.push(...validatePublishCandidateMetadata(playbook));
    if (playbook?.status !== "draft") failures.push("candidate_status_must_be_draft");
    if (playbook?.approval?.state !== "draft") failures.push("candidate_approval_state_must_be_draft");
    if (playbook?.approval?.approved_for_runtime !== false) {
      failures.push("candidate_must_not_be_approved_for_runtime");
    }
    if (playbook?.approval?.founder_approval !== "pending") {
      failures.push("candidate_approval_must_be_pending");
    }
    if (playbook?.published_release) failures.push("candidate_must_not_have_published_release_metadata");
  }

  if (mode === PUBLISH_VALIDATION_MODES.PUBLISHED) {
    failures.push(...validatePublishedMetadata(playbook));
    if (playbook?.publish_candidate) failures.push("published_artifact_must_not_keep_candidate_metadata");
    if (playbook?.status !== "published") failures.push("published_status_required");
    if (playbook?.approval?.state !== "approved") failures.push("published_approval_state_required");
    if (playbook?.approval?.approved_for_runtime !== true) {
      failures.push("published_content_approval_required");
    }
    if (playbook?.approval?.founder_approval !== "approved") {
      failures.push("published_founder_approval_required");
    }
    if (playbook?.approval?.approval_owner !== "Mojtaba, Founder of TechnoloHit") {
      failures.push("published_approval_owner_invalid");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(playbook?.approval?.approval_date ?? "")) {
      failures.push("published_approval_date_invalid");
    }
    if (playbook?.approval?.approval_date !== playbook?.published_release?.publication_date) {
      failures.push("published_approval_date_mismatch");
    }
    if (playbook?.approval?.canary_approval !== "pending") {
      failures.push("published_canary_approval_must_be_pending");
    }
  }

  return failures;
}

export function validateFounderApprovedPublishedContent(playbook, mode) {
  if (mode !== PUBLISH_VALIDATION_MODES.PUBLISHED) return [];
  const failures = [];
  const products = Array.isArray(playbook?.products) ? playbook.products : [];
  if (products.some((product) => product?.id === "botinteg")) {
    failures.push("published_v1_contains_unapproved_product:botinteg");
  }
  if ((playbook?.allowed_topics ?? []).some((topic) => /botinteg/i.test(String(topic)))) {
    failures.push("published_v1_contains_unapproved_topic:botinteg");
  }
  if (playbook?.callback_policy?.finalized_confirmation !== APPROVED_CALLBACK_FINALIZED_WORDING) {
    failures.push("published_callback_finalized_wording_mismatch");
  }
  if (
    playbook?.contact_capture_policy?.caller_id_policy?.phone_capture_failure_phrase !==
    APPROVED_NO_VALID_PHONE_WORDING
  ) {
    failures.push("published_no_valid_phone_wording_mismatch");
  }
  return failures;
}

export function validateSourceOfTruthReferences(playbook, repoRoot = path.resolve(packageRoot, "..")) {
  const failures = [];
  const markdownRef = playbook?.source_of_truth?.human_approved_markdown;
  if (!hasNonEmptyString(markdownRef)) {
    failures.push("source_of_truth_missing_markdown_ref");
  } else if (markdownRef !== EXPECTED_SOURCE_MARKDOWN) {
    failures.push("source_of_truth_unexpected_markdown_ref");
  } else {
    const markdownPath = path.join(repoRoot, markdownRef);
    if (!fs.existsSync(markdownPath)) failures.push("source_of_truth_markdown_not_found");
  }
  return failures;
}

export function validateEvalCoverage(playbook) {
  const failures = [];
  const coverage = playbook?.eval_coverage;
  if (!coverage || typeof coverage !== "object") {
    failures.push("eval_coverage_missing");
    return failures;
  }
  for (const category of REQUIRED_PUBLISH_EVAL_COVERAGE) {
    const scenarioIds = coverage[category];
    if (!Array.isArray(scenarioIds) || scenarioIds.length === 0) {
      failures.push(`eval_coverage_missing_category:${category}`);
      continue;
    }
    const known = new Set((playbook.eval_scenarios ?? []).map((entry) => entry?.id).filter(Boolean));
    for (const scenarioId of scenarioIds) {
      if (!known.has(scenarioId)) failures.push(`eval_coverage_unknown_scenario:${category}:${scenarioId}`);
    }
  }
  return failures;
}

export function validateCallbackAndContactPolicies(playbook) {
  const failures = [];
  const callback = playbook?.callback_policy;
  if (!callback || typeof callback !== "object") {
    failures.push("callback_policy_missing");
  } else {
    if (callback.callback_requires_valid_phone !== true) failures.push("callback_requires_valid_phone");
    if (callback.callback_requires_permission !== true) failures.push("callback_requires_permission");
    if (callback.no_live_transfer_claims !== true) failures.push("callback_no_live_transfer_claims");
    if (!hasNonEmptyString(callback.preferred_wording)) failures.push("callback_preferred_wording_missing");
  }

  const contact = playbook.contact_capture_policy;
  if (!contact || typeof contact !== "object") {
    failures.push("contact_capture_policy_missing");
    return failures;
  }
  const callerId = contact.caller_id_policy;
  if (!callerId || typeof callerId !== "object") {
    failures.push("contact_capture_missing_caller_id_policy");
  } else {
    if (callerId.caller_id_available !== "ask_permission_only") {
      failures.push("caller_id_available_policy_mismatch");
    }
    if (callerId.caller_id_missing !== "ask_phone_once") {
      failures.push("caller_id_missing_policy_mismatch");
    }
    if (!hasNonEmptyString(callerId.caller_id_available_phrase)) {
      failures.push("caller_id_available_phrase_missing");
    }
    if (!hasNonEmptyString(callerId.caller_id_missing_phrase)) {
      failures.push("caller_id_missing_phrase_missing");
    }
  }
  if (contact.no_email_capture_by_voice !== true) failures.push("contact_capture_missing_no_email_rule");
  if (contact.no_website_url_capture_by_voice !== true) {
    failures.push("contact_capture_missing_no_website_url_rule");
  }
  if (contact.no_company_name_capture_by_voice_unless_necessary !== true) {
    failures.push("contact_capture_missing_no_company_name_rule");
  }
  if (!hasNonEmptyString(contact.contact_form_handoff?.phrase)) {
    failures.push("contact_capture_missing_contact_form_handoff");
  }
  return failures;
}

export function validatePrivacyCaptureRestrictions(playbook) {
  const failures = [];
  const contact = playbook.contact_capture_policy;
  if (!contact) return ["contact_capture_policy_missing"];
  if (contact.no_email_capture_by_voice !== true) failures.push("privacy_no_email_capture_required");
  if (contact.no_website_url_capture_by_voice !== true) failures.push("privacy_no_website_url_capture_required");
  if (contact.no_company_name_capture_by_voice_unless_necessary !== true) {
    failures.push("privacy_no_company_name_capture_required");
  }
  const questionnaire = playbook.questionnaire_policy;
  if (questionnaire && Array.isArray(questionnaire.rules)) {
    const joined = questionnaire.rules.join(" ").toLowerCase();
    if (!joined.includes("e-mail") && !joined.includes("email")) {
      failures.push("questionnaire_policy_missing_no_email_rule");
    }
  }
  return failures;
}

export function validateRequiredProductsAndPolicies(playbook) {
  const failures = [];
  const products = Array.isArray(playbook?.products) ? playbook.products : [];
  const byId = new Map(products.filter((p) => p?.id).map((p) => [p.id, p]));
  for (const productId of REQUIRED_PLAYBOOK_PRODUCT_IDS) {
    if (!byId.has(productId)) failures.push(`missing_required_product:${productId}`);
  }
  for (const productId of PRICING_POLICY_REQUIRED_PRODUCT_IDS) {
    const product = byId.get(productId);
    if (!product) continue;
    const approved = product?.price_policy?.approved_phrase ?? product?.pricing_answer;
    if (!hasNonEmptyString(approved)) failures.push(`product_missing_pricing_policy:${productId}`);
  }
  const lokalki = byId.get("lokalki");
  if (lokalki) {
    if (lokalki.priority !== "low") failures.push("lokalki_must_be_low_priority");
    if (lokalki.answer_only_when_asked !== true) failures.push("lokalki_must_be_answer_only_when_asked");
  }
  const leadTiers = playbook?.lead_tiers ?? {};
  for (const tier of REQUIRED_LEAD_TIERS) {
    const definition = leadTiers[tier];
    const defined =
      hasNonEmptyString(definition) ||
      (definition && typeof definition === "object" && hasNonEmptyString(definition.description));
    if (!defined) failures.push(`lead_tiers_missing:${tier}`);
  }
  return failures;
}

export function validatePlaybookVersionUniqueness(playbook, playbookPath) {
  const failures = [];
  if (!hasNonEmptyString(playbook?.playbook_version)) {
    failures.push("playbook_version_empty");
    return failures;
  }
  const versions = collectPlaybookVersions(playbookPath);
  const duplicates = versions.get(playbook.playbook_version) ?? [];
  if (duplicates.length > 0) failures.push("playbook_version_not_unique");
  return failures;
}

export function assertPublishValidationOutputIsPrivacySafe(output) {
  const text = String(output ?? "");
  for (const pattern of PRIVACY_UNSAFE_OUTPUT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error("privacy_violation:unsafe_cli_output");
    }
  }
  return true;
}

function buildGovernanceEvalPlaybook(playbook, mode) {
  if (mode !== PUBLISH_VALIDATION_MODES.PUBLISHED) return playbook;
  return {
    ...playbook,
    status: "draft",
    runtime_binding: { ...playbook.runtime_binding, active: false },
    approval: { ...playbook.approval, state: "draft", approved_for_runtime: false },
  };
}

export function formatPublishValidationOutput(result) {
  const lines = [
    `playbook_publish_validation=${result.ok ? "pass" : "fail"}`,
    `validation_mode=${result.mode ?? "unknown"}`,
    `playbook_version=${result.playbook_version ?? "unknown"}`,
    `status=${result.status ?? "unknown"}`,
    `approved_for_runtime=${String(result.approved_for_runtime ?? false)}`,
    `runtime_binding_active=${String(result.runtime_binding_active ?? false)}`,
    `playbook_eval_pass=${result.playbook_eval?.pass ?? 0}`,
    `playbook_eval_fail=${result.playbook_eval?.fail ?? 0}`,
    `playbook_eval_pending=${result.playbook_eval?.pending ?? 0}`,
    `decision_eval_pass=${result.decision_eval?.pass ?? 0}`,
    `decision_eval_fail=${result.decision_eval?.fail ?? 0}`,
    `decision_eval_pending=${result.decision_eval?.pending ?? 0}`,
    `founder_approval=${result.founder_approval ?? "unknown"}`,
    `failure_count=${result.failures?.length ?? 0}`,
  ];
  if (!result.ok && Array.isArray(result.failures) && result.failures.length > 0) {
    lines.push(`failures=${result.failures.join(",")}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function validatePlaybookForPublish({
  playbook,
  mode,
  playbookPath = null,
  skipEval = false,
  repoRoot = path.resolve(packageRoot, ".."),
} = {}) {
  const failures = [];

  const schema = validatePlaybook(playbook);
  if (!schema.ok) failures.push(...schema.errors);

  failures.push(...validateApprovalMetadata(playbook));
  failures.push(...validateGovernanceMode(playbook, mode));
  failures.push(...validateFounderApprovedPublishedContent(playbook, mode));
  failures.push(...validateSourceOfTruthReferences(playbook, repoRoot));
  failures.push(...validateEvalCoverage(playbook));
  failures.push(...validateCallbackAndContactPolicies(playbook));
  failures.push(...validatePrivacyCaptureRestrictions(playbook));
  failures.push(...validateRequiredProductsAndPolicies(playbook));
  failures.push(...scanForbiddenClaims(playbook));

  if (playbookPath) {
    failures.push(...validatePlaybookVersionUniqueness(playbook, playbookPath));
  }

  let playbookEval = { pass: 0, fail: 0, pending: 0, total: 0 };
  let decisionEval = { pass: 0, fail: 0, pending: 0, total: 0 };

  if (!skipEval && playbook) {
    // Published content must remain runtime-inactive in governance. The
    // existing eval harness intentionally executes only draft overrides or an
    // active runtime binding, so validate an in-memory draft projection of the
    // same content rather than weakening activation guards.
    const evalPlaybook = buildGovernanceEvalPlaybook(playbook, mode);
    const playbookSuite =
      mode === PUBLISH_VALIDATION_MODES.PUBLISHED
        ? await runPublishedArtifactEvalConformanceSuite({ playbook: evalPlaybook })
        : await runPlaybookEvalSuite({ playbook: evalPlaybook });
    playbookEval = playbookSuite.summary ?? playbookEval;
    if (!playbookSuite.ok || playbookEval.fail > 0) failures.push("playbook_eval_failed");
    if (playbookEval.pending > 0) failures.push("playbook_eval_pending");

    const decisionSuite = await runDecisionEvalSuite({ playbook: evalPlaybook });
    decisionEval = decisionSuite.summary ?? decisionEval;
    if (!decisionSuite.ok || decisionEval.fail > 0) failures.push("decision_eval_failed");
    if (decisionEval.pending > 0) failures.push("decision_eval_pending");
  }

  const config = loadConfig();
  if (config?.v4?.playbookRuntimeEnabled === true) failures.push("production_playbook_runtime_flag_must_stay_off");

  const uniqueFailures = [...new Set(failures)];

  return {
    ok: uniqueFailures.length === 0,
    mode,
    playbook_version: playbook?.playbook_version ?? null,
    status: playbook?.status ?? null,
    approved_for_runtime: playbook?.approval?.approved_for_runtime ?? false,
    runtime_binding_active: playbook?.runtime_binding?.active ?? false,
    founder_approval:
      playbook?.publish_candidate?.founder_approval ??
      playbook?.published_release?.founder_approval ??
      playbook?.approval?.founder_approval ??
      "unknown",
    playbook_eval: playbookEval,
    decision_eval: decisionEval,
    failures: uniqueFailures,
  };
}

export async function runPublishValidation({
  mode,
  playbookPath,
  skipEval = false,
} = {}) {
  if (!Object.values(PUBLISH_VALIDATION_MODES).includes(mode)) {
    return {
      ok: false,
      mode: mode ?? null,
      playbook_version: null,
      status: null,
      approved_for_runtime: false,
      runtime_binding_active: false,
      founder_approval: "unknown",
      playbook_eval: { pass: 0, fail: 0, pending: 0, total: 0 },
      decision_eval: { pass: 0, fail: 0, pending: 0, total: 0 },
      failures: ["publish_validation_mode_required"],
    };
  }
  if (!hasNonEmptyString(playbookPath)) {
    return {
      ok: false,
      mode,
      playbook_version: null,
      status: null,
      approved_for_runtime: false,
      runtime_binding_active: false,
      founder_approval: "unknown",
      playbook_eval: { pass: 0, fail: 0, pending: 0, total: 0 },
      decision_eval: { pass: 0, fail: 0, pending: 0, total: 0 },
      failures: ["playbook_artifact_path_required"],
    };
  }
  const loaded = loadTenantPlaybookFromPath(playbookPath);
  if (!loaded.ok) {
    return {
      ok: false,
      mode,
      playbook_version: null,
      status: null,
      approved_for_runtime: false,
      runtime_binding_active: false,
      founder_approval: "unknown",
      playbook_eval: { pass: 0, fail: 0, pending: 0, total: 0 },
      decision_eval: { pass: 0, fail: 0, pending: 0, total: 0 },
      failures: [loaded.error ?? "playbook_load_failed", ...(loaded.errors ?? [])],
    };
  }

  return validatePlaybookForPublish({
    playbook: loaded.playbook,
    mode,
    playbookPath: loaded.path,
    skipEval,
  });
}
