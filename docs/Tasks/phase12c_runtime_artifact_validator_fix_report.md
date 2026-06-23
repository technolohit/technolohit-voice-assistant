# Phase 12C Runtime Artifact Validator Fix Report

Date: 2026-06-22

Status: fix implemented; release `v1.36.1` recommended for Phase 12B canary deployment.

## Incident

On immutable image `thnhit/technhvoice:voice-bridge-v1.36.0`, Stage 1 deployment validation failed before any runtime activation:

```text
ENOENT: no such file or directory, open '/app/Dockerfile'
at playbook-canary-artifact-validator.js
```

## Root cause

`playbook-canary-artifact-validator.js` (Phase 12B) read `/app/Dockerfile` during `npm run playbook:canary-artifact-validate`. The production runtime image intentionally does not ship Dockerfile or `.dockerignore`; only packaged `config/` artifacts are present.

## Architectural decision

- **Do not** copy Dockerfile into the runtime image.
- Dockerfile / `.dockerignore` checks belong in repository CI tests only (`validateDockerPackagingInRepository`).
- Runtime CLI validates only packaged artifacts:
  - published playbook
  - pending binding
  - approved canary binding

## Fix summary

| Area | Change |
|------|--------|
| `playbook-canary-artifact-validator.js` | Removed runtime Dockerfile dependency; added `packageRoot` option; CLI output uses `packaged_artifacts_present` |
| `validateDockerPackagingInRepository()` | New CI-only helper for Dockerfile/config copy checks |
| Tests | `v4-phase12c-playbook-canary-artifact-validator.test.js` — simulated `/app`, absent Dockerfile, failure paths, privacy-safe CLI |
| Phase 12B tests | Docker packaging assertions moved to CI-only helper |

Published playbook bytes and binding JSON content were **not** modified. SHA-256 unchanged:

```text
f8bb259a09d409242b876939ebefb63bf7031bb6bccbaa70e8e1b56cb786a21c
```

## v1.36.0 classification

| Aspect | Status |
|--------|--------|
| Release image contents (playbook + bindings) | Valid — packaged `config/` is correct |
| `playbook:canary-artifact-validate` inside image | **Broken** — ENOENT on Dockerfile |
| Phase 12B canary deployment | **Must not use v1.36.0** for Stage 1 validation |

## Recommended release

```text
Git tag: v1.36.1
Docker image: thnhit/technhvoice:voice-bridge-v1.36.1
```

Voice-only fix; rag-api unchanged since `v1.35.3` — Docker Publish should skip rag-api.

## Runtime validator output (expected)

```text
playbook_canary_artifact_validation=pass
binding_version=technolohit-main-voice-sales-canary-binding-v1-approved-20260622
playbook_version=technolohit-playbook-v1-20260622-published
published_sha256=f8bb259a09d409242b876939ebefb63bf7031bb6bccbaa70e8e1b56cb786a21c
pending_activation_rejected=true
approved_binding_resolved=true
packaged_artifacts_present=true
runtime_environment_checked=false
failure_count=0
failures=none
```

## Verification (Phase 12C)

| Check | Result |
|-------|--------|
| `npm test` | 776 tests: 775 pass, 0 fail, 1 Windows symlink skip |
| `playbook:publish-validate` / `:published` | PASS; eval 33/0/0, decision 13/0/0 |
| `playbook:canary-artifact-validate` (repo) | PASS; `packaged_artifacts_present=true` |
| `docker run … npm run playbook:canary-artifact-validate` | PASS inside local image; `/app/Dockerfile` absent |
| `pytest rag-api/tests -q` | 7/7 |
| `run-ci-dialogue-scenarios.ps1` | 26/26 |
| Published playbook SHA-256 | Unchanged |


- No conversational runtime behavior changed.
- No published playbook or binding content changed.
- No production env changes.
- No deploy or live QA performed.
- `docs/Tasks/logs.txt` not touched.
- Dockerfile not added to production image.

## Sysadmin guidance after v1.36.1

Replace `voice-bridge-v1.36.0` with `voice-bridge-v1.36.1` in Phase 10H Stage 1–2. Do not deploy `v1.36.0` for playbook canary.
