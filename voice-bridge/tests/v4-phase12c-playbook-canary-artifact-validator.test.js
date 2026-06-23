/**
 * Phase 12C — runtime packaged artifact validator tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PHASE12B_APPROVED_BINDING,
  PHASE12B_PENDING_BINDING,
  PHASE12B_PLAYBOOK_SHA256,
  PHASE12B_PUBLISHED_ARTIFACT,
  assertPlaybookCanaryArtifactOutputIsPrivacySafe,
  formatPlaybookCanaryArtifactValidation,
  validateDockerPackagingInRepository,
  validatePlaybookCanaryArtifacts,
} from "../src/v4/playbook-canary-artifact-validator.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function copyPackagedArtifacts(targetRoot) {
  for (const relativePath of [
    PHASE12B_PUBLISHED_ARTIFACT,
    PHASE12B_PENDING_BINDING,
    PHASE12B_APPROVED_BINDING,
  ]) {
    const source = path.join(packageRoot, relativePath);
    const destination = path.join(targetRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function makeSimulatedAppLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase12c-app-"));
  copyPackagedArtifacts(root);
  return root;
}

test("12C: runtime validator passes when Dockerfile is absent", () => {
  const root = makeSimulatedAppLayout();
  try {
    assert.equal(fs.existsSync(path.join(root, "Dockerfile")), false);
    const result = validatePlaybookCanaryArtifacts({ packageRoot: root });
    const output = formatPlaybookCanaryArtifactValidation(result);
    assert.equal(result.ok, true, output);
    assert.equal(result.packagedArtifactsPresent, true);
    assert.doesNotMatch(output, /docker_config_copy_verified/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("12C: runtime validator passes inside simulated packaged /app layout", () => {
  const root = makeSimulatedAppLayout();
  try {
    const result = validatePlaybookCanaryArtifacts({ packageRoot: root });
    assert.equal(result.ok, true, result.failures.join(","));
    assert.equal(result.pendingRejected, true);
    assert.equal(result.approvedResolved, true);
    assert.equal(result.publishedSha256, PHASE12B_PLAYBOOK_SHA256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("12C: missing published playbook fails safely", () => {
  const root = makeSimulatedAppLayout();
  try {
    fs.unlinkSync(path.join(root, PHASE12B_PUBLISHED_ARTIFACT));
    const result = validatePlaybookCanaryArtifacts({ packageRoot: root });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.includes("packaged_artifacts_missing") ||
        result.failures.includes("artifact_read_or_parse_failed"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("12C: missing approved binding fails safely", () => {
  const root = makeSimulatedAppLayout();
  try {
    fs.unlinkSync(path.join(root, PHASE12B_APPROVED_BINDING));
    const result = validatePlaybookCanaryArtifacts({ packageRoot: root });
    assert.equal(result.ok, false);
    assert.ok(
      result.failures.includes("packaged_artifacts_missing") ||
        result.failures.includes("artifact_read_or_parse_failed"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("12C: checksum mismatch fails safely", () => {
  const root = makeSimulatedAppLayout();
  try {
    const approvedPath = path.join(root, PHASE12B_APPROVED_BINDING);
    const approved = JSON.parse(fs.readFileSync(approvedPath, "utf8"));
    approved.sha256 = "0".repeat(64);
    fs.writeFileSync(approvedPath, `${JSON.stringify(approved, null, 2)}\n`);
    const result = validatePlaybookCanaryArtifacts({ packageRoot: root });
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes("approved_sha256_mismatch"));
    assert.ok(result.failures.includes("approved_binding_resolution_failed"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("12C: CLI output is privacy-safe", () => {
  const result = validatePlaybookCanaryArtifacts();
  const output = formatPlaybookCanaryArtifactValidation(result);
  assert.doesNotThrow(() => assertPlaybookCanaryArtifactOutputIsPrivacySafe(output));
  assert.match(output, /^playbook_canary_artifact_validation=pass/m);
  assert.match(output, /^packaged_artifacts_present=true$/m);
  assert.doesNotMatch(output, /@/);
});

test("12C: repository Docker packaging checks stay in CI tests only", () => {
  const docker = validateDockerPackagingInRepository(packageRoot);
  assert.equal(docker.ok, true, docker.failures.join(","));
});

test("12C: published checksum contract unchanged", () => {
  const bytes = fs.readFileSync(path.join(packageRoot, PHASE12B_PUBLISHED_ARTIFACT));
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256, PHASE12B_PLAYBOOK_SHA256);
});

test("12C: artifact validator CLI exits zero in repository", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/playbook-canary-artifact-validate.js"],
    { cwd: packageRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^playbook_canary_artifact_validation=pass/m);
  assert.match(result.stdout, /^packaged_artifacts_present=true$/m);
});
