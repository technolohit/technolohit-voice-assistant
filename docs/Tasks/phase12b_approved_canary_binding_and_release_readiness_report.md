# Phase 12B Approved Canary Binding And Release Readiness Report

Date: 2026-06-22

Status: released as `v1.36.0`; **do not deploy for Phase 12B canary** — runtime `playbook:canary-artifact-validate` fails (ENOENT `/app/Dockerfile`). Use **`v1.36.1`** (Phase 12C fix).

## Scope

Phase 12B packages the Phase 11 published playbook and Phase 12A runtime
binding contract for a reversible supervised canary. It does not approve
production/global activation.

Release recommendation:

```text
Git tag: v1.36.0
Docker image: thnhit/technhvoice:voice-bridge-v1.36.0
```

## Approved Canary Binding

Artifact:

```text
voice-bridge/config/playbook-bindings/technolohit.main_voice_sales.v1.canary.approved.json
```

Contract:

- `binding_version=technolohit-main-voice-sales-canary-binding-v1-approved-20260622`
- `tenant_id=technolohit`
- `agent_id=main_voice_sales`
- `playbook_version=technolohit-playbook-v1-20260622-published`
- `sha256=f8bb259a09d409242b876939ebefb63bf7031bb6bccbaa70e8e1b56cb786a21c`
- `scope=canary`
- `status=approved`
- `approval.state=approved`
- `approval.canary_only=true`
- `approval.production_approved=false`
- `approval.global_approval=false`
- `active=true`
- `rollback_target.type=hardcoded_default`

The existing pending sample remains unchanged, pending, and inactive. Merely
shipping the approved artifact does not activate it. Runtime still requires
the v4 realtime/canary/live-AudioSocket gates, the playbook runtime flag, and
the explicit binding path.

## Non-Live Artifact Validation

New command:

```bash
npm run playbook:canary-artifact-validate
```

It verifies:

- published playbook version and exact SHA-256;
- embedded playbook runtime binding remains inactive;
- pending sample is rejected for activation;
- approved binding is canary-only and resolves the immutable published bytes;
- packaged runtime artifacts are present inside the image (`config/playbooks`, `config/playbook-bindings`);
- no runtime environment is claimed or inspected.

**Phase 12C note:** v1.36.0 shipped a validator that incorrectly required `/app/Dockerfile` and failed inside the runtime image. Use **`v1.36.1`** or newer for deployment Stage 1 validation. Dockerfile copy checks remain repository CI tests only (`validateDockerPackagingInRepository`).

`npm run playbook:canary-preflight` remains the separate server/runtime guard
and must fail under the default v3/off environment.

## Docker Release Behavior

The Docker Publish workflow always publishes `voice-bridge`.

For semantic-version tag releases, `rag-api` is published only when
`rag-api/**` differs from the nearest previous semantic-version tag reachable
from the release commit. Full tag history is fetched. If no previous semantic
tag exists, `rag-api` is published conservatively.

Manual workflow runs expose `publish_rag_api=auto|true|false`:

- `auto`: same history-based change detection;
- `true`: explicit publication;
- `false`: explicit skip.

The workflow summary reports `published` or `skipped` and the reason. For
`v1.36.0`, the expected result is voice-bridge published and rag-api skipped
because no rag-api source changed since `v1.35.3`.

### v1.36.0 release metadata follow-up

The immutable `v1.36.0` image was verified with:

```text
revision=74428d326476e967e49daaf25c63f5959211eede
RepoDigest=sha256:e34527d0a2d940be1a51e8f45dd3f19235b37125d13be324745fc8a379fd1a11
org.opencontainers.image.version=voice-bridge-74428d3
```

The short-SHA OCI version label is accepted for this already-published image
because both the immutable digest and full revision match the approved release.
`v1.36.0` was not republished or mutated.

Root cause: Docker metadata received the short-SHA raw tag before the semver raw
tag and derived the version label from that first tag. Future workflows set the
OCI version label explicitly:

- tag `v1.36.1` -> `voice-bridge-v1.36.1`;
- manual/non-tag build -> `voice-bridge-<shortsha>`;
- `rag-api-vX.Y.Z` is used only when rag-api is actually published for a tagged
  release; its conditional publication policy is unchanged.

## Safety Boundaries

- Production defaults remain `VOICE_RUNTIME_VERSION=v3`.
- `VOICE_V4_PLAYBOOK_RUNTIME_ENABLED=false` remains the default.
- No production env or Compose runtime env changed.
- No conversational planner, RAG, questionnaire, callback, or lead behavior changed.
- No rag-api source changed.
- No deploy workflow or live server script changed.
- This metadata follow-up performs no Docker build/push, deploy, live QA, tag,
  or mutation of `v1.36.0`.
- `docs/Tasks/logs.txt` was not touched.

## Verification

Executed on the Phase 12B working tree:

| Check | Result |
|---|---|
| `cd voice-bridge && npm test` | 765 tests: 764 pass, 0 fail, 1 conditional Windows symlink skip |
| `npm run playbook:publish-validate` | PASS; playbook eval 33/0/0, decision eval 13/0/0 |
| `npm run playbook:publish-validate:published` | PASS; playbook eval 33/0/0, decision eval 13/0/0 |
| `npm run playbook:canary-artifact-validate` | PASS; exact SHA, pending rejected, approved resolved, Docker config copy verified |
| Default `npm run playbook:canary-preflight` | Expected FAIL; v3/off, binding not checked, six required gates absent |
| RAG publication policy against current repository | `publish=false`, `rag_api_unchanged_since_v1.35.3` |
| Temporary-git changed/unchanged policy tests | PASS |
| Workflow YAML parsing | PASS for CI and Docker Publish |
| `python -m pytest rag-api/tests -q` | 7/7 PASS |
| `node --check` on changed JavaScript | PASS |
| `git diff --check` | PASS; line-ending warnings only |
| `run-ci-dialogue-scenarios.ps1` | 26/26 PASS |

Published playbook bytes were not edited. The validated SHA-256 remains:

```text
f8bb259a09d409242b876939ebefb63bf7031bb6bccbaa70e8e1b56cb786a21c
```

## Remaining Steps After Commit

1. Confirm CI success on `main`.
2. **Recommend** release tag `v1.36.0` (do not create until explicitly authorized).
3. After tag + Docker Publish: expect `voice-bridge-v1.36.0` published and rag-api skipped (`rag_api_unchanged_since_v1.35.3`).
4. Issue a separate written one-call canary authorization to Sysadmin before any live QA.

## Remaining Sysadmin Steps

Only after Codex authorization:

1. Record the safe v3/off baseline and rollback image.
2. Pull and pin `voice-bridge-v1.36.1` (not `v1.36.0`).
3. Validate packaged artifacts with `playbook:canary-artifact-validate`.
4. Open a temporary v4/playbook canary env window using the exact values in
   the Phase 10H runbook.
5. Recreate voice-bridge and run `playbook:canary-preflight`.
6. Place exactly one supervised call only if all preflights pass.
7. Collect evidence, wait for post-call completion, and restore v3/off.
