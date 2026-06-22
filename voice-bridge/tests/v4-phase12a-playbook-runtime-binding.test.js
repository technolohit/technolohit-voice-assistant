import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { resolveBehaviorPolicy } from "../src/v4/behavior-policy.js";
import {
  loadPlaybookRuntimeBinding,
  validatePlaybookRuntimeBinding,
} from "../src/v4/playbook-runtime-binding.js";
import {
  assertPlaybookCanaryPreflightOutputIsSafe,
  formatPlaybookCanaryPreflight,
  runPlaybookCanaryPreflight,
} from "../src/v4/playbook-canary-preflight.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publishedPath = path.join(
  packageRoot,
  "config",
  "playbooks",
  "technolohit.main_voice_sales.v1.published.json",
);
const published = JSON.parse(fs.readFileSync(publishedPath, "utf8"));
const publishedSha = crypto
  .createHash("sha256")
  .update(fs.readFileSync(publishedPath))
  .digest("hex");

function approvedBinding(overrides = {}) {
  return {
    schema_version: "playbook-runtime-binding-1",
    binding_version: "phase12a-test-binding-v1",
    tenant_id: published.tenant_id,
    agent_id: published.agent_id,
    playbook_version: published.playbook_version,
    playbook_artifact: "config/playbooks/technolohit.main_voice_sales.v1.published.json",
    sha256: publishedSha,
    scope: "canary",
    status: "approved",
    approval: {
      state: "approved",
      approved_by: "phase12a-test",
      approved_at: "2026-06-22T00:00:00Z",
      canary_only: true,
      production_approved: false,
      global_approval: false,
    },
    active: true,
    rollback_target: {
      type: "hardcoded_default",
      binding_version: null,
      playbook_version: null,
    },
    ...overrides,
  };
}

