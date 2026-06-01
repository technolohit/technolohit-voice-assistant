# v4 Phase 9 — Sysadmin Controlled Rollout Runbook (v1.11.0, v3 runtime active)

Date: 2026-06-01  
Report: [voice_assistant_v4_phase9_production_rollout_report.md](./voice_assistant_v4_phase9_production_rollout_report.md)

**Critical:** This runbook deploys code + schema with **production v4 disabled**. Do not set `VOICE_RUNTIME_VERSION=v4` or enable `VOICE_V4_*` flags on the production host unless explicitly approved.

Paths assume default layout:

```text
Compose dir:  /opt/technolohit-voice/asterisk   (= VOICE_DEPLOY_PATH)
Runtime env:  /opt/technolohit-voice/voice-bridge/.env
Postgres:     container central_postgres, DB technolohit_growth
```

Adjust if your server differs.

---

## 0. Preconditions

- Git tag `v1.11.0` published to Docker Hub (`voice-bridge-v1.11.0`, `rag-api-v1.11.0`).
- SSH access to production host.
- DB admin credentials available locally for `npm run db:migrate:*` **or** `psql` on server.
- `PRODUCTION_PGVECTOR_READY=true` before knowledge migration 003 (if not already applied).

---

## 1. Verify current running image

```bash
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
docker inspect technolohit-rag-api --format 'running_image={{.Config.Image}}' 2>/dev/null || true
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' | grep -E 'voice-bridge|rag-api|NAME'
```

Record current tags for rollback (section 11).

---

## 2. Backup database before migrations

**On Postgres host** (adjust user/container names):

```bash
BACKUP_STAMP="$(date -u +%Y%m%dT%H%MZ)"
docker exec central_postgres pg_dump -U postgres -d technolohit_growth -Fc \
  -f "/tmp/technolohit_growth_pre_v1.11.0_${BACKUP_STAMP}.dump"
docker cp "central_postgres:/tmp/technolohit_growth_pre_v1.11.0_${BACKUP_STAMP}.dump" \
  "./technolohit_growth_pre_v1.11.0_${BACKUP_STAMP}.dump"
ls -lh "./technolohit_growth_pre_v1.11.0_${BACKUP_STAMP}.dump"
```

Verify backup file size > 0. Store off-host per backup policy.

---

## 3. Apply voice migrations 006–009

### 3A. Make migration SQL artifacts available on the server

The runtime Docker images do **not** include repo migration SQL files. Before applying
migrations, place the required files on the host under:

```text
/opt/technolohit-voice/db/voice/migrations
/opt/technolohit-voice/db/knowledge/migrations
```

Recommended server-side fetch from the immutable Git tag:

```bash
MIGRATION_TAG="v1.11.0"
REPO_RAW_BASE="https://raw.githubusercontent.com/technolohit/technolohit-voice-assistant/${MIGRATION_TAG}"

mkdir -p /opt/technolohit-voice/db/voice/migrations
mkdir -p /opt/technolohit-voice/db/knowledge/migrations

for f in 006_v4_tenant_agent_session_fields.sql \
         007_v4_tenant_agent_transcripts_events.sql \
         008_v4_leads_custom_fields.sql \
         009_v4_call_quality_events.sql; do
  curl -fsSL \
    "${REPO_RAW_BASE}/db/voice/migrations/${f}" \
    -o "/opt/technolohit-voice/db/voice/migrations/${f}"
done

curl -fsSL \
  "${REPO_RAW_BASE}/db/knowledge/migrations/003_knowledge_agent_scope.sql" \
  -o "/opt/technolohit-voice/db/knowledge/migrations/003_knowledge_agent_scope.sql"

ls -lh /opt/technolohit-voice/db/voice/migrations/00{6,7,8,9}_*.sql
ls -lh /opt/technolohit-voice/db/knowledge/migrations/003_knowledge_agent_scope.sql
```

If the GitHub repository is private, use a read-only GitHub token without printing it:

```bash
# export GITHUB_TOKEN=...   # do not echo this value
curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  "${REPO_RAW_BASE}/db/voice/migrations/006_v4_tenant_agent_session_fields.sql" \
  -o /tmp/006_v4_tenant_agent_session_fields.sql
```

Then repeat the authenticated `curl` pattern for the remaining files, or copy the
files from a developer-provided tarball.

Developer-side tarball alternative:

```bash
git archive --format=tar --prefix=phase9-migrations/ v1.11.0 \
  db/voice/migrations/006_v4_tenant_agent_session_fields.sql \
  db/voice/migrations/007_v4_tenant_agent_transcripts_events.sql \
  db/voice/migrations/008_v4_leads_custom_fields.sql \
  db/voice/migrations/009_v4_call_quality_events.sql \
  db/knowledge/migrations/003_knowledge_agent_scope.sql \
  | gzip > phase9-migrations-v1.11.0.tar.gz
```

After copying the tarball to the server:

```bash
mkdir -p /opt/technolohit-voice/phase9-migrations
tar -xzf phase9-migrations-v1.11.0.tar.gz -C /opt/technolohit-voice/phase9-migrations
mkdir -p /opt/technolohit-voice/db/voice/migrations
mkdir -p /opt/technolohit-voice/db/knowledge/migrations
cp /opt/technolohit-voice/phase9-migrations/phase9-migrations/db/voice/migrations/00{6,7,8,9}_*.sql \
  /opt/technolohit-voice/db/voice/migrations/
cp /opt/technolohit-voice/phase9-migrations/phase9-migrations/db/knowledge/migrations/003_knowledge_agent_scope.sql \
  /opt/technolohit-voice/db/knowledge/migrations/
```

Artifact gate:

```bash
test -s /opt/technolohit-voice/db/voice/migrations/006_v4_tenant_agent_session_fields.sql
test -s /opt/technolohit-voice/db/voice/migrations/007_v4_tenant_agent_transcripts_events.sql
test -s /opt/technolohit-voice/db/voice/migrations/008_v4_leads_custom_fields.sql
test -s /opt/technolohit-voice/db/voice/migrations/009_v4_call_quality_events.sql
test -s /opt/technolohit-voice/db/knowledge/migrations/003_knowledge_agent_scope.sql
echo "migration_artifacts_ready=yes"
```

Do not continue until the artifact gate passes.

### 3B. Apply voice migrations

Migrations are **idempotent** (`IF NOT EXISTS`). Preferred from developer/CI machine with DB tunnel configured:

```bash
cd /path/to/technolohit-voice-assistant
npm run db:migrate:voice
npm run db:test:voice
```

This applies **all** voice migrations in order (including 006–009). Safe if 001–005 already applied.

**Alternative — apply only 006–009 on server via psql** (if 001–005 already applied):

```bash
for f in 006_v4_tenant_agent_session_fields.sql \
         007_v4_tenant_agent_transcripts_events.sql \
         008_v4_leads_custom_fields.sql \
         009_v4_call_quality_events.sql; do
  docker exec -i central_postgres psql -U postgres -d technolohit_growth -v ON_ERROR_STOP=1 \
    < "/opt/technolohit-voice/db/voice/migrations/${f}"
done
```

---

## 4. Apply knowledge migration 003 (if not already applied)

Check first:

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c \
  "SELECT column_name FROM information_schema.columns WHERE table_schema='knowledge' AND table_name='documents' AND column_name='agent_id';"
```

If empty, from repo machine:

```bash
export PRODUCTION_PGVECTOR_READY=true
npm run db:migrate:knowledge
```

Or server-side:

```bash
docker exec -i central_postgres psql -U postgres -d technolohit_growth -v ON_ERROR_STOP=1 \
  < /opt/technolohit-voice/db/knowledge/migrations/003_knowledge_agent_scope.sql
