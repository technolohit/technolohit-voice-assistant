# TechnoloHit Voice Assistant v4 — Phase 9 Production Rollout Preparation Report

Date: 2026-06-01
Status: **Ready for Sysadmin migration/deploy dry run** (documentation + runbook; **production v4 NOT enabled**)  
Blueprint: [voice_assistant_v4_realtime_tenant_ready_blueprint.md](./voice_assistant_v4_realtime_tenant_ready_blueprint.md)  
Prior phase: Phase 8 observability/quality analytics (tag `v1.11.0`)

## Objective

Prepare a **safe, operator-ready controlled rollout plan** so Sysadmin can apply migrations, deploy immutable image `v1.11.0`, verify runtime safety with **v3 still active**, optionally run canary QA, and roll back quickly. **Production v4 remains disabled** until explicit approval.

## Scope of Phase 9 (this deliverable)

| In scope | Out of scope |
|----------|--------------|
| Rollout report + sysadmin runbook | Enabling production v4 |
| Deploy/tag documentation for `v1.11.0` | Modifying production `.env` files |
| Acceptance checklist + rollback dry-run | Live deploy execution |
| Blocker tracking (unchanged) | Commit/tag (operator decision) |

## Files inspected

| File | Purpose |
|------|---------|
| `.github/workflows/deploy.yml` | Manual deploy workflow, tag validation, v3 env verify |
| `.github/workflows/docker-publish.yml` | Immutable tag publish on `v*.*.*` |
| `docs/release-and-cicd.md` | Release/deploy procedure |
| `docs/voice-bridge-runtime-env.md` | Production env source of truth |
| `db/voice/migrations/006`–`009` | v4 tenant/agent/quality schema |
| `db/knowledge/migrations/003` | Knowledge agent scope |
| `docs/Tasks/voice_assistant_v4_phase8_*` | Quality analytics queries |
| Phase 1–8 reports | Foundation context |
| `docs/Tasks/voice_assistant_v4_phase0_decision_report.md` | RAG host-local URL, blockers |

## Files changed / added

| File | Change |
|------|--------|
| `docs/Tasks/voice_assistant_v4_phase9_production_rollout_report.md` | **New** (this report) |
| `docs/Tasks/voice_assistant_v4_phase9_sysadmin_runbook.md` | **New** operator runbook |
| `docs/release-and-cicd.md` | Phase 9 / v1.11.0 deploy notes |
| `docs/Tasks/voice_assistant_v4_realtime_tenant_ready_blueprint.md` | Phase 9 status + checklist |

**Not changed:** application runtime code, production env files, `docs/Tasks/logs.txt`, `turn-assistant.js`.

## Code behavior changed?

**No.** Phase 9 is documentation and operator procedure only.

## Tests / checks run

| Check | Result |
|-------|--------|
| `git diff --check` | clean (after doc edits) |

No destructive commands, no deploy, no migration apply in this session.

## Production default behavior

**Unchanged and mandatory for v1.11.0 deploy:**

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_CANARY_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_RAG_ENABLED=false
```

Deploying `thnhit/technhvoice:voice-bridge-v1.11.0` with the above flags ships v4 foundation code **dormant**; live calls remain on v3.

## Sysadmin runbook location

**Primary:** [voice_assistant_v4_phase9_sysadmin_runbook.md](./voice_assistant_v4_phase9_sysadmin_runbook.md)

Contains exact commands for: image verify, DB backup, migrations 006–009 + knowledge 003, schema verify, env verify, deploy v1.11.0, health checks, RAG host-local URL, quality-event guard, optional canary (non-production), rollback, privacy-safe logs.

Migration SQL artifact note:

- Runtime Docker images do **not** include repo migration SQL files.
- The runbook now includes an explicit artifact gate to fetch/copy the required SQL files from immutable tag `v1.11.0` before applying migrations.
- Required server paths:
  - `/opt/technolohit-voice/db/voice/migrations`
  - `/opt/technolohit-voice/db/knowledge/migrations`

## Image tags (immutable — do not use `latest` in production)

| Service | Tag for v1.11.0 release |
|---------|-------------------------|
| voice-bridge | `thnhit/technhvoice:voice-bridge-v1.11.0` |
| rag-api | `thnhit/technhvoice:rag-api-v1.11.0` |

GitHub Actions **Deploy Voice Stack** inputs:

- `voice_bridge_tag`: `v1.11.0` or `voice-bridge-v1.11.0` (workflow normalizes `v1.11.0` → `voice-bridge-v1.11.0`)
- `deploy_rag_api`: `true` when co-deploying RAG
- `rag_api_tag`: `v1.11.0` or `rag-api-v1.11.0`
- `verify_v3_qa_env`: `true` recommended after deploy

## Acceptance checklist (operator)

- [ ] Voice migrations 006–009 applied and verified
- [ ] Knowledge migration 003 applied (if not already)
- [ ] Migration SQL artifacts present on server before apply
- [ ] `voice.call_quality_events` table exists
- [ ] v4 tenant/agent columns present on sessions/transcripts/events/summaries/leads
- [ ] Agent config seed present in image (`/app/config/agents/technolohit.main_voice_sales.v4.json`)
- [ ] Production env source: `/opt/technolohit-voice/voice-bridge/.env` (not `asterisk/.env` alone)
- [ ] `VOICE_RUNTIME_VERSION=v3` after deploy
- [ ] All `VOICE_V4_*` flags `false`
- [ ] `VOICE_RAG_API_URL=http://127.0.0.1:8080` (host-network reality)
- [ ] RAG `/healthz` OK via host-local URL from voice-bridge network context
- [ ] Running image = pinned immutable tag (not `latest`)
- [ ] No new rows in `voice.call_quality_events` during v3-only operation (or explain prior test data)
- [ ] Logs collected without secrets/full phone numbers
- [ ] Rollback command documented and dry-run understood
- [ ] **Production v4 blockers still open** (see below)

