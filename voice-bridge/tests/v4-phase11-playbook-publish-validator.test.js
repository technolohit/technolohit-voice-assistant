/**
 * Phase 11 — publish candidate validation tests (governance only).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import {
  loadTenantPlaybook,
  loadTenantPlaybookFromPath,
  resolvePlaybookPath,
} from "../src/v4/playbook-loader.js";
import {
  APPROVED_CALLBACK_FINALIZED_WORDING,
  APPROVED_NO_VALID_PHONE_WORDING,
  assertPublishValidationOutputIsPrivacySafe,
  DEFAULT_PUBLISH_CANDIDATE_FILENAME,
  DEFAULT_PUBLISHED_PLAYBOOK_FILENAME,
  formatPublishValidationOutput,
  PUBLISH_VALIDATION_MODES,
  REQUIRED_PUBLISH_EVAL_COVERAGE,
  runPublishValidation,
  validateApprovalMetadata,
  validateGovernanceMode,
  validatePlaybookForPublish,
  validatePublishCandidateMetadata,
} from "../src/v4/playbook-publish-validator.js";
import { HARDCODED_BEHAVIOR_DEFAULTS, resolveBehaviorPolicy } from "../src/v4/behavior-policy.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidatePath = resolvePlaybookPath(DEFAULT_PUBLISH_CANDIDATE_FILENAME);
const publishedPath = resolvePlaybookPath(DEFAULT_PUBLISHED_PLAYBOOK_FILENAME);
const cliPath = path.join(packageRoot, "scripts", "playbook-publish-validate.js");

function loadCandidateOrThrow() {
  const loaded = loadTenantPlaybookFromPath(candidatePath);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors ?? loaded.error));
  return loaded.playbook;
}

function loadPublishedOrThrow() {
  const loaded = loadTenantPlaybookFromPath(publishedPath);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors ?? loaded.error));
  return loaded.playbook;
}

test("phase11: publish candidate loads and passes full publish validation", async () => {
  const result = await runPublishValidation({
    mode: PUBLISH_VALIDATION_MODES.CANDIDATE,
    playbookPath: candidatePath,
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.mode, "candidate");
  assert.equal(result.approved_for_runtime, false);
  assert.equal(result.runtime_binding_active, false);
  assert.equal(result.founder_approval, "pending");
  assert.equal(result.playbook_eval.fail, 0);
  assert.equal(result.playbook_eval.pending, 0);
  assert.ok(result.playbook_eval.pass >= 30);
  assert.equal(result.decision_eval.fail, 0);
  assert.equal(result.decision_eval.pending, 0);
});

test("phase11: missing publish_candidate metadata fails validation", () => {
  const playbook = loadCandidateOrThrow();
  const { publish_candidate, ...withoutMeta } = playbook;
  const failures = validatePublishCandidateMetadata(withoutMeta);
  assert.ok(failures.includes("publish_candidate_metadata_missing"));
});

test("phase11: approved_for_runtime=true without published status fails", () => {
  const playbook = loadCandidateOrThrow();
  const invalid = {
    ...playbook,
    status: "draft",
    approval: { ...playbook.approval, approved_for_runtime: true },
  };
  const failures = validateApprovalMetadata(invalid);
  assert.ok(failures.includes("approved_for_runtime_requires_published_status"));
});

test("phase11: runtime_binding.active=true on candidate fails publish validation", async () => {
  const playbook = loadCandidateOrThrow();
  const invalid = {
    ...playbook,
    runtime_binding: { ...playbook.runtime_binding, active: true },
    status: "published",
    approval: { ...playbook.approval, approved_for_runtime: true },
  };
  const result = await validatePlaybookForPublish({
    playbook: invalid,
    mode: PUBLISH_VALIDATION_MODES.CANDIDATE,
    playbookPath: candidatePath,
    skipEval: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("governance_artifact_runtime_binding_must_be_inactive"));
});

test("phase11: duplicate or empty playbook_version fails", async () => {
  const playbook = loadCandidateOrThrow();
  const emptyVersion = { ...playbook, playbook_version: "  " };
  const emptyResult = await validatePlaybookForPublish({
    playbook: emptyVersion,
    mode: PUBLISH_VALIDATION_MODES.CANDIDATE,
    playbookPath: candidatePath,
    skipEval: true,
  });
  assert.equal(emptyResult.ok, false);
  assert.ok(emptyResult.failures.includes("playbook_version_empty"));

  const duplicate = { ...playbook, playbook_version: "technolohit-playbook-v1-20260611" };
  const dupResult = await validatePlaybookForPublish({
    playbook: duplicate,
    mode: PUBLISH_VALIDATION_MODES.CANDIDATE,
    playbookPath: candidatePath,
    skipEval: true,
  });
  assert.equal(dupResult.ok, false);
  assert.ok(dupResult.failures.includes("playbook_version_not_unique"));
});

test("phase11: missing source commit/reference fails", async () => {
  const playbook = loadCandidateOrThrow();
  const withoutCommit = {
    ...playbook,
    publish_candidate: { ...playbook.publish_candidate, source_commit_sha: "" },
  };
  const failures = validatePublishCandidateMetadata(withoutCommit);
  assert.ok(failures.includes("publish_candidate_missing_source_commit_sha"));

  const withoutSource = {
    ...playbook,
    source_of_truth: { human_approved_markdown: "" },
  };
  const result = await validatePlaybookForPublish({
    playbook: withoutSource,
    mode: PUBLISH_VALIDATION_MODES.CANDIDATE,
    playbookPath: candidatePath,
    skipEval: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((entry) => entry.includes("source_of_truth")));
});

test("phase11: eval fail/pending blocks candidate", async () => {
  const playbook = loadCandidateOrThrow();
  const broken = {
    ...playbook,
    eval_scenarios: playbook.eval_scenarios.filter((entry) => entry.id !== "closing_after_product_answer"),
  };
  const result = await validatePlaybookForPublish({
    playbook: broken,
    mode: PUBLISH_VALIDATION_MODES.CANDIDATE,
    playbookPath: candidatePath,
    skipEval: false,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.includes("playbook_eval_failed") ||
      result.failures.some((entry) => entry.startsWith("eval_coverage"))
  );
});

test("phase11: forbidden pricing/guarantee claim fails", async () => {
  const playbook = loadCandidateOrThrow();
  const products = playbook.products.map((product) =>
    product.id === "smart_website"
      ? {
          ...product,
          pricing_answer: "Wir bieten einen Festpreis für alle Kunden.",
        }
      : product
  );
  const result = await validatePlaybookForPublish({
    playbook: { ...playbook, products },
    mode: PUBLISH_VALIDATION_MODES.CANDIDATE,
    playbookPath: candidatePath,
    skipEval: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((entry) => entry.startsWith("forbidden_claim:")));
});

test("phase11: callback and contact policies required", async () => {
  const playbook = loadCandidateOrThrow();
  const { callback_policy, ...withoutCallback } = playbook;
  const result = await validatePlaybookForPublish({
    playbook: withoutCallback,
    mode: PUBLISH_VALIDATION_MODES.CANDIDATE,
    playbookPath: candidatePath,
    skipEval: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("missing_field:callback_policy"));
});

test("phase11: privacy capture restrictions required", async () => {
  const playbook = loadCandidateOrThrow();
  const relaxed = {
    ...playbook,
    contact_capture_policy: {
      ...playbook.contact_capture_policy,
      no_email_capture_by_voice: false,
    },
  };
  const result = await validatePlaybookForPublish({
    playbook: relaxed,
    mode: PUBLISH_VALIDATION_MODES.CANDIDATE,
    playbookPath: candidatePath,
    skipEval: true,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.includes("contact_capture_missing_no_email_rule") ||
      result.failures.includes("privacy_no_email_capture_required")
  );
});

test("phase11: CLI output is privacy-safe (no product prose, phone, email, secrets)", async () => {
  const result = await runPublishValidation({
    mode: PUBLISH_VALIDATION_MODES.CANDIDATE,
    playbookPath: candidatePath,
  });
  const output = formatPublishValidationOutput(result);
  assert.doesNotThrow(() => assertPublishValidationOutputIsPrivacySafe(output));
  assert.match(output, /^playbook_publish_validation=(pass|fail)/m);
  assert.doesNotMatch(output, /@/);
  assert.doesNotMatch(output, /Smart Website/i);
});

test("phase11: production defaults unchanged (v4 playbook runtime off)", () => {
  const config = loadConfig();
  assert.equal(config.v4.playbookRuntimeEnabled, false);
  const policy = resolveBehaviorPolicy({ config });
  assert.equal(policy.source, "hardcoded_default");
  assert.equal(
    policy.callback_lead_capture_response,
    HARDCODED_BEHAVIOR_DEFAULTS.callback_lead_capture_response
  );
});

test("phase11: required eval coverage categories exist on candidate", () => {
  const playbook = loadCandidateOrThrow();
  for (const category of REQUIRED_PUBLISH_EVAL_COVERAGE) {
    assert.ok(
      Array.isArray(playbook.eval_coverage?.[category]) && playbook.eval_coverage[category].length > 0,
      category
    );
  }
});

test("phase11: draft baseline playbook remains separate from publish candidate", () => {
  const draft = loadTenantPlaybook();
  assert.equal(draft.ok, true);
  assert.notEqual(draft.playbook.playbook_version, loadCandidateOrThrow().playbook_version);
  assert.equal(draft.playbook.publish_candidate, undefined);
});

test("phase11: candidate file exists and is immutable artifact path", () => {
  assert.equal(fs.existsSync(candidatePath), true);
  assert.match(candidatePath, /publish-candidate\.json$/);
});

test("phase11a: published artifact passes published-mode validation while inactive", async () => {
  const result = await runPublishValidation({
    mode: PUBLISH_VALIDATION_MODES.PUBLISHED,
    playbookPath: publishedPath,
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.mode, "published");
  assert.equal(result.status, "published");
  assert.equal(result.approved_for_runtime, true);
  assert.equal(result.runtime_binding_active, false);
  assert.equal(result.founder_approval, "approved");
  assert.equal(result.playbook_eval.fail, 0);
  assert.equal(result.playbook_eval.pending, 0);
  assert.equal(result.decision_eval.fail, 0);
  assert.equal(result.decision_eval.pending, 0);
});

test("phase11a: mode and artifact mismatch fails closed", async () => {
  const candidateAsPublished = await runPublishValidation({
    mode: PUBLISH_VALIDATION_MODES.PUBLISHED,
    playbookPath: candidatePath,
    skipEval: true,
  });
  assert.equal(candidateAsPublished.ok, false);
  assert.ok(candidateAsPublished.failures.includes("published_status_required"));

  const publishedAsCandidate = await runPublishValidation({
    mode: PUBLISH_VALIDATION_MODES.CANDIDATE,
    playbookPath: publishedPath,
    skipEval: true,
  });
  assert.equal(publishedAsCandidate.ok, false);
  assert.ok(publishedAsCandidate.failures.includes("candidate_status_must_be_draft"));
});

test("phase11a: CLI contract requires explicit mode and artifact path", async () => {
  const missingMode = await runPublishValidation({ playbookPath: candidatePath, skipEval: true });
  assert.equal(missingMode.ok, false);
  assert.deepEqual(missingMode.failures, ["publish_validation_mode_required"]);

  const missingPath = await runPublishValidation({
    mode: PUBLISH_VALIDATION_MODES.CANDIDATE,
    skipEval: true,
  });
  assert.equal(missingPath.ok, false);
  assert.deepEqual(missingPath.failures, ["playbook_artifact_path_required"]);
});

test("phase11a: published artifact requires founder approval metadata and exact date", () => {
  const playbook = loadPublishedOrThrow();
  assert.equal(playbook.approval.approval_owner, "Mojtaba, Founder of TechnoloHit");
  assert.equal(playbook.approval.approval_date, "2026-06-22");
  assert.equal(playbook.approval.founder_approval, "approved");
  assert.equal(playbook.published_release.approval_owner, "Mojtaba");
  assert.equal(playbook.published_release.publication_date, "2026-06-22");

  const invalid = {
    ...playbook,
    approval: { ...playbook.approval, approval_date: "" },
  };
  assert.ok(
    validateGovernanceMode(invalid, PUBLISH_VALIDATION_MODES.PUBLISHED).includes(
      "published_approval_date_invalid"
    )
  );

  const prematureCanaryApproval = {
    ...playbook,
    approval: { ...playbook.approval, canary_approval: "approved" },
  };
  assert.ok(
    validateGovernanceMode(prematureCanaryApproval, PUBLISH_VALIDATION_MODES.PUBLISHED).includes(
      "published_canary_approval_must_be_pending"
    )
  );
});

test("phase11a: published v1 excludes Botinteg and records approved founder wording", () => {
  const playbook = loadPublishedOrThrow();
  assert.equal(playbook.products.some((product) => product.id === "botinteg"), false);
  assert.equal(playbook.allowed_topics.some((topic) => /botinteg/i.test(topic)), false);
  assert.doesNotMatch(JSON.stringify(playbook), /botinteg/i);
  assert.equal(
    playbook.callback_policy.finalized_confirmation,
    APPROVED_CALLBACK_FINALIZED_WORDING
  );
  assert.equal(
    playbook.contact_capture_policy.caller_id_policy.phone_capture_failure_phrase,
    APPROVED_NO_VALID_PHONE_WORDING
  );
});

test("phase11a: top-level approved_for_runtime is rejected and nested field is authoritative", async () => {
  const playbook = loadPublishedOrThrow();
  const invalid = { ...playbook, approved_for_runtime: false };
  const approvalFailures = validateApprovalMetadata(invalid);
  assert.ok(approvalFailures.includes("unexpected_top_level_approved_for_runtime"));

  const result = await validatePlaybookForPublish({
    playbook: invalid,
    mode: PUBLISH_VALIDATION_MODES.PUBLISHED,
    playbookPath: publishedPath,
    skipEval: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.approved_for_runtime, true);
});

test("phase11a: published runtime activation is forbidden even after content approval", async () => {
  const playbook = loadPublishedOrThrow();
  const invalid = {
    ...playbook,
    runtime_binding: { ...playbook.runtime_binding, active: true },
  };
  const result = await validatePlaybookForPublish({
    playbook: invalid,
    mode: PUBLISH_VALIDATION_MODES.PUBLISHED,
    playbookPath: publishedPath,
    skipEval: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("governance_artifact_runtime_binding_must_be_inactive"));
});

test("phase11a: candidate and published versions are unique", () => {
  const candidate = loadCandidateOrThrow();
  const published = loadPublishedOrThrow();
  assert.notEqual(candidate.playbook_version, published.playbook_version);
  assert.notEqual(published.playbook_version, loadTenantPlaybook().playbook.playbook_version);
});

test("phase11a: published CLI output is privacy-safe and mode-explicit", async () => {
  const result = await runPublishValidation({
    mode: PUBLISH_VALIDATION_MODES.PUBLISHED,
    playbookPath: publishedPath,
  });
  const output = formatPublishValidationOutput(result);
  assert.doesNotThrow(() => assertPublishValidationOutputIsPrivacySafe(output));
  assert.match(output, /^validation_mode=published$/m);
  assert.doesNotMatch(output, /@|Smart Website|www\.technolohit\.com/i);
});

test("phase11a: CLI process fails closed without explicit mode and path", () => {
  const missingArgs = spawnSync(process.execPath, [cliPath, "--skip-eval"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(missingArgs.status, 1);
  assert.match(missingArgs.stdout, /failures=publish_validation_mode_required/);
  assert.doesNotThrow(() => assertPublishValidationOutputIsPrivacySafe(missingArgs.stdout));
});

test("phase11a: CLI process rejects published artifact in candidate mode", () => {
  const mismatch = spawnSync(
    process.execPath,
    [
      cliPath,
      "--mode=candidate",
      `--playbook=${publishedPath}`,
      "--skip-eval",
    ],
    { cwd: packageRoot, encoding: "utf8" }
  );
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stdout, /candidate_status_must_be_draft/);
  assert.doesNotThrow(() => assertPublishValidationOutputIsPrivacySafe(mismatch.stdout));
});
