# Sysadmin Runbook: pgvector Production Cutover v1

Date: 2026-05-21

## Status

Dry-run restore is green.

Production cutover is now complete/green.

Current production:

- container: `central_postgres`
- image: `pgvector/pgvector:0.8.2-pg16-bookworm@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc`
- active data bind mount: `/srv/central-postgres/data-pgvector -> /var/lib/postgresql/data`
- rollback data path preserved: `/srv/central-postgres/data`
- database: `technolohit_growth`
- runtime/admin user: `postgres`
- active extension: `vector 0.8.2`
- smoke counts:
  - `growth.prospects = 40`
  - `voice.call_sessions = 113`
  - `voice.call_transcripts = 674`
- vector smoke with `embedding vector(3)` and `<=>` passed
- `central-postgres-backup.sh` verified after cutover

Gate status:

- Gate 1 (dry-run restore): green
- Gate 2 (production pgvector cutover): green
- Gate 3+ remain pending (knowledge migration, RAG API deploy/QA, voice-bridge fallback QA)

Approved pgvector image:

```text
pgvector/pgvector:0.8.2-pg16-bookworm@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc
```

## Cutover Rule

Do not mount the old Alpine data directory into the new pgvector image.

Use a fresh production pgvector data path, restore a fresh final `pg_dumpall`, enable `vector`, smoke test, then restart application services.

Recommended new production data path:

```text
/srv/central-postgres/data-pgvector
```

Keep old rollback path untouched:

```text
/srv/central-postgres/data
```

## Pre-Cutover Checklist

- [x] Maintenance window approved.
- [x] App services that write to Postgres identified.
- [x] Old image recorded: `postgres:16-alpine`.
- [x] Old data path recorded: `/srv/central-postgres/data`.
- [x] Dry-run restore evidence archived.
- [x] Disk space checked.
- [x] Rollback commands ready.
- [x] `RAG_DB_USER` creation plan ready, app-owned migrations still pending.
- [x] No live-call RAG dependency enabled.

Pinned runtime user for app migration/grants:

```env
RAG_DB_USER=technolohit_rag_app
```

## Compose / Ansible Change

Infra should change only the Postgres runtime image and data mount for cutover.

Before:

```yaml
services:
  central_postgres:
    image: postgres:16-alpine
    volumes:
      - /srv/central-postgres/data:/var/lib/postgresql/data
```

After:

```yaml
services:
  central_postgres:
    image: pgvector/pgvector:0.8.2-pg16-bookworm@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc
    environment:
      POSTGRES_USER: restore_admin
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: technolohit_growth
    volumes:
      - /srv/central-postgres/data-pgvector:/var/lib/postgresql/data
```

Do not delete or rename `/srv/central-postgres/data`.

Use the same `restore_admin` bootstrap pattern that passed dry-run **only for first initialization of the new empty pgvector data path**. If the new container is initialized with `POSTGRES_USER=postgres`, `pg_dumpall` may fail because the `postgres` role already exists.

Important user contract:

- `restore_admin` is a temporary/bootstrap restore user, not the long-term operational admin user.
- Keep `/srv/central-postgres/.env` and existing admin scripts stable if possible.
- After `pg_dumpall` restore, the production `postgres` role exists again and should remain the normal admin/backup user.
- Existing backup scripts should continue to use `POSTGRES_USER=postgres` after cutover, unless Sysadmin intentionally chooses otherwise.
- If Compose reads `/srv/central-postgres/.env`, prefer a one-time override for initialization instead of permanently changing shared `POSTGRES_USER`.

One-time initialization examples:

```bash
POSTGRES_USER=restore_admin docker compose up -d central_postgres
```

or, if Ansible templates Compose env explicitly, set `POSTGRES_USER=restore_admin` only for the first boot of `/srv/central-postgres/data-pgvector`, restore the dump, then switch the operational env back to `POSTGRES_USER=postgres` and recreate/restart the container against the same restored data path.

## Production Cutover Commands

Adjust Compose command/path names to the server layout if needed.

### 1. Set Variables

```bash
export PGV_IMAGE='pgvector/pgvector:0.8.2-pg16-bookworm@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc'
export OLD_DATA='/srv/central-postgres/data'
export NEW_DATA='/srv/central-postgres/data-pgvector'
export BACKUP_DIR='/srv/central-postgres/backups/pgvector-prep'
export FINAL_BACKUP="$BACKUP_DIR/pg_dumpall_before_pgvector_cutover_$(date -u +%Y%m%dT%H%M%SZ).sql"
```

### 2. Pause Writers

Stop or pause app containers that write to Postgres. Keep this list server-specific.

Examples:

```bash
docker stop technolohit-voice-bridge || true
docker stop n8n || true
```

If container names differ, use the real production names.

### 3. Final Backup

```bash
mkdir -p "$BACKUP_DIR"
docker exec central_postgres pg_dumpall -U "$POSTGRES_USER" > "$FINAL_BACKUP"
ls -lh "$FINAL_BACKUP"
test -s "$FINAL_BACKUP"
```

### 4. Stop Old Postgres

```bash
cd /srv/central-postgres
docker compose stop central_postgres
```

Verify old data still exists:

```bash
test -d "$OLD_DATA"
du -sh "$OLD_DATA"
```

### 5. Prepare New Data Path

```bash
mkdir -p "$NEW_DATA"
test -z "$(ls -A "$NEW_DATA" 2>/dev/null)" || { echo "NEW_DATA is not empty: $NEW_DATA"; exit 1; }
```

### 6. Apply Compose / Ansible Runtime Change

