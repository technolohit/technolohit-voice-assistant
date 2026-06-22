/**
 * Phase 12B non-live repository artifact validation.
 *
 * This validates immutable bytes and approval metadata only. It does not
 * inspect or claim that runtime/server environment gates are enabled.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPlaybookRuntimeBinding,
  validatePlaybookRuntimeBinding,
} from "./playbook-runtime-binding.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const PHASE12B_PLAYBOOK_VERSION =
  "technolohit-playbook-v1-20260622-published";
export const PHASE12B_PLAYBOOK_SHA256 =
  "f8bb259a09d409242b876939ebefb63bf7031bb6bccbaa70e8e1b56cb786a21c";
export const PHASE12B_PUBLISHED_ARTIFACT =
  "config/playbooks/technolohit.main_voice_sales.v1.published.json";
export const PHASE12B_PENDING_BINDING =
  "config/playbook-bindings/technolohit.main_voice_sales.v1.canary.pending.json";
export const PHASE12B_APPROVED_BINDING =
  "config/playbook-bindings/technolohit.main_voice_sales.v1.canary.approved.json";

function readJson(relativePath) {
  const absolutePath = path.join(packageRoot, relativePath);
  return {
    absolutePath,
    bytes: fs.readFileSync(absolutePath),
    value: JSON.parse(fs.readFileSync(absolutePath, "utf8")),
  };
}

function addFailure(failures, condition, code) {
  if (!condition) failures.push(code);
}

export function validatePlaybookCanaryArtifacts() {
  const failures = [];
  let published;
  let pending;
  let approved;

  try {
    published = readJson(PHASE12B_PUBLISHED_ARTIFACT);
    pending = readJson(PHASE12B_PENDING_BINDING);
    approved = readJson(PHASE12B_APPROVED_BINDING);
  } catch {
    return {
      ok: false,
      failures: ["artifact_read_or_parse_failed"],
      publishedSha256: "none",
      pendingRejected: false,
      approvedResolved: false,
    };
  }

  const publishedSha256 = crypto
    .createHash("sha256")
    .update(published.bytes)
    .digest("hex");
  addFailure(
    failures,
    publishedSha256 === PHASE12B_PLAYBOOK_SHA256,
    "published_sha256_mismatch",
  );
  addFailure(
    failures,
    published.value.playbook_version === PHASE12B_PLAYBOOK_VERSION,
    "published_version_mismatch",
  );
  addFailure(
    failures,
    published.value.runtime_binding?.active === false,
    "published_embedded_binding_not_inactive",
  );

  const pendingSchema = validatePlaybookRuntimeBinding(pending.value);
  failures.push(...pendingSchema.failures.map((code) => `pending_${code}`));
  addFailure(failures, pending.value.status === "pending", "pending_status_changed");
  addFailure(failures, pending.value.active === false, "pending_became_active");
  addFailure(
    failures,
    pending.value.sha256 === PHASE12B_PLAYBOOK_SHA256,
    "pending_sha256_mismatch",
  );
  addFailure(
    failures,
    pending.value.playbook_version === PHASE12B_PLAYBOOK_VERSION,
    "pending_version_mismatch",
  );

  const pendingLoad = loadPlaybookRuntimeBinding({
    bindingPath: pending.absolutePath,
    tenantId: "technolohit",
    agentId: "main_voice_sales",
  });
  const pendingRejected =
    pendingLoad.ok === false &&
    pendingLoad.reason === "binding_status_not_approved";
  addFailure(failures, pendingRejected, "pending_activation_not_rejected");

  const approvedSchema = validatePlaybookRuntimeBinding(approved.value);
  failures.push(...approvedSchema.failures.map((code) => `approved_${code}`));
  addFailure(failures, approved.value.scope === "canary", "approved_scope_not_canary");
  addFailure(failures, approved.value.status === "approved", "approved_status_invalid");
  addFailure(failures, approved.value.active === true, "approved_binding_inactive");
  addFailure(
    failures,
    approved.value.approval?.state === "approved",
    "approved_state_invalid",
  );
  addFailure(
    failures,
    approved.value.approval?.canary_only === true,
    "approved_canary_only_missing",
  );
  addFailure(
    failures,
    approved.value.approval?.production_approved === false,
    "approved_production_must_be_false",
  );
  addFailure(
    failures,
    approved.value.approval?.global_approval === false,
    "approved_global_must_be_false",
  );
  addFailure(
    failures,
    approved.value.sha256 === PHASE12B_PLAYBOOK_SHA256,
    "approved_sha256_mismatch",
  );
  addFailure(
    failures,
    approved.value.playbook_version === PHASE12B_PLAYBOOK_VERSION,
    "approved_version_mismatch",
  );

  const approvedLoad = loadPlaybookRuntimeBinding({
    bindingPath: approved.absolutePath,
    tenantId: "technolohit",
    agentId: "main_voice_sales",
  });
  const approvedResolved =
    approvedLoad.ok === true &&
    approvedLoad.sha256 === PHASE12B_PLAYBOOK_SHA256 &&
    approvedLoad.playbookVersion === PHASE12B_PLAYBOOK_VERSION;
  addFailure(failures, approvedResolved, "approved_binding_resolution_failed");

  const dockerfile = fs.readFileSync(path.join(packageRoot, "Dockerfile"), "utf8");
  const dockerCopiesConfig = /COPY\s+--chown=node:node\s+config\s+\.\/config/.test(
    dockerfile,
  );
  addFailure(failures, dockerCopiesConfig, "dockerfile_does_not_copy_config");

  return {
    ok: failures.length === 0,
    failures,
    publishedSha256,
    pendingRejected,
    approvedResolved,
    dockerCopiesConfig,
    bindingVersion: approved.value.binding_version ?? "none",
    playbookVersion: approved.value.playbook_version ?? "none",
  };
}

export function formatPlaybookCanaryArtifactValidation(result) {
  return [
    `playbook_canary_artifact_validation=${result?.ok ? "pass" : "fail"}`,
    `binding_version=${result?.bindingVersion ?? "none"}`,
    `playbook_version=${result?.playbookVersion ?? "none"}`,
    `published_sha256=${result?.publishedSha256 ?? "none"}`,
    `pending_activation_rejected=${result?.pendingRejected ? "true" : "false"}`,
    `approved_binding_resolved=${result?.approvedResolved ? "true" : "false"}`,
    `docker_config_copy_verified=${result?.dockerCopiesConfig ? "true" : "false"}`,
    `runtime_environment_checked=false`,
    `failure_count=${result?.failures?.length ?? 0}`,
    `failures=${result?.failures?.join(",") || "none"}`,
  ].join("\n");
}
