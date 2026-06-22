import { execFileSync } from "node:child_process";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function parseSemverTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

function compareSemverDesc(left, right) {
  const a = parseSemverTag(left);
  const b = parseSemverTag(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
}

export function determineRagApiPublication({
  cwd,
  requested = "auto",
  currentTag = "",
  sha = "HEAD",
}) {
  if (requested === "true") {
    return { publish: true, reason: "explicit_override", baseTag: "" };
  }
  if (requested === "false") {
    return { publish: false, reason: "explicit_skip", baseTag: "" };
  }
  if (requested !== "auto") {
    throw new Error("publish_rag_api_input_invalid");
  }

  const tags = git(cwd, ["tag", "--list"])
    .split(/\r?\n/)
    .filter((tag) => parseSemverTag(tag))
    .filter((tag) => tag !== currentTag)
    .sort(compareSemverDesc);

  const baseTag = tags.find((tag) => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", tag, sha], {
        cwd,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  });

  if (!baseTag) {
    return {
      publish: true,
      reason: "no_previous_semver_tag",
      baseTag: "",
    };
  }

  try {
    execFileSync("git", ["diff", "--quiet", baseTag, sha, "--", "rag-api"], {
      cwd,
      stdio: "ignore",
    });
    return {
      publish: false,
      reason: `rag_api_unchanged_since_${baseTag}`,
      baseTag,
    };
  } catch (error) {
    if (error?.status === 1) {
      return {
        publish: true,
        reason: `rag_api_changed_since_${baseTag}`,
        baseTag,
      };
    }
    throw error;
  }
}