Update `central_postgres` to:

- image: `$PGV_IMAGE`
- data mount: `$NEW_DATA:/var/lib/postgresql/data`

Then start Postgres:

```bash
docker compose pull central_postgres
POSTGRES_USER=restore_admin docker compose up -d central_postgres
docker exec central_postgres pg_isready -U restore_admin
```

### 7. Restore Final Backup

```bash
cat "$FINAL_BACKUP" | docker exec -i central_postgres psql -U restore_admin -v ON_ERROR_STOP=1
```

The restored dump should recreate production roles and databases, including the normal production admin/app roles.

### 7b. Return Operational Admin Env To postgres

After restore succeeds, confirm the `postgres` role exists:

```bash
docker exec central_postgres psql -U restore_admin -d technolohit_growth -tAc "SELECT 1 FROM pg_roles WHERE rolname='postgres';"
```

Then return the shared runtime/admin environment to the stable value:

```text
POSTGRES_USER=postgres
```

If `/srv/central-postgres/.env` was temporarily changed, change it back now. Then recreate/restart only `central_postgres` against the same restored `/srv/central-postgres/data-pgvector` path:

```bash
docker compose up -d --force-recreate central_postgres
docker exec central_postgres pg_isready -U postgres
docker exec central_postgres psql -U postgres -d technolohit_growth -c "SELECT now();"
```

From this point forward, admin scripts and backup scripts should use `postgres` again.

### 8. Enable pgvector

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### 9. Verify

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c "
SELECT name, default_version, installed_version
FROM pg_available_extensions
WHERE name='vector';

SELECT extname, extversion
FROM pg_extension
WHERE extname IN ('pgcrypto','plpgsql','vector')
ORDER BY extname;

SELECT count(*) AS growth_prospects FROM growth.prospects;
SELECT count(*) AS voice_call_sessions FROM voice.call_sessions;
SELECT count(*) AS voice_call_transcripts FROM voice.call_transcripts;
"
```

Vector smoke:

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -v ON_ERROR_STOP=1 -c "
CREATE TEMP TABLE vector_smoke (id bigserial PRIMARY KEY, embedding vector(3));
INSERT INTO vector_smoke (embedding) VALUES ('[1,2,3]'), ('[1,1,1]');
SELECT id FROM vector_smoke ORDER BY embedding <=> '[1,2,2]' LIMIT 1;
"
```

### 9b. Verify Backup Script User

If the existing backup script sources `/srv/central-postgres/.env` and uses `POSTGRES_USER=postgres`, it should continue to work after cutover because the restored dump recreates the `postgres` role.

Run a non-destructive backup-script smoke check, or the smallest safe command equivalent:

```bash
docker exec central_postgres pg_dumpall -U postgres > /tmp/pgvector_cutover_backup_smoke.sql
test -s /tmp/pgvector_cutover_backup_smoke.sql
ls -lh /tmp/pgvector_cutover_backup_smoke.sql
rm -f /tmp/pgvector_cutover_backup_smoke.sql
```

If `central-postgres-backup.sh` wraps this same `pg_dumpall -U "$POSTGRES_USER"` behavior, no script change should be needed as long as `.env` is back to `POSTGRES_USER=postgres`.

Expected:

- `vector` installed version `0.8.2`
- `growth.prospects = 40` or higher if writes happened before final backup
- `voice.call_sessions = 113` or higher
- `voice.call_transcripts = 674` or higher
- vector smoke query returns one row

### 10. Restart Apps

```bash
docker start n8n || true
docker start technolohit-voice-bridge || true
```

Use actual production container names.

Then verify app logs and DB health.

## Rollback Commands

Use rollback if restore, pgvector enablement, smoke tests, or app startup fails.

### 1. Stop Writers

```bash
docker stop technolohit-voice-bridge || true
docker stop n8n || true
```

### 2. Stop New Postgres

```bash
cd /srv/central-postgres
docker compose stop central_postgres
```

### 3. Restore Compose / Ansible Runtime

Set:

```text
image: postgres:16-alpine
volume: /srv/central-postgres/data:/var/lib/postgresql/data
```

Do not delete `/srv/central-postgres/data-pgvector`; keep it for investigation.

### 4. Start Old DB

```bash
docker compose up -d central_postgres
docker exec central_postgres pg_isready -U "$POSTGRES_USER"
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -c "SELECT now();"
```

### 5. Restart Apps

```bash
docker start n8n || true
docker start technolohit-voice-bridge || true
```

Rollback caveat:

- Writes made after successful cutover to the new DB are not present in the old data path unless manually replayed.
- Keep the cutover window short.

## App Migrations After Cutover

After production pgvector cutover is green and `RAG_DB_USER=technolohit_rag_app` exists, the app team may run:

```bash
PRODUCTION_PGVECTOR_READY=true RAG_DB_USER=technolohit_rag_app npm run db:migrate:knowledge
```

Do not run this before production pgvector is verified.

Keep:

```env
VOICE_RAG_ENABLED=false
```

until `technolohit-rag-api` is deployed and QA passes.

## Dry-Run Cleanup Decision

Recommendation:

- Keep the dry-run container/volume until the production cutover plan is finalized and reviewed.
- After production cutover is green and rollback window is closed, the dry-run container/volume can be removed.

Cleanup later:

```bash
docker rm -f central_postgres_pgvector_dryrun_restore_20260521T211547Z
docker volume rm central_postgres_pgvector_dryrun_restore_20260521T211547Z
```

Only run cleanup after Sysadmin confirms the dry-run evidence is archived.
