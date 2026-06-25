#!/usr/bin/env node
/**
 * Rewrite checksum-sensitive playbook artifacts from git blob bytes (LF canonical).
 * Used after .gitattributes eol=lf when Windows checkout still has CRLF drift.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..");

const files = [
  "voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.published.json",
  "voice-bridge/config/playbooks/technolohit.main_voice_sales.v1.publish-candidate.json",
  "voice-bridge/config/playbook-bindings/technolohit.main_voice_sales.v1.canary.approved.json",
  "voice-bridge/config/playbook-bindings/technolohit.main_voice_sales.v1.canary.pending.json",
];

for (const rel of files) {
  const hash = execSync(`git hash-object "${rel}"`, { cwd: repoRoot }).toString().trim();
  const bytes = execSync(`git cat-file blob ${hash}`, { cwd: repoRoot });
  const target = path.join(repoRoot, rel);
  fs.writeFileSync(target, bytes);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  console.log(`${rel} sha256=${sha} crlf=${bytes.includes(0x0d)}`);
}
