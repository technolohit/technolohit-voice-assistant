/**
 * Phase 12A immutable playbook runtime binding.
 *
 * The binding is mutable rollout metadata; the referenced published playbook
 * remains immutable. Runtime loading is fail-closed and returns reason codes.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTenantPlaybookFromPath } from "./playbook-loader.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const approvedBindingRoot = path.join(packageRoot, "config", "playbook-bindings");
const playbooksRoot = path.join(packageRoot, "config", "playbooks");

export const PLAYBOOK_BINDING_SCHEMA_VERSION = "playbook-runtime-binding-1";
export const DEFAULT_PLAYBOOK_BINDING_FILENAME =
  "technolohit.main_voice_sales.v1.canary.pending.json";

const REQUIRED_FIELDS = [
  "schema_version",
  "binding_version",
  "tenant_id",
  "agent_id",
  "playbook_version",
  "playbook_artifact",
  "sha256",
  "scope",
  "status",
  "approval",
  "active",
  "rollback_target",
];

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function runtimeRoots(testOnlyRoots) {
  return {
    packageRoot: path.resolve(testOnlyRoots?.packageRoot ?? packageRoot),
    bindingRoot: path.resolve(testOnlyRoots?.bindingRoot ?? approvedBindingRoot),
    playbooksRoot: path.resolve(testOnlyRoots?.playbooksRoot ?? playbooksRoot),
  };
}

function resolveBindingPath(input, roots) {
  if (!hasText(input)) return { ok: false, reason: "binding_path_required" };
  if (!isWithin(roots.packageRoot, roots.bindingRoot)) {
    return { ok: false, reason: "binding_path_outside_approved_root" };
  }
  const raw = input.trim();
  if (!path.isAbsolute(raw) && raw.split(/[\\/]+/).includes("..")) {
    return { ok: false, reason: "binding_path_traversal" };
  }
  const resolved = path.resolve(roots.packageRoot, raw);
  if (!isWithin(roots.bindingRoot, resolved)) {
    return { ok: false, reason: "binding_path_outside_approved_root" };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, reason: "binding_not_found" };
  }

  let realBindingRoot;
  let realBindingPath;
  let realPackageRoot;
  try {
    realPackageRoot = fs.realpathSync(roots.packageRoot);
    realBindingRoot = fs.realpathSync(roots.bindingRoot);
    realBindingPath = fs.realpathSync(resolved);
  } catch {
    return { ok: false, reason: "binding_path_resolution_failed" };
  }
  if (!isWithin(realPackageRoot, realBindingRoot)) {
    return { ok: false, reason: "binding_path_symlink_escape" };
  }
  if (!isWithin(realBindingRoot, realBindingPath)) {
    return { ok: false, reason: "binding_path_symlink_escape" };
  }
  return { ok: true, path: realBindingPath };
}

export function resolvePlaybookBindingPath(
  filename = DEFAULT_PLAYBOOK_BINDING_FILENAME,
) {
  return path.join(packageRoot, "config", "playbook-bindings", filename);
}

export function validatePlaybookRuntimeBinding(binding) {
  const failures = [];
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return { ok: false, failures: ["binding_not_an_object"] };
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in binding)) failures.push(`binding_missing_field:${field}`);
  }
  if (binding.schema_version !== PLAYBOOK_BINDING_SCHEMA_VERSION) {
    failures.push("binding_schema_version_invalid");
  }
  for (const field of [
    "binding_version",
    "tenant_id",
    "agent_id",
    "playbook_version",
    "playbook_artifact",
  ]) {
    if (!hasText(binding[field])) failures.push(`binding_${field}_invalid`);
  }
  if (!/^[a-f0-9]{64}$/.test(binding.sha256 ?? "")) {
    failures.push("binding_sha256_invalid");
  }
  if (binding.scope !== "canary") failures.push("binding_scope_not_canary");
  if (!["pending", "approved", "revoked"].includes(binding.status)) {
    failures.push("binding_status_invalid");
  }
  if (typeof binding.active !== "boolean") failures.push("binding_active_invalid");
  if (!binding.approval || typeof binding.approval !== "object") {
    failures.push("binding_approval_invalid");
  } else if (!["pending", "approved", "revoked"].includes(binding.approval.state)) {
    failures.push("binding_approval_state_invalid");
  }
  if (!binding.rollback_target || typeof binding.rollback_target !== "object") {
    failures.push("binding_rollback_target_invalid");
  } else if (binding.rollback_target.type !== "hardcoded_default") {
    failures.push("binding_rollback_target_not_hardcoded");
  }
  return { ok: failures.length === 0, failures };
}

function bindingEligibilityFailures(binding) {
  const failures = [];
  if (binding.scope !== "canary") failures.push("binding_scope_not_canary");
  if (binding.status === "revoked" || binding.approval?.state === "revoked") {
    failures.push("binding_revoked");
  } else if (binding.status !== "approved") {
    failures.push("binding_status_not_approved");
  }
  if (binding.approval?.state !== "approved") {
    failures.push("binding_approval_not_approved");
  }
  if (!hasText(binding.approval?.approved_by) || !hasText(binding.approval?.approved_at)) {
    failures.push("binding_approval_metadata_incomplete");
  }
  if (binding.active !== true) failures.push("binding_inactive");
  return failures;
}

function validatePublishedArtifactPath(artifact, roots) {
  if (!hasText(artifact) || path.isAbsolute(artifact)) {
    return { ok: false, reason: "playbook_artifact_path_invalid" };
  }
  if (artifact.split(/[\\/]+/).includes("..")) {
    return { ok: false, reason: "playbook_artifact_path_traversal" };
  }
  const resolved = path.resolve(roots.packageRoot, artifact);
  if (!isWithin(roots.playbooksRoot, resolved)) {
    return { ok: false, reason: "playbook_artifact_outside_playbooks" };
  }
  if (!resolved.endsWith(".published.json")) {
    return { ok: false, reason: "playbook_artifact_not_published" };
  }
  return { ok: true, path: resolved };
}

export function loadPlaybookRuntimeBinding({
  bindingPath,
  tenantId,
  agentId,
  testOnlyRoots,
} = {}) {
  const roots = runtimeRoots(testOnlyRoots);
  const bindingResolved = resolveBindingPath(bindingPath, roots);
  if (!bindingResolved.ok) return bindingResolved;

  let binding;
  try {
    binding = JSON.parse(fs.readFileSync(bindingResolved.path, "utf8"));
  } catch {
    return { ok: false, reason: "binding_invalid_json" };
  }

  const schema = validatePlaybookRuntimeBinding(binding);
  if (!schema.ok) {
    return {
      ok: false,
      reason: schema.failures[0] ?? "binding_validation_failed",
      failures: schema.failures,
    };
  }

  const eligibilityFailures = bindingEligibilityFailures(binding);
  if (eligibilityFailures.length) {
    return {
      ok: false,
      reason: eligibilityFailures[0],
      failures: eligibilityFailures,
      binding,
    };
  }
  if (binding.tenant_id !== tenantId) return { ok: false, reason: "binding_tenant_mismatch" };
  if (binding.agent_id !== agentId) return { ok: false, reason: "binding_agent_mismatch" };

  const artifactResolved = validatePublishedArtifactPath(binding.playbook_artifact, roots);
  if (!artifactResolved.ok) return artifactResolved;
  if (!fs.existsSync(artifactResolved.path)) {
    return { ok: false, reason: "playbook_artifact_not_found" };
  }

  let bytes;
  try {
    bytes = fs.readFileSync(artifactResolved.path);
  } catch {
    return { ok: false, reason: "playbook_artifact_read_failed" };
  }
  const actualSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== binding.sha256) {
    return { ok: false, reason: "playbook_checksum_mismatch" };
  }

  let verifiedPlaybook;
  try {
    verifiedPlaybook = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "playbook_invalid_json" };
  }
  if (verifiedPlaybook.runtime_binding?.active === true) {
    return {
      ok: false,
      reason: "playbook_embedded_runtime_binding_must_be_inactive",
    };
  }
  if (verifiedPlaybook.runtime_binding?.active !== false) {
    return {
      ok: false,
      reason: "playbook_embedded_runtime_binding_active_invalid",
    };
  }

  const loaded = loadTenantPlaybookFromPath(artifactResolved.path);
  if (!loaded.ok) {
    return { ok: false, reason: loaded.error ?? "playbook_load_failed" };
  }
  const playbook = loaded.playbook;
  if (playbook.status !== "published" || playbook.published_release?.kind !== "published_playbook") {
    return { ok: false, reason: "playbook_artifact_not_published" };
  }
  if (playbook.publish_candidate) {
    return { ok: false, reason: "playbook_candidate_rejected" };
  }
  if (playbook.playbook_version !== binding.playbook_version) {
    return { ok: false, reason: "playbook_version_mismatch" };
  }
  if (playbook.tenant_id !== binding.tenant_id) {
    return { ok: false, reason: "playbook_tenant_mismatch" };
  }
  if (playbook.agent_id !== binding.agent_id) {
    return { ok: false, reason: "playbook_agent_mismatch" };
  }
  if (
    playbook.approval?.state !== "approved" ||
    playbook.approval?.approved_for_runtime !== true ||
    playbook.approval?.founder_approval !== "approved"
  ) {
    return { ok: false, reason: "playbook_approval_invalid" };
  }

  return {
    ok: true,
    reason: "binding_approved_active",
    binding,
    playbook,
    bindingVersion: binding.binding_version,
    playbookVersion: playbook.playbook_version,
    sha256: actualSha256,
  };
}

export function isV4CanaryPathActive(config) {
  return (
    config?.v4?.runtimeVersion === "v4" &&
    config?.v4?.realtimeEnabled === true &&
    config?.v4?.canaryEnabled === true &&
    config?.v4?.liveAudioSocketEnabled === true
  );
}
