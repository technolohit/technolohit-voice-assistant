const SEMVER_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

export function resolveDockerImageMetadata({
  sha = "",
  refType = "",
  refName = "",
  eventName = "",
  publishLatestInput = "",
} = {}) {
  const normalizedSha = String(sha).trim();
  if (normalizedSha.length < 7) {
    throw new Error("release_sha_required");
  }

  const shortSha = normalizedSha.slice(0, 7);
  const versionTag =
    refType === "tag" && SEMVER_TAG_PATTERN.test(refName) ? refName : "";
  const publishLatest =
    eventName === "workflow_dispatch"
      ? String(publishLatestInput).toLowerCase() === "true"
      : true;
  const versionSuffix = versionTag || shortSha;

  return {
    shortSha,
    versionTag,
    publishLatest,
    voiceOciVersion: `voice-bridge-${versionSuffix}`,
    ragOciVersion: `rag-api-${versionSuffix}`,
  };
}
