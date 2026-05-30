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
- voice-bridge unit tests (`npm test` in `voice-bridge/`)
- voice dialogue QA scenarios (`npm run qa:dialogue -- --scenario …`; on Windows PowerShell use `node voice-bridge/scripts/qa-dialogue-text.js --scenario …` from `voice-bridge/`)
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
7. Verify production (see also [voice-bridge-runtime-env.md](./voice-bridge-runtime-env.md)):

```bash
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
docker exec technolohit-voice-bridge sh -lc 'printenv | sort | egrep "^(VOICE_SEMANTIC_INTENT_ENABLED|VOICE_CONVERSATION_REPAIR_ENABLED|VOICE_SEMANTIC_INTENT_MODE|VOICE_RAG_ENABLED|VOICE_RAG_SALES_ANSWERER_ENABLED|VOICE_LEAD_POLICY_STRICT_CALLBACK|VOICE_LOG_TRANSCRIPT_PREVIEW|BUILD_VERSION|IMAGE_TAG)=" || true'
docker logs --tail=160 technolohit-voice-bridge
```

Voice-bridge runtime flags are **not** read from `asterisk/.env` alone. The authoritative file on the server is `../voice-bridge/.env` relative to the compose directory (typically `/opt/technolohit-voice/voice-bridge/.env`).

Caller ID DB evidence:

```bash
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -P pager=off -c "
SELECT id, started_at, caller_phone_raw, caller_phone_normalized, metadata->>'caller_phone_source' AS source
FROM voice.call_sessions
WHERE started_at IS NOT NULL
ORDER BY started_at DESC NULLS LAST
LIMIT 20;"
```

RAG runtime verification:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Networks}}' | grep -E 'technolohit-rag-api|technolohit-voice-bridge|NAME'
docker exec technolohit-voice-bridge sh -lc 'getent hosts technolohit-rag-api || true'
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://technolohit-rag-api:8080/healthz || true'
```

8. Test a real call and verify `voice.call_sessions`, `voice.call_events`, and turn transcripts.

## Rollback

Disable RAG immediately:

```env
VOICE_RAG_ENABLED=false
```

Redeploy previous immutable image:

```bash
VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-previous-tag docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
```

## Live call QA matrix (post-deploy)

| Scenario | Expected |
|----------|----------|
| Caller ID + phone callback | Permission under current number; no spoken phone repeat |
| No caller ID + phone callback | One phone question; no duplicate permission |
| No caller ID + incomplete spoken phone (`Null eins sieben sechs`) | Assistant asks once more for the full phone; no callback-ready lead |
| No caller ID + short numeric phone (`076` / `0 1 2 6 4 4 4`) | Assistant asks once more for the full phone; no email fallback; no callback-ready lead |
| No caller ID + full spoken phone (`0176 444 444 44`) | Callback-ready lead with normalized phone |
| `AI Assistant` interest | Compact voice-agent offer; no full menu |
| `AI Assistant` + `Kurze Erklärung bitte` | Short Digitale Rezeption explanation; no compact-offer loop |
| `Rückruf bitte` input | Routes to phone contact path, but assistant does not say `Rückruf` or `zurückrufen` |
| Unclear audio | Short repeat request |
| Unknown intent | Short topic clarification; no greeting loop |
| RAG disabled | Call continues with FAQ/templates/fallback |

## Local Release Fallback

If GitHub Actions is unavailable, release from a trusted developer machine:

```bash
docker login
VOICE_DOCKER_IMAGE=thnhit/technhvoice VOICE_BRIDGE_VERSION_TAG=v1.0.0 npm run docker:release:voice-bridge
VOICE_DOCKER_IMAGE=thnhit/technhvoice RAG_API_VERSION_TAG=v1.0.0 npm run docker:release:rag-api
```
