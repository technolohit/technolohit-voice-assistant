import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import {
  loadPlaybookRuntimeBinding,
  validatePlaybookRuntimeBinding,
} from "../src/v4/playbook-runtime-binding.js";
import {
  PHASE12B_APPROVED_BINDING,
  PHASE12B_PENDING_BINDING,
  PHASE12B_PLAYBOOK_SHA256,
  PHASE12B_PLAYBOOK_VERSION,
  PHASE12B_PUBLISHED_ARTIFACT,
  formatPlaybookCanaryArtifactValidation,
  validateDockerPackagingInRepository,
  validatePlaybookCanaryArtifacts,
} from "../src/v4/playbook-canary-artifact-validator.js";
import { runPlaybookCanaryPreflight } from "../src/v4/playbook-canary-preflight.js";
import { determineRagApiPublication } from "../../scripts/ci/rag-api-publication-policy.js";
import { resolveDockerImageMetadata } from "../../scripts/ci/docker-image-metadata-policy.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, relativePath), "utf8"));
}

test("12B: pending sample remains inactive and rejected for activation", () => {
  const pending = readJson(PHASE12B_PENDING_BINDING);
  assert.equal(validatePlaybookRuntimeBinding(pending).ok, true);
  assert.equal(pending.status, "pending");
  assert.equal(pending.active, false);
  const result = loadPlaybookRuntimeBinding({
    bindingPath: path.join(packageRoot, PHASE12B_PENDING_BINDING),
    tenantId: "technolohit",
    agentId: "main_voice_sales",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "binding_status_not_approved");
});

test("12B: approved binding is canary-only and resolves immutable published bytes", () => {
  const binding = readJson(PHASE12B_APPROVED_BINDING);
  assert.equal(validatePlaybookRuntimeBinding(binding).ok, true);
  assert.equal(binding.scope, "canary");
  assert.equal(binding.status, "approved");
  assert.equal(binding.active, true);
  assert.equal(binding.approval.state, "approved");
  assert.equal(binding.approval.canary_only, true);
  assert.equal(binding.approval.production_approved, false);
  assert.equal(binding.approval.global_approval, false);
  assert.equal(binding.playbook_version, PHASE12B_PLAYBOOK_VERSION);
  assert.equal(binding.sha256, PHASE12B_PLAYBOOK_SHA256);

  const result = loadPlaybookRuntimeBinding({
    bindingPath: path.join(packageRoot, PHASE12B_APPROVED_BINDING),
    tenantId: "technolohit",
    agentId: "main_voice_sales",
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.sha256, PHASE12B_PLAYBOOK_SHA256);
  assert.equal(result.playbookVersion, PHASE12B_PLAYBOOK_VERSION);
});

test("12B: published artifact checksum contract is fixed and test-visible", () => {
  const bytes = fs.readFileSync(path.join(packageRoot, PHASE12B_PUBLISHED_ARTIFACT));
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256, PHASE12B_PLAYBOOK_SHA256);
  assert.equal(readJson(PHASE12B_PUBLISHED_ARTIFACT).playbook_version, PHASE12B_PLAYBOOK_VERSION);
});

test("12B: default config ignores approved artifact and runtime preflight fails safely", () => {
  const config = loadConfig();
  config.v4.playbookBindingPath = path.join(packageRoot, PHASE12B_APPROVED_BINDING);
  assert.equal(config.v4.runtimeVersion, "v3");
  assert.equal(config.v4.playbookRuntimeEnabled, false);
  const result = runPlaybookCanaryPreflight(config);
  assert.equal(result.ok, false);
  assert.equal(result.bindingOk, false);
  assert.ok(result.failures.includes("runtime_v4_required"));
  assert.ok(result.failures.includes("playbook_runtime_enabled_required"));
});

test("12B: disabling any required v4/playbook gate prevents approved activation", () => {
  const bindingPath = path.join(packageRoot, PHASE12B_APPROVED_BINDING);
  const base = loadConfig();
  const enabled = {
    ...base,
    v4: {
      ...base.v4,
      runtimeVersion: "v4",
      realtimeEnabled: true,
      canaryEnabled: true,
      liveAudioSocketEnabled: true,
      playbookRuntimeEnabled: true,
      playbookBindingPath: bindingPath,
      tenantId: "technolohit",
      agentId: "main_voice_sales",
    },
  };
  assert.equal(runPlaybookCanaryPreflight(enabled).ok, true);
  for (const key of [
    "realtimeEnabled",
    "canaryEnabled",
    "liveAudioSocketEnabled",
    "playbookRuntimeEnabled",
  ]) {
    const config = { ...enabled, v4: { ...enabled.v4, [key]: false } };
    assert.equal(runPlaybookCanaryPreflight(config).ok, false, key);
  }
});

test("12B: repository artifact validator passes without claiming runtime env", () => {
  const result = validatePlaybookCanaryArtifacts();
  const output = formatPlaybookCanaryArtifactValidation(result);
  assert.equal(result.ok, true, output);
  assert.match(output, /^playbook_canary_artifact_validation=pass/m);
  assert.match(output, /^pending_activation_rejected=true$/m);
  assert.match(output, /^approved_binding_resolved=true$/m);
  assert.match(output, /^packaged_artifacts_present=true$/m);
  assert.match(output, /^runtime_environment_checked=false$/m);
});

test("12B: repository Docker packaging checks remain CI-only", () => {
  const docker = validateDockerPackagingInRepository(packageRoot);
  assert.equal(docker.ok, true, docker.failures.join(","));
  const dockerfile = fs.readFileSync(path.join(packageRoot, "Dockerfile"), "utf8");
  const dockerignore = fs.readFileSync(path.join(packageRoot, ".dockerignore"), "utf8");
  assert.match(dockerfile, /COPY --chown=node:node config \.\/config/);
  assert.doesNotMatch(dockerignore, /(^|\n)config(?:\/|\n)/);
  assert.equal(fs.existsSync(path.join(packageRoot, PHASE12B_PUBLISHED_ARTIFACT)), true);
  assert.equal(fs.existsSync(path.join(packageRoot, PHASE12B_APPROVED_BINDING)), true);
});

test("12B: Docker Publish always publishes voice and conditionally publishes RAG", () => {
  const workflow = fs.readFileSync(
    path.join(packageRoot, "..", ".github", "workflows", "docker-publish.yml"),
    "utf8",
  );
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /id:\s*rag_changes/);
  assert.match(workflow, /detect-rag-api-publication\.js/);
  assert.match(workflow, /name: Build and push voice-bridge/);
  assert.doesNotMatch(
    workflow.match(/- name: Build and push voice-bridge[\s\S]*?(?=\n\s+- name:)/)?.[0] ?? "",
    /\n\s+if:/,
  );
  assert.match(
    workflow,
    /- name: Build and push rag-api[\s\S]*?if:\s*steps\.rag_changes\.outputs\.publish == 'true'/,
  );
  assert.match(workflow, /RAG API publication:.*skipped|rag_status/);
  assert.match(workflow, /resolve-docker-image-metadata\.js/);
  assert.match(
    workflow,
    /org\.opencontainers\.image\.version=\$\{\{ steps\.meta\.outputs\.voice_oci_version \}\}/,
  );
  assert.match(
    workflow,
    /org\.opencontainers\.image\.version=\$\{\{ steps\.meta\.outputs\.rag_oci_version \}\}/,
  );
});

