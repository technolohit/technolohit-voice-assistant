# Docker Hub Voice Deployment

This runbook replaces manual `scp` source-folder deploys for the TechnoloHit voice stack. It starts with the `voice-bridge` image in Docker Hub repository `thnhit/technhvoice`.

## Why Docker Hub

- Build once on a developer/build machine, then run the exact same image on the server.
- Deploy immutable tags such as `voice-bridge-abc1234` instead of copying source folders.
- Roll back by selecting the previous image tag and running `docker compose pull/up` again.
- Keep secrets outside the image; runtime `.env` / Docker Compose environment still supplies passwords and API keys.

## Tag Strategy

| Tag | Use |
|-----|-----|
| `thnhit/technhvoice:voice-bridge-<git-short-sha>` | Preferred staging/production tag; immutable release pointer |
| `thnhit/technhvoice:voice-bridge-latest` | Convenience tag only; do not rely on it for production rollback |
| `thnhit/technhvoice:voice-bridge-dev` | Optional dev tag when `VOICE_BRIDGE_PUSH_DEV=true` |
| `thnhit/technhvoice:voice-bridge-vX.Y.Z` | Optional semantic release tag via `VOICE_BRIDGE_VERSION_TAG=vX.Y.Z` |

For production, pin `VOICE_BRIDGE_IMAGE` to the git SHA tag.

Semantic voice-only releases do not require a matching new rag-api image.
GitHub Actions publishes voice-bridge for every release tag and skips rag-api
when `rag-api/**` is unchanged since the previous semantic tag. Keep the
currently approved immutable rag-api image pinned in that case.

## Local Release

Prerequisites:

- Docker installed and running.
- Git available.
- Docker Hub login already completed with `docker login`, or credentials configured outside this repo.
- Do not store Docker Hub passwords or tokens in repo files.

From the repo root:

```bash
docker login
VOICE_DOCKER_IMAGE=thnhit/technhvoice npm run docker:release:voice-bridge
```

Equivalent direct script command:

```bash
VOICE_DOCKER_IMAGE=thnhit/technhvoice bash scripts/docker/release-voice-bridge.sh
```

Expected output includes:

```text
Built:
thnhit/technhvoice:voice-bridge-abc1234
thnhit/technhvoice:voice-bridge-latest

Pushed:
thnhit/technhvoice:voice-bridge-abc1234
thnhit/technhvoice:voice-bridge-latest
```

Optional dev tag:

```bash
VOICE_BRIDGE_PUSH_DEV=true npm run docker:release:voice-bridge
```

Optional semantic tag:

```bash
VOICE_BRIDGE_VERSION_TAG=v0.1.0 npm run docker:release:voice-bridge
```

On Windows, run these scripts from Git Bash or another shell that provides `bash`.

## Server Deploy

Use the existing Docker Compose service and add the production override:

```bash
cd /opt/technolohit-voice/asterisk

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-abc1234 \
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-abc1234 \
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

The override file sets:

```yaml
services:
  voice-bridge:
    image: ${VOICE_BRIDGE_IMAGE:-thnhit/technhvoice:voice-bridge-latest}
    build: null
```

If the server Compose file lives outside this repo, copy or mirror `asterisk/docker-compose.prod.yml` into the deployed compose directory once. After that, routine deploys only change `VOICE_BRIDGE_IMAGE`.

## Verification

```bash
docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'
docker logs --tail=120 technolohit-voice-bridge
docker exec technolohit-voice-bridge node --version || true
docker exec technolohit-voice-bridge sh -lc 'ls -lah /app/knowledge /app/audio || true'
```

Startup logs should include app/package version and build metadata:

```text
[voice-bridge] startup app_version=... bridge_version=... build_version=... image_tag=...
```

## Rollback

Set the previous immutable tag and pull/up again:

```bash
VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-previoussha \
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge

VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-previoussha \
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

No database rollback is required for an image-only rollback unless a future change explicitly ships a migration.

## Secrets Policy

The image may contain application code, `knowledge/`, packaged audio such as `audio/greeting.slin`, `package.json`, and production dependencies.

The image must not contain:

- `.env` or `.env.*`
- OpenAI API keys
- DB passwords
- SSH keys
- local recordings
- host `node_modules`
- logs

`voice-bridge/.dockerignore` enforces these exclusions. Runtime secrets must come from Docker Compose env files, Docker secrets, or the server environment.

## Future Image Naming

For now, `thnhit/technhvoice` is used for `voice-bridge` only. If additional voice-stack images are added later, keep service prefixes in tags, for example:

- `thnhit/technhvoice:voice-bridge-<sha>`
- `thnhit/technhvoice:asterisk-<sha>`

Do not reuse a generic `latest` tag across different services.