```

---

## 5. Verify new columns / tables

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c "
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'voice'
  AND table_name IN ('call_sessions','call_transcripts','call_events','call_summaries','leads')
  AND column_name IN ('tenant_id','agent_id','agent_config_version','custom_fields')
ORDER BY table_name, column_name;"

docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c \
  "SELECT to_regclass('voice.call_quality_events') AS quality_events_table;"

docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c "
SELECT indexname FROM pg_indexes WHERE schemaname='voice' AND tablename='call_quality_events';"
```

Expected: `voice.call_quality_events` exists; session/transcript/event/summary/leads have v4 columns.

---

## 6. Verify agent config inside image (after deploy, or inspect image locally)

Post-deploy:

```bash
docker exec technolohit-voice-bridge sh -lc \
  'test -f /app/config/agents/technolohit.main_voice_sales.v4.json && echo agent_config_ok || echo agent_config_missing'
docker exec technolohit-voice-bridge sh -lc \
  'node -e "const j=require(\"/app/config/agents/technolohit.main_voice_sales.v4.json\"); console.log(j.tenant_id, j.agent_id, j.runtime_version)"'
```

No secrets in output — only tenant/agent/version identifiers.

---

## 7. Verify production env source of truth (do not commit changes)

```bash
grep -E '^(VOICE_RUNTIME_VERSION|VOICE_V4_|VOICE_RAG_|VOICE_TENANT_ID|VOICE_AGENT_ID|VOICE_BRIDGE_IMAGE)=' \
  /opt/technolohit-voice/voice-bridge/.env | sort
```

**Required production defaults (v4 dormant):**

```env
VOICE_RUNTIME_VERSION=v3
VOICE_V4_REALTIME_ENABLED=false
VOICE_V4_CANARY_ENABLED=false
VOICE_V4_BARGE_IN_ENABLED=false
VOICE_V4_STREAMING_STT_ENABLED=false
VOICE_V4_STREAMING_TTS_ENABLED=false
VOICE_RAG_ENABLED=false
VOICE_RAG_SALES_ANSWERER_ENABLED=false
```

**RAG URL for current host-network setup** (voice-bridge reaches RAG on host loopback):

```env
VOICE_RAG_API_URL=http://127.0.0.1:8080
```

Do **not** use `http://technolohit-rag-api:8080` for voice-bridge in the current host-network layout.

Image pin (example):

```env
VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.11.0
```

---

## 8. Deploy image v1.11.0 (v3 runtime stays active)

### Option A — GitHub Actions (recommended)

Workflow: **Deploy Voice Stack** (`.github/workflows/deploy.yml`)

| Input | Value |
|-------|--------|
| `voice_bridge_tag` | `v1.11.0` |
| `deploy_rag_api` | `true` (if co-deploying RAG) |
| `rag_api_tag` | `v1.11.0` |
| `verify_v3_qa_env` | `true` |
| `enable_rag_sales_answerer` | `false` |

### Option B — Manual on server

```bash
cd /opt/technolohit-voice/asterisk
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.11.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge

# Optional RAG co-deploy:
export RAG_API_IMAGE=thnhit/technhvoice:rag-api-v1.11.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull technolohit-rag-api
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d technolohit-rag-api
```

Confirm immutable tag (not `latest`):

```bash
docker inspect technolohit-voice-bridge --format '{{.Config.Image}}'
# Expected: thnhit/technhvoice:voice-bridge-v1.11.0
```

---

## 9. Health checks

### voice-bridge (TCP AudioSocket — no HTTP /healthz)

```bash
docker ps --filter name=technolohit-voice-bridge --format '{{.Names}} {{.Status}}'
docker logs --tail=40 technolohit-voice-bridge 2>&1 | grep -E 'listening on|voice-bridge|error' || true
docker exec technolohit-voice-bridge sh -lc 'printenv VOICE_RUNTIME_VERSION VOICE_BRIDGE_PORT IMAGE_TAG BUILD_VERSION'
```

Expected log line similar to: `listening on 0.0.0.0:9092`.

### RAG API (host-local from voice-bridge context)

