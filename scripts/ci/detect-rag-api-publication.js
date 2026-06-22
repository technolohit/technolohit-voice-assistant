#!/usr/bin/env node

import fs from "node:fs";
import { determineRagApiPublication } from "./rag-api-publication-policy.js";

const result = determineRagApiPublication({
  cwd: process.cwd(),
  requested: process.env.PUBLISH_RAG_API ?? "auto",
  currentTag: process.env.CURRENT_TAG ?? "",
  sha: process.env.RELEASE_SHA ?? "HEAD",
});
const lines = [
  `publish=${result.publish ? "true" : "false"}`,
  `reason=${result.reason}`,
  `base_tag=${result.baseTag}`,
];

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, "utf8");
}
console.log(lines.join("\n"));