function writeFixture({
  playbook = published,
  bindingOverrides = {},
  bindingContent = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase12a-root-"));
  const bindingRoot = path.join(root, "config", "playbook-bindings");
  const fixturePlaybooksRoot = path.join(root, "config", "playbooks");
  fs.mkdirSync(bindingRoot, { recursive: true });
  fs.mkdirSync(fixturePlaybooksRoot, { recursive: true });

  const artifactName = "fixture.published.json";
  const artifactPath = path.join(fixturePlaybooksRoot, artifactName);
  const artifactBytes = Buffer.from(JSON.stringify(playbook), "utf8");
  fs.writeFileSync(artifactPath, artifactBytes);
  const sha256 = crypto.createHash("sha256").update(artifactBytes).digest("hex");
  const binding = approvedBinding({
    playbook_artifact: `config/playbooks/${artifactName}`,
    sha256,
    ...bindingOverrides,
  });
  const bindingPath = path.join(bindingRoot, "binding.json");
  fs.writeFileSync(
    bindingPath,
    bindingContent ?? JSON.stringify(binding),
    "utf8",
  );
  return {
    root,
    bindingRoot,
    playbooksRoot: fixturePlaybooksRoot,
    bindingPath,
    artifactPath,
    binding,
    testOnlyRoots: {
      packageRoot: root,
      bindingRoot,
      playbooksRoot: fixturePlaybooksRoot,
    },
  };
}

function canaryConfig(bindingPath) {
  const config = loadConfig();
  return {
    ...config,
    v4: {
      ...config.v4,
      runtimeVersion: "v4",
      realtimeEnabled: true,
      canaryEnabled: true,
      liveAudioSocketEnabled: true,
      playbookRuntimeEnabled: true,
      playbookBindingPath: bindingPath,
      tenantId: published.tenant_id,
      agentId: published.agent_id,
    },
  };
}

function load(bindingOverrides = {}, playbook = published) {
  const fixture = writeFixture({ playbook, bindingOverrides });
  try {
    return loadPlaybookRuntimeBinding({
      bindingPath: fixture.bindingPath,
      tenantId: published.tenant_id,
      agentId: published.agent_id,
      testOnlyRoots: fixture.testOnlyRoots,
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("12A: repository binding sample is pending and inactive", () => {
  const sample = JSON.parse(
    fs.readFileSync(
      path.join(
        packageRoot,
        "config",
        "playbook-bindings",
        "technolohit.main_voice_sales.v1.canary.pending.json",
      ),
      "utf8",
    ),
  );
  assert.equal(validatePlaybookRuntimeBinding(sample).ok, true);
  assert.equal(sample.scope, "canary");
  assert.equal(sample.status, "pending");
  assert.equal(sample.active, false);
  assert.equal(sample.sha256, publishedSha);
});

test("12A: default-off ignores broken binding and legacy playbook paths", () => {
  const config = loadConfig();
  config.v4.playbookBindingPath = "C:/missing/private-binding.json";
  config.v4.playbookPath = "C:/missing/legacy-playbook.json";
  const policy = resolveBehaviorPolicy({ config, v4PathActive: true });
  assert.equal(policy.source, "hardcoded_default");
  assert.equal(policy.reason, "playbook_runtime_disabled");
});

test("12A: approved active canary binding loads exact immutable playbook", () => {
  const result = load();
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.playbookVersion, published.playbook_version);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test("12A: valid binding activates policy only on active v4 canary path", () => {
  const fixture = writeFixture();
  try {
    const config = canaryConfig(fixture.bindingPath);
    const active = resolveBehaviorPolicy({
      config,
      testOnlyBindingRoots: fixture.testOnlyRoots,
    });
    assert.equal(active.source, "playbook");
    assert.equal(active.reason, "binding_approved_active");

    config.v4.canaryEnabled = false;
    const inactive = resolveBehaviorPolicy({ config });
    assert.equal(inactive.source, "hardcoded_default");
    assert.equal(inactive.reason, "v4_canary_path_inactive");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("12A: checksum, version, tenant, and agent mismatches fail closed", () => {
  assert.equal(load({ sha256: "0".repeat(64) }).reason, "playbook_checksum_mismatch");
  assert.equal(load({ playbook_version: "wrong" }).reason, "playbook_version_mismatch");
  assert.equal(load({ tenant_id: "wrong" }).reason, "binding_tenant_mismatch");
  assert.equal(load({ agent_id: "wrong" }).reason, "binding_agent_mismatch");
});

test("12A: pending, inactive, revoked, unapproved, and non-canary bindings fail closed", () => {
  assert.equal(load({ status: "pending" }).reason, "binding_status_not_approved");
  assert.equal(load({ active: false }).reason, "binding_inactive");
  assert.equal(load({ status: "revoked" }).reason, "binding_revoked");
  assert.equal(
    load({
      approval: {
        state: "pending",
        approved_by: null,
        approved_at: null,
        canary_only: true,
        production_approved: false,
        global_approval: false,
      },
    }).reason,
    "binding_approval_not_approved",
  );
  assert.equal(load({ scope: "production" }).reason, "binding_scope_not_canary");
});

test("12A: candidate, draft, and traversal artifact references are rejected", () => {
  assert.equal(
    load({ playbook_artifact: "config/playbooks/fixture.publish-candidate.json" }).reason,
    "playbook_artifact_not_published",
  );
  assert.equal(
    load({ playbook_artifact: "config/playbooks/fixture.json" }).reason,
    "playbook_artifact_not_published",
  );
  assert.equal(
    load({ playbook_artifact: "../package.json" }).reason,
    "playbook_artifact_path_traversal",
  );
  assert.equal(
    loadPlaybookRuntimeBinding({
      bindingPath: "../binding.json",
      tenantId: published.tenant_id,
      agentId: published.agent_id,
    }).reason,
    "binding_path_traversal",
  );
});

test("12A: absolute binding path outside approved root is rejected", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "phase12a-outside-"));
  const bindingPath = path.join(outside, "binding.json");
  fs.writeFileSync(bindingPath, JSON.stringify(approvedBinding()), "utf8");
  try {
    const result = loadPlaybookRuntimeBinding({
      bindingPath,
      tenantId: published.tenant_id,
      agentId: published.agent_id,
    });
    assert.equal(result.reason, "binding_path_outside_approved_root");
    assert.equal(JSON.stringify(result).includes(bindingPath), false);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("12A: relative binding traversal is rejected", () => {
  const result = loadPlaybookRuntimeBinding({
    bindingPath: "../binding.json",
    tenantId: published.tenant_id,
    agentId: published.agent_id,
  });
  assert.equal(result.reason, "binding_path_traversal");
});

test("12A: symlink from approved binding root to outside is rejected", (t) => {
  const fixture = writeFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "phase12a-symlink-target-"));
  const outsideBinding = path.join(outside, "binding.json");
  const symlinkPath = path.join(fixture.bindingRoot, "escaped-binding.json");
  fs.writeFileSync(outsideBinding, JSON.stringify(fixture.binding), "utf8");
  try {
    try {
      fs.symlinkSync(outsideBinding, symlinkPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
        t.skip(`Windows symlink creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const result = loadPlaybookRuntimeBinding({
      bindingPath: symlinkPath,
      tenantId: published.tenant_id,
      agentId: published.agent_id,
      testOnlyRoots: fixture.testOnlyRoots,
    });
    assert.equal(result.reason, "binding_path_symlink_escape");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("12A: bounded test root accepts a valid fixture without changing defaults", () => {
  const fixture = writeFixture();
  try {
    const defaultResult = loadPlaybookRuntimeBinding({
      bindingPath: fixture.bindingPath,
      tenantId: published.tenant_id,
      agentId: published.agent_id,
    });
    assert.equal(defaultResult.reason, "binding_path_outside_approved_root");

    const injectedResult = loadPlaybookRuntimeBinding({
      bindingPath: fixture.bindingPath,
      tenantId: published.tenant_id,
      agentId: published.agent_id,
      testOnlyRoots: fixture.testOnlyRoots,
    });
    assert.equal(injectedResult.ok, true, injectedResult.reason);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("12A: published artifact embedded active=true is rejected after matching checksum", () => {
  const mutated = {
    ...published,
    runtime_binding: { ...published.runtime_binding, active: true },
  };
  assert.equal(
    load({}, mutated).reason,
    "playbook_embedded_runtime_binding_must_be_inactive",
  );
});

test("12A: published artifact embedded active must exist and be boolean false", () => {
  const missing = { ...published };
  delete missing.runtime_binding;
  assert.equal(
    load({}, missing).reason,
    "playbook_embedded_runtime_binding_active_invalid",
  );

  const invalid = {
    ...published,
    runtime_binding: { ...published.runtime_binding, active: "false" },
  };
  assert.equal(
    load({}, invalid).reason,
    "playbook_embedded_runtime_binding_active_invalid",
  );
});

test("12A: missing and corrupt binding files fail closed", () => {
  assert.equal(
    loadPlaybookRuntimeBinding({
      bindingPath: path.join(os.tmpdir(), "phase12a-does-not-exist.json"),
      tenantId: published.tenant_id,
      agentId: published.agent_id,
    }).reason,
    "binding_path_outside_approved_root",
  );
  const fixture = writeFixture();
  fs.writeFileSync(fixture.bindingPath, "{", "utf8");
  try {
    assert.equal(
      loadPlaybookRuntimeBinding({
        bindingPath: fixture.bindingPath,
        tenantId: published.tenant_id,
        agentId: published.agent_id,
        testOnlyRoots: fixture.testOnlyRoots,
      }).reason,
      "binding_invalid_json",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("12A: preflight output is safe on default fail and fixture pass", () => {
  const defaultResult = runPlaybookCanaryPreflight(loadConfig());
  const defaultOutput = formatPlaybookCanaryPreflight(defaultResult);
  assert.equal(defaultResult.ok, false);
  assert.match(defaultOutput, /^playbook_canary_preflight=fail/m);
  assert.doesNotThrow(() => assertPlaybookCanaryPreflightOutputIsSafe(defaultOutput));

  const fixture = writeFixture();
  try {
    const passResult = runPlaybookCanaryPreflight(
      canaryConfig(fixture.bindingPath),
      { testOnlyRoots: fixture.testOnlyRoots },
    );
    const passOutput = formatPlaybookCanaryPreflight(passResult);
    assert.equal(passResult.ok, true, passOutput);
    assert.match(passOutput, /^playbook_canary_preflight=pass/m);
    assert.match(passOutput, /^checksum_verified=true$/m);
    assert.doesNotThrow(() => assertPlaybookCanaryPreflightOutputIsSafe(passOutput));
    assert.doesNotMatch(passOutput, /[\\/](?:app|opt|home|users|config)[\\/]/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("12A: preflight reports trust failures without exposing raw paths", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "phase12a-preflight-outside-"));
  const bindingPath = path.join(outside, "private-binding.json");
  fs.writeFileSync(bindingPath, JSON.stringify(approvedBinding()), "utf8");
  try {
    const result = runPlaybookCanaryPreflight(canaryConfig(bindingPath));
    const output = formatPlaybookCanaryPreflight(result);
    assert.equal(result.bindingReason, "binding_path_outside_approved_root");
    assert.match(output, /^binding_reason=binding_path_outside_approved_root$/m);
    assert.equal(output.includes(bindingPath), false);
    assert.doesNotThrow(() => assertPlaybookCanaryPreflightOutputIsSafe(output));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("12A: CLI default is safe, fail-closed, and non-zero", () => {
  const cli = spawnSync(process.execPath, ["scripts/playbook-canary-preflight.js"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      VOICE_RUNTIME_VERSION: "v3",
      VOICE_V4_PLAYBOOK_RUNTIME_ENABLED: "false",
      VOICE_V4_PLAYBOOK_BINDING_PATH: "",
    },
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /^playbook_canary_preflight=fail/m);
  assert.doesNotThrow(() => assertPlaybookCanaryPreflightOutputIsSafe(cli.stdout));
});
