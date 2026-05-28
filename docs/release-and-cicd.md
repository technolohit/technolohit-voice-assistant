# Release And CI/CD

This project uses semantic version tags for production releases:

```text
vMAJOR.MINOR.PATCH
```

Examples:

```text
v1.0.0
v1.1.0
v1.1.1
```

## Version Rules

- Patch release, for example `v1.0.1`: bug fix, prompt/guardrail fix, safe runtime fix.
- Minor release, for example `v1.1.0`: new capability, new post-call feature, RAG rollout step.
- Major release, for example `v2.0.0`: breaking deployment/runtime behavior or major architecture change.

Keep these versions aligned when making a release:

- root `package.json`
- `voice-bridge/package.json`
- Git tag, for example `v1.0.0`

## Docker Hub

Docker Hub repository:

```text
thnhit/technhvoice
```

CI publishes service-prefixed tags:

```text
thnhit/technhvoice:voice-bridge-<git-sha>
thnhit/technhvoice:voice-bridge-v1.0.0
thnhit/technhvoice:voice-bridge-latest
thnhit/technhvoice:rag-api-<git-sha>
thnhit/technhvoice:rag-api-v1.0.0
thnhit/technhvoice:rag-api-latest
```

Production deploys should use immutable tags:

```text
thnhit/technhvoice:voice-bridge-v1.0.0
```

or:

```text
thnhit/technhvoice:voice-bridge-<git-sha>
```

Do not pin production only to `latest`.

## GitHub Secrets

Required for Docker publishing:

```text
DOCKERHUB_USERNAME
DOCKERHUB_TOKEN
```

Required for server deploy:

```text
VOICE_DEPLOY_HOST
VOICE_DEPLOY_USER
VOICE_DEPLOY_SSH_KEY
VOICE_DEPLOY_PATH
```

`VOICE_DEPLOY_SSH_KEY` must be the private key, including:

```text
-----BEGIN OPENSSH PRIVATE KEY-----
...
-----END OPENSSH PRIVATE KEY-----
```

The workflow accepts either normal multiline paste or escaped `\n` newlines and writes the key with `chmod 600`.

`VOICE_DEPLOY_PATH` should point to the server directory containing the production Docker Compose files, for example:

```text
/opt/technolohit-voice/asterisk
```

## Workflows

### CI

File:

```text
.github/workflows/ci.yml
```

Runs on:

- pull requests to `main`
- pushes to `main`
- manual dispatch

Checks:

- root Node dependencies
- voice-bridge Node dependencies
- JavaScript syntax
- Python/RAG syntax
- RAG static contract tests
- secret and runtime artifact guard

### Docker Publish

File:

```text
.github/workflows/docker-publish.yml
```

Runs on:

- Git tags matching `v*.*.*`
- manual dispatch

This avoids failing normal `main` pushes before Docker Hub secrets are configured.

### Deploy

File:

```text
.github/workflows/deploy.yml
```

Runs manually with:

- `voice_bridge_tag`, for example `voice-bridge-v1.0.0`
- optional `rag_api_tag`, for example `rag-api-v1.0.0`

## Release Procedure

1. Merge code to `main`.
2. Confirm CI is green.
3. Update versions in `package.json` and `voice-bridge/package.json` if needed.
4. Create and push a semver tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

5. Wait for Docker Publish to push images to `thnhit/technhvoice`.
6. Run Deploy Voice Stack manually with the pinned image tag.
7. Verify production:

```bash
docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'
docker logs --tail=120 technolohit-voice-bridge
```

8. Test a real call and verify `voice.call_sessions`, `voice.call_events`, and turn transcripts.

## Local Release Fallback

If GitHub Actions is unavailable, release from a trusted developer machine:

```bash
docker login
VOICE_DOCKER_IMAGE=thnhit/technhvoice VOICE_BRIDGE_VERSION_TAG=v1.0.0 npm run docker:release:voice-bridge
VOICE_DOCKER_IMAGE=thnhit/technhvoice RAG_API_VERSION_TAG=v1.0.0 npm run docker:release:rag-api
```