## Remaining production blockers (v4 enablement — NOT v1.11.0 image deploy)

These **do not block** deploying v1.11.0 with v3 runtime active. They **do block** turning on production v4:

| Blocker | Owner / notes |
|---------|----------------|
| Final retention approval | Mojtaba, Founder of TechnoloHit |
| Backup/encryption confirmation | Sysadmin |
| Dedicated QA phone/route | Operations |
| Overload fallback destination | Architecture/ops |
| OpenAI streaming/realtime limits | Provider quota review |

Additional tracked items: ARI/ExternalMedia fallback unconfirmed; overload behavior above capacity undefined.

## Recommendation

**Ready for Sysadmin migration + deploy dry run** with v1.11.0 image and v3 runtime.

**Not ready** for production v4 enablement until blockers above are explicitly approved and supervised canary/live QA checklist (Phase 9 rollout section) is completed.

## Sysadmin dry run result

Date: 2026-06-01
Status: **PASSED with warnings**

Summary:

- Previous voice-bridge image recorded: `thnhit/technhvoice:voice-bridge-v1.3.4`
- Pre-migration DB backup created:
  `/opt/technolohit-voice/backups/phase9-v1.11.0-20260601T223551Z/technolohit_growth_before_phase9_v1.11.0.dump`
- Migration SQL artifact gate passed after fetching SQL files from immutable tag `v1.11.0`.
- Voice migrations `006`-`009` applied successfully.
- Knowledge migration `003` applied successfully.
- `voice.call_quality_events` table exists.
- v4 tenant/agent/version columns verified on voice tables.
- `knowledge.documents.agent_id` and `knowledge.retrieval_logs.agent_id` verified.
- voice-bridge deployed successfully on image `thnhit/technhvoice:voice-bridge-v1.11.0`.
- Production runtime remained v3:
  - `VOICE_RUNTIME_VERSION=v3`
  - `VOICE_V4_REALTIME_ENABLED=false`
  - `VOICE_V4_CANARY_ENABLED=false`
  - `VOICE_V4_BARGE_IN_ENABLED=false`
  - `VOICE_V4_STREAMING_STT_ENABLED=false`
  - `VOICE_V4_STREAMING_TTS_ENABLED=false`
  - `VOICE_RAG_ENABLED=false`
  - `VOICE_RAG_SALES_ANSWERER_ENABLED=false`
- `VOICE_RAG_API_URL` corrected to `http://127.0.0.1:8080`.
- RAG health passed through host-local URL.
- One normal v3 test call completed successfully.
- `voice.call_quality_events` stayed at `0` before and after the v3 test call.
- Rollback image recorded: `thnhit/technhvoice:voice-bridge-v1.3.4`.

Warnings / follow-ups:

1. Startup log shows `selected=v3 v4_active=true reason=default_v3`.
   In `v1.11.0`, this means the selected route is active and selected runtime is v3. It does **not** mean v4 realtime/canary is enabled. Operationally, trust `selected=v3` and the explicit `VOICE_V4_*` flags. A future code cleanup should rename this log field to avoid confusion.
2. `rag-api` was not co-deployed to `rag-api-v1.11.0`; it remains on the previous image. This is acceptable for the v3-safe dry run because voice-bridge RAG remains disabled. Co-deploy or upgrade RAG before any v4 RAG/canary validation that depends on v1.11.0 RAG behavior.
3. A transcript verification query used `role`, but `voice.call_transcripts` uses speaker/text columns in the current schema. This was a verification-query issue only and did not affect runtime or migrations.
4. Docker Compose emitted an orphan warning for `technolohit-rag-api`; no cleanup was performed during the dry run.

Dry run conclusion:

The production host is now schema-ready for v4 foundations and running `voice-bridge-v1.11.0` with production v4 disabled. This does **not** approve production v4 enablement.

## Next steps after operator dry run

1. Keep production on v3 with all v4 flags off.
2. Decide whether to co-deploy `rag-api-v1.11.0` before future v4/RAG validation.
3. Keep tracking production-v4 blockers: retention approval, backup encryption, QA route, overload fallback, OpenAI streaming limits.
4. Plan the next supervised canary step only after explicit approval.
5. Future code cleanup: rename the `v4_active` startup log field so v3 operation is not operationally ambiguous.
