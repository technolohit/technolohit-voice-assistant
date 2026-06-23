/**
 * Phase 12B/12C packaged playbook canary artifact validation.
 *
 * Validates immutable bytes and approval metadata for artifacts present inside
 * the runtime image (/app). It does not read Dockerfile or .dockerignore.
 * Docker build-context checks belong in repository CI tests only.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPlaybookRuntimeBinding,
  validatePlaybookRuntimeBinding,
} from "./playbook-runtime-binding.js";

const defaultPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

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

const PACKAGED_ARTIFACT_PATHS = [
  PHASE12B_PUBLISHED_ARTIFACT,
  PHASE12B_PENDING_BINDING,
  PHASE12B_APPROVED_BINDING,
];

const PRIVACY_UNSAFE_OUTPUT_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\+?\d{2,}[\d\s().-]{6,}\d\b/,
  /\b(sk-[a-zA-Z0-9]{10,}|AKIA[0-9A-Z]{16})\b/,
  /TechnoloHit hilft Unternehmen/i,
  /Darf unser Team Sie unter dieser Nummer/i,
  /(?:\/|\\)(?:Users|home|opt|app)[\\/]/i,
];

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveValidatorPackageRoot(packageRoot = null) {
  return path.resolve(packageRoot ?? defaultPackageRoot);
}

function runtimeRootsForPackage(packageRoot) {
  const resolved = resolveValidatorPackageRoot(packageRoot);
  return {
    packageRoot: resolved,
    bindingRoot: path.join(resolved, "config", "playbook-bindings"),
    playbooksRoot: path.join(resolved, "config", "playbooks"),
  };
}

function readJson(relativePath, packageRoot) {
  const absolutePath = path.join(resolveValidatorPackageRoot(packageRoot), relativePath);
  return {
    absolutePath,
    bytes: fs.readFileSync(absolutePath),
    value: JSON.parse(fs.readFileSync(absolutePath, "utf8")),
  };
}

function addFailure(failures, condition, code) {
  if (!condition) failures.push(code);
}

function packagedArtifactsPresent(packageRoot) {
  const root = resolveValidatorPackageRoot(packageRoot);
  return PACKAGED_ARTIFACT_PATHS.every((relativePath) =>
    fs.existsSync(path.join(root, relativePath)),
  );
}

/**
 * Repository-only Docker packaging checks (CI tests). Not for runtime CLI.
 */
export function validateDockerPackagingInRepository(packageRoot = defaultPackageRoot) {
  const failures = [];
  const root = resolveValidatorPackageRoot(packageRoot);
  const dockerfilePath = path.join(root, "Dockerfile");
  const dockerignorePath = path.join(root, ".dockerignore");

  if (!fs.existsSync(dockerfilePath)) {
    failures.push("dockerfile_missing");
    return { ok: false, failures };
  }

  const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  const dockerCopiesConfig = /COPY\s+--chown=node:node\s+config\s+\.\/config/.test(
    dockerfile,
  );
  addFailure(failures, dockerCopiesConfig, "dockerfile_does_not_copy_config");

  if (fs.existsSync(dockerignorePath)) {
    const dockerignore = fs.readFileSync(dockerignorePath, "utf8");
    addFailure(
      failures,
      !/(^|\n)config(?:\/|\n)/.test(dockerignore),
      "dockerignore_excludes_config",
    );
  }

  for (const relativePath of PACKAGED_ARTIFACT_PATHS) {
    addFailure(
      failures,
      fs.existsSync(path.join(root, relativePath)),
      `packaged_artifact_missing:${relativePath}`,
    );
  }

  return { ok: failures.length === 0, failures, dockerCopiesConfig };
}

export function validatePlaybookCanaryArtifacts({ packageRoot = null } = {}) {
  const failures = [];
  const roots = runtimeRootsForPackage(packageRoot);
  const artifactsPresent = packagedArtifactsPresent(roots.packageRoot);
  addFailure(failures, artifactsPresent, "packaged_artifacts_missing");

  let published;
  let pending;
  let approved;

  try {
    published = readJson(PHASE12B_PUBLISHED_ARTIFACT, roots.packageRoot);
    pending = readJson(PHASE12B_PENDING_BINDING, roots.packageRoot);
    approved = readJson(PHASE12B_APPROVED_BINDING, roots.packageRoot);
  } catch {
    return {
      ok: false,
      failures: failures.length ? failures : ["artifact_read_or_parse_failed"],
      publishedSha256: "none",
      pendingRejected: false,
      approvedResolved: false,
      packagedArtifactsPresent: artifactsPresent,
      bindingVersion: "none",
      playbookVersion: "none",
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
  addFailure(
    failures,
    published.value.approval?.approved_for_runtime === true,
    "published_approval_invalid",
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
    testOnlyRoots: roots,
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
    testOnlyRoots: roots,
  });
  const approvedResolved =
    approvedLoad.ok === true &&
    approvedLoad.sha256 === PHASE12B_PLAYBOOK_SHA256 &&
    approvedLoad.playbookVersion === PHASE12B_PLAYBOOK_VERSION;
  addFailure(failures, approvedResolved, "approved_binding_resolution_failed");

  return {
    ok: failures.length === 0,
    failures,
    publishedSha256,
    pendingRejected,
    approvedResolved,
    packagedArtifactsPresent: artifactsPresent,
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
    `packaged_artifacts_present=${result?.packagedArtifactsPresent ? "true" : "false"}`,
    `runtime_environment_checked=false`,
    `failure_count=${result?.failures?.length ?? 0}`,
    `failures=${result?.failures?.join(",") || "none"}`,
  ].join("\n");
}

export function assertPlaybookCanaryArtifactOutputIsPrivacySafe(output) {
  const text = String(output ?? "");
  for (const pattern of PRIVACY_UNSAFE_OUTPUT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error("privacy_violation:unsafe_cli_output");
    }
  }
  if (hasNonEmptyString(text) && /\bconfig\/playbooks\b/.test(text)) {
    throw new Error("privacy_violation:raw_artifact_path");
  }
  return true;
}
