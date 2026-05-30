#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { interpretSemanticIntent, customerTypeMenuContext } from "../src/semantic-intent.js";
import { evaluateTranscriptFixture } from "../src/asr-diagnostics.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath =
  process.argv[2] ||
  path.join(scriptDir, "../fixtures/live-call-failures/v1_2_1_customer_type_loop.json");

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const context = fixture.context || customerTypeMenuContext();
const results = evaluateTranscriptFixture(fixture, (transcript) =>
  interpretSemanticIntent(transcript, context)
);

let failed = 0;
for (const row of results) {
  const status = row.match ? "PASS" : "FAIL";
  if (!row.match) failed += 1;
  console.log(
    `${status} turn=${row.turn} expected=${row.expected} actual=${row.actual} confidence=${row.confidence ?? "n/a"} transcript="${row.transcript}"`
  );
}

if (failed > 0) {
  process.exitCode = 1;
  console.error(`eval-asr-fixture: ${failed} mismatch(es)`);
} else {
  console.log(`eval-asr-fixture: all ${results.length} evaluated turns passed`);
}
