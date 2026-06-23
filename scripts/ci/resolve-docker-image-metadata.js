#!/usr/bin/env node

import fs from "node:fs";
import { resolveDockerImageMetadata } from "./docker-image-metadata-policy.js";

const result = resolveDockerImageMetadata({
  sha: process.env.RELEASE_SHA,
  refType: process.env.RELEASE_REF_TYPE,
  refName: process.env.RELEASE_REF_NAME,
  eventName: process.env.RELEASE_EVENT_NAME,
  publishLatestInput: process.env.PUBLISH_LATEST_INPUT,
});

const lines = [
  `short_sha=${result.shortSha}`,
  `version_tag=${result.versionTag}`,
  `publish_latest=${result.publishLatest ? "true" : "false"}`,
  `voice_oci_version=${result.voiceOciVersion}`,
  `rag_oci_version=${result.ragOciVersion}`,
];

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, "utf8");
}

console.log(lines.join("\n"));
