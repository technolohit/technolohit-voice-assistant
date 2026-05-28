# Voice Bridge Build Metadata Fix v1

Date: 2026-05-21

## Problem

The deployed image was correct:

```text
thnhit/technhvoice:voice-bridge-easybell-soft-intake-logfix-v1-20260521-132205
sha256:78c3a0f44b6bfc1bc9f9c08dbbe698dbea13908a3de46fe15a42170a6f6d2423
```

But startup logs still showed:

```text
build_version=85dbb09
image_tag=unset
```

This made QA and production troubleshooting harder because the runtime log did not expose the immutable image identity.

## Repo Fix

The voice-bridge Docker build metadata path is now explicit:

- `voice-bridge/Dockerfile`
  - accepts `BUILD_VERSION`, `IMAGE_TAG`, and `GIT_SHA`
  - writes them into image ENV
  - adds OCI labels for version and revision
- `scripts/docker/build-voice-bridge.sh`
  - sets `IMAGE_TAG` from the first tag being built
  - passes `IMAGE_TAG` and `GIT_SHA` as build args
  - prints build metadata after build
- `scripts/docker/release-voice-bridge.sh`
  - when `VOICE_BRIDGE_VERSION_TAG` is used, puts that immutable version tag first so it becomes the baked `IMAGE_TAG`

## Metadata-Only Runtime Image

To avoid changing runtime behavior, a metadata-only image was built from the exact deployed digest and only ENV/LABEL metadata was added.

New image:

```text
thnhit/technhvoice:voice-bridge-build-metadata-fix-v1-20260521-173808
sha256:ebe66d0f525a58dd8151396a09f5be1b2b56f6925dc9b69784b52ee403c30bd1
```

Base image:

```text
thnhit/technhvoice@sha256:78c3a0f44b6bfc1bc9f9c08dbbe698dbea13908a3de46fe15a42170a6f6d2423
```

Expected startup log after deploying the metadata-only image:

```text
[voice-bridge] startup ... build_version=voice-bridge-build-metadata-fix-v1-20260521-173808 image_tag=voice-bridge-build-metadata-fix-v1-20260521-173808 git_sha=85dbb09 ...
```

## Deploy

```bash
cd /opt/technolohit-voice/asterisk

export VOICE_BRIDGE_IMAGE='thnhit/technhvoice:voice-bridge-build-metadata-fix-v1-20260521-173808'

docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## Verification

```bash
docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'
docker inspect technolohit-voice-bridge --format '{{index .RepoDigests 0}}'
docker exec technolohit-voice-bridge sh -lc 'printenv BUILD_VERSION IMAGE_TAG GIT_SHA'
docker logs --since=5m technolohit-voice-bridge | grep 'startup app_version' || true
```

Expected env:

```text
voice-bridge-build-metadata-fix-v1-20260521-173808
voice-bridge-build-metadata-fix-v1-20260521-173808
85dbb09
```

## Validation

Passed:

```bash
docker run --rm --entrypoint sh thnhit/technhvoice:voice-bridge-build-metadata-fix-v1-20260521-173808 -lc 'printenv BUILD_VERSION IMAGE_TAG GIT_SHA; node --check src/config.js && node --check src/index.js'
```

No runtime code path was changed in the metadata-only image.
