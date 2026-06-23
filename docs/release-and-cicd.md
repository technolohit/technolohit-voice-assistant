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

The Docker Publish workflow always publishes voice-bridge. It publishes
rag-api only when `rag-api/**` changed since the nearest previous semantic
version tag. The workflow fetches full tag history and reports whether rag-api
was published or skipped. Manual runs may set `publish_rag_api=auto|true|false`;
use `auto` unless an explicit rebuild is required.

OCI version labels are explicit and do not depend on Docker tag ordering:

- semver tag `v1.36.1` produces `voice-bridge-v1.36.1`;
- a manual/non-tag build produces `voice-bridge-<shortsha>`;
- when rag-api is selected for publication, the corresponding labels are
  `rag-api-vX.Y.Z` or `rag-api-<shortsha>`.

Historical note: `voice-bridge-v1.36.0` has OCI version
`voice-bridge-74428d3`. This is accepted because its full revision
`74428d326476e967e49daaf25c63f5959211eede` and immutable RepoDigest
`sha256:e34527d0a2d940be1a51e8f45dd3f19235b37125d13be324745fc8a379fd1a11`
were verified. The image was not republished; explicit labels apply to future
releases only.

For a voice-only release such as Phase 12B `v1.36.0`, expected output is:

```text
voice-bridge-v1.36.0: published
rag-api-v1.36.0: skipped (rag-api unchanged)
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

### Phase 9 example — v1.11.0 with v3 runtime (recommended first production deploy of v4 foundation code)

Immutable tags:

```text
thnhit/technhvoice:voice-bridge-v1.11.0
thnhit/technhvoice:rag-api-v1.11.0
```

GitHub Actions **Deploy Voice Stack** inputs:

| Input | Value |
|-------|--------|
| `voice_bridge_tag` | `v1.11.0` (normalized to `voice-bridge-v1.11.0`) |
| `deploy_rag_api` | `true` when co-deploying RAG |
| `rag_api_tag` | `v1.11.0` |
| `verify_v3_qa_env` | `true` |
| `verify_v4_rag_canary_env` | `false` |

This deploys v4 foundation code **without** enabling production v4. Keep `VOICE_RUNTIME_VERSION=v3` and all `VOICE_V4_*` flags `false` in `/opt/technolohit-voice/voice-bridge/.env`.

For a supervised v4 RAG-on Gate 3 deploy, use
`verify_v4_rag_canary_env=true` and `verify_v3_qa_env=false`. The workflow runs
the same self-contained host preflight inline over SSH: sanitized snapshots,
ownership checks on **both** raw Compose files, `docker run --user 0:0`, then
`npm run rag:canary-preflight`. Never enable both verifiers in the same request.

Operator runbook: [docs/Tasks/voice_assistant_v4_phase9_sysadmin_runbook.md](./Tasks/voice_assistant_v4_phase9_sysadmin_runbook.md)

Phase 9b supervised canary (after dry run — **plan only, not execution**): [docs/Tasks/voice_assistant_v4_phase9b_sysadmin_canary_runbook.md](./Tasks/voice_assistant_v4_phase9b_sysadmin_canary_runbook.md)

RAG from voice-bridge (host network): use `VOICE_RAG_API_URL=http://127.0.0.1:8080`, not Docker service DNS.

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

Tag behavior:

- voice-bridge is always built and published;
- rag-api uses the diff from the nearest previous reachable semver tag;
- no previous semver tag means conservative rag-api publication;
- OCI version labels use the semver service tag for tag releases and the
  service-prefixed short SHA for manual/non-tag builds;
- workflow summary records the decision and reason.

This avoids failing normal `main` pushes before Docker Hub secrets are configured.

### Deploy

File:

```text
.github/workflows/deploy.yml
```

Runs manually with:

- `voice_bridge_tag`, for example `voice-bridge-v1.11.0` or shorthand `v1.11.0`
- optional `rag_api_tag`, for example `rag-api-v1.11.0` or `v1.11.0`
- `verify_v3_qa_env=true` to assert v3 QA flags inside the running container
- `verify_v4_rag_canary_env=true` to hard-fail an invalid v4 RAG-on canary environment

Input normalization: bare semver tags like `v1.11.0` are expanded to `voice-bridge-v1.11.0` / `rag-api-v1.11.0`. Always pin immutable tags in production — never deploy only `:latest`.

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
docker exec technolohit-voice-bridge sh -lc 'printenv VOICE_RAG_API_URL'
docker exec technolohit-voice-bridge sh -lc 'wget -qO- http://127.0.0.1:8080/healthz || curl -fsS http://127.0.0.1:8080/healthz'
```

Note: voice-bridge uses **host-local** RAG URL `http://127.0.0.1:8080` in the current host-network setup. Docker DNS `technolohit-rag-api` is not valid from voice-bridge.

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

v4 planning (Phase 0 decisions, feature flags, rollback): see [voice_assistant_v4_phase0_decision_report.md](./Tasks/voice_assistant_v4_phase0_decision_report.md).

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
