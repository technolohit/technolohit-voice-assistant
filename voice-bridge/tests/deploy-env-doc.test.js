import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("voice-bridge runtime env doc names authoritative path", () => {
  const docPath = path.join(repoRoot, "docs", "voice-bridge-runtime-env.md");
  const text = fs.readFileSync(docPath, "utf8");
  assert.match(text, /voice-bridge\/\.env/);
  assert.match(text, /VOICE_SEMANTIC_INTENT_ENABLED=true/);
  assert.match(text, /asterisk\/\.env.*does \*\*not\*\*/i);
});