```bash
docker exec technolohit-voice-bridge sh -lc 'printenv VOICE_RAG_API_URL'
curl -fsS http://127.0.0.1:8080/healthz || wget -qO- http://127.0.0.1:8080/healthz
```

Expected JSON health response from rag-api on host port 8080.

### v4 flags still off inside container

```bash
docker exec technolohit-voice-bridge sh -lc \
  'printenv | sort | egrep "^VOICE_(RUNTIME_VERSION|V4_REALTIME|V4_CANARY|V4_BARGE|V4_STREAMING|RAG_ENABLED|RAG_SALES)="'
```

All `VOICE_V4_*` must be `false`; `VOICE_RUNTIME_VERSION=v3`.

---

## 10. Verify no v4 quality DB writes while v3 active

Baseline before test call:

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c \
  "SELECT count(*) AS quality_events_24h FROM voice.call_quality_events WHERE created_at > now() - interval '24 hours';"
```

Place one normal v3 test call. Re-run count. **Expected:** no increase while `VOICE_RUNTIME_VERSION=v3` (v4 quality flush is v4-path-only).

Analytics queries (after future v4 canary): [voice_assistant_v4_phase8_quality_analytics_queries.sql](./voice_assistant_v4_phase8_quality_analytics_queries.sql)

---

## 11. Rollback to previous immutable image

**Do not use `latest`.** Pin previous known-good tag:

```bash
cd /opt/technolohit-voice/asterisk
export VOICE_BRIDGE_IMAGE=thnhit/technhvoice:voice-bridge-v1.10.0   # example — use tag recorded in step 1
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull voice-bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d voice-bridge
docker inspect technolohit-voice-bridge --format 'running_image={{.Config.Image}}'
```

Schema migrations 006–009 are forward-only and **do not need rollback** for image rollback.

Dry-run checklist:

- [ ] Previous tag name recorded before deploy
- [ ] Rollback command tested in staging OR validated command syntax
- [ ] Post-rollback: `VOICE_RUNTIME_VERSION=v3`, test call OK

---

## 12. Collect logs (privacy-safe)

```bash
docker logs --tail=200 technolohit-voice-bridge 2>&1 \
  | grep -vEi 'api[_-]?key|password|secret|Bearer |Authorization:' \
  | grep -vE '\+?[0-9]{8,}' \
  > voice-bridge-post-deploy-redacted.log

docker logs --tail=100 technolohit-rag-api 2>&1 \
  | grep -vEi 'api[_-]?key|password|secret' \
  > rag-api-post-deploy-redacted.log
```

Do not paste `.env` contents into tickets. Use `printenv` grep for **flag names only** (section 9).

---

## 13. Optional controlled canary (NOT production default)

**Warning:** For isolated test host or explicit maintenance window only. **Never** apply as production default.

Temporary env on **test** host only:

```env
# NOT PRODUCTION — canary harness only
VOICE_RUNTIME_VERSION=v4
VOICE_V4_REALTIME_ENABLED=true
VOICE_V4_CANARY_ENABLED=true
VOICE_V4_BARGE_IN_ENABLED=false
# persistQualityToDb only when validating Phase 8 DB path:
# (requires harnessExplicit in code paths — live AudioSocket still v3 unless further wired)
```

Revert immediately after test. Production must return to section 7 defaults.

Canary validation uses repo tests/docs — not live production traffic without QA route approval.

---

## 14. Post-deploy acceptance sign-off

| Check | Pass |
|-------|------|
| Migrations 006–009 applied | ☐ |
| Knowledge 003 applied (if needed) | ☐ |
| `call_quality_events` table exists | ☐ |
| Image = `voice-bridge-v1.11.0` | ☐ |
| `VOICE_RUNTIME_VERSION=v3` | ☐ |
| All `VOICE_V4_*` off | ☐ |
| RAG OK via `http://127.0.0.1:8080/healthz` | ☐ |
| No quality event growth on v3 calls | ☐ |
| Rollback tag recorded | ☐ |
| Production v4 blockers still tracked | ☐ |

Operator: _______________  Date: _______________