test("12B follow-up: semver tags set deterministic OCI versions", () => {
  const result = resolveDockerImageMetadata({
    sha: "1234567890abcdef",
    refType: "tag",
    refName: "v1.36.1",
    eventName: "push",
  });
  assert.equal(result.shortSha, "1234567");
  assert.equal(result.versionTag, "v1.36.1");
  assert.equal(result.voiceOciVersion, "voice-bridge-v1.36.1");
  assert.equal(result.ragOciVersion, "rag-api-v1.36.1");
  assert.equal(result.publishLatest, true);
});

test("12B follow-up: manual builds use short SHA OCI versions", () => {
  const result = resolveDockerImageMetadata({
    sha: "abcdef1234567890",
    refType: "branch",
    refName: "main",
    eventName: "workflow_dispatch",
    publishLatestInput: "false",
  });
  assert.equal(result.shortSha, "abcdef1");
  assert.equal(result.versionTag, "");
  assert.equal(result.voiceOciVersion, "voice-bridge-abcdef1");
  assert.equal(result.ragOciVersion, "rag-api-abcdef1");
  assert.equal(result.publishLatest, false);
});

test("12B: approved binding rejects production_approved or global_approval", () => {
  const binding = readJson(PHASE12B_APPROVED_BINDING);
  const production = {
    ...binding,
    approval: { ...binding.approval, production_approved: true },
  };
  assert.equal(validatePlaybookRuntimeBinding(production).ok, false);
  const global = {
    ...binding,
    approval: { ...binding.approval, global_approval: true },
  };
  assert.equal(validatePlaybookRuntimeBinding(global).ok, false);
});

test("12B: RAG publication policy skips unchanged and publishes changed source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase12b-rag-policy-"));
  try {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "phase12b@example.invalid"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Phase 12B"], { cwd: root });
    fs.mkdirSync(path.join(root, "rag-api"), { recursive: true });
    fs.mkdirSync(path.join(root, "voice-bridge"), { recursive: true });
    fs.writeFileSync(path.join(root, "rag-api", "app.py"), "print('v1')\n");
    fs.writeFileSync(path.join(root, "voice-bridge", "index.js"), "console.log('v1');\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["tag", "v1.35.3"], { cwd: root });

    fs.writeFileSync(path.join(root, "voice-bridge", "index.js"), "console.log('v2');\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "voice only"], { cwd: root, stdio: "ignore" });
    const unchanged = determineRagApiPublication({ cwd: root });
    assert.equal(unchanged.publish, false);
    assert.equal(unchanged.reason, "rag_api_unchanged_since_v1.35.3");

    fs.writeFileSync(path.join(root, "rag-api", "app.py"), "print('v2')\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "rag changed"], { cwd: root, stdio: "ignore" });
    const changed = determineRagApiPublication({ cwd: root });
    assert.equal(changed.publish, true);
    assert.equal(changed.reason, "rag_api_changed_since_v1.35.3");

    assert.equal(
      determineRagApiPublication({ cwd: root, requested: "false" }).reason,
      "explicit_skip",
    );
    assert.equal(
      determineRagApiPublication({ cwd: root, requested: "true" }).reason,
      "explicit_override",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
