# Sysadmin Prompt: pgvector / RAG Infra Prep v1

Date: 2026-05-21

## Purpose

Prepare the TechnoloHit cloud database infrastructure for real pgvector-backed RAG without risking the current production `growth` and `voice` data.

This is an infra preparation task. Do not deploy application RAG behavior to live calls yet.

## Approved Direction

- Production currently does **not** have pgvector installed.
- Current `central_postgres` image is `postgres:16-alpine`.
- Lightweight file-based retrieval exists, but real pgvector-backed RAG is not implemented yet.
- pgvector must be enabled by switching to a pinned pgvector-enabled PostgreSQL 16 image.
- Do not install packages inside the running production Postgres container.
- A mandatory dry-run restore must pass before production cutover.
- Keep deterministic `voice-bridge` routing and Soft Intake first. RAG will later be optional fallback only.

Recommended pinned image:

```text
pgvector/pgvector:0.8.2-pg16-bookworm@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc
```

## Ownership Boundary

Infra/Ansible owns:

- DB image and digest pinning
- Docker volumes
- backups and restore runbook
- dry-run restore evidence
- production maintenance window
- health checks
- rollback to old image and old volume

Application repo owns:

- `knowledge` SQL migrations
- `technolohit-rag-api` code
- ingestion/reindex scripts
- `voice-bridge` RAG feature flags
- RAG QA queries and docs

Do not require cloning the application repo on the DB server.

## Phase 1: Current-State Evidence

Please capture and report:

```bash
docker inspect central_postgres --format '{{.Config.Image}}'
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -P pager=off -c "SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name='vector';"
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -P pager=off -c "SELECT extname, extversion FROM pg_extension ORDER BY extname;"
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -P pager=off -c "SELECT table_schema, table_name, column_name, udt_name FROM information_schema.columns WHERE udt_name='vector';"
```

Expected today:

- image is `postgres:16-alpine`
- no available `vector`
- no installed `vector`
- no vector columns

## Phase 2: Backup

Create a logical backup and verify it is non-empty:

```bash
BACKUP="/root/backup_before_pgvector_$(date -u +%Y%m%dT%H%M%SZ).sql"
docker exec central_postgres pg_dumpall -U "$POSTGRES_USER" > "$BACKUP"
ls -lh "$BACKUP"
test -s "$BACKUP"
```

Also snapshot/copy the current Docker volume if infra policy supports it.

Report:

- backup path
- file size
- timestamp
- old Docker image
- old Docker volume name
- available disk space before and after backup

## Phase 3: Mandatory Dry-Run Restore

Before touching production, create a temporary pgvector-enabled Postgres 16 container/volume and restore the backup there.

Requirements:

- use the pinned pgvector image
- use a temporary volume, not the existing production volume
- restore the logical backup
- verify existing database and schemas
- enable `vector`
- verify vector appears in `pg_extension`

Suggested checks after restore:

```sql
SELECT datname FROM pg_database WHERE datname = 'technolohit_growth';
SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('growth', 'voice');
SELECT extname, extversion FROM pg_extension WHERE extname IN ('pgcrypto', 'vector') ORDER BY extname;
SELECT count(*) FROM growth.prospects;
SELECT count(*) FROM voice.call_sessions;
SELECT count(*) FROM voice.call_transcripts;
CREATE EXTENSION IF NOT EXISTS vector;
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
```

Production cutover is blocked until this dry-run passes.

## Phase 4: Production Cutover Plan

Only after dry-run restore passes:

1. Schedule a maintenance window.
2. Stop or pause write-heavy app services if needed.
3. Take a fresh final backup and verify non-zero size.
4. Keep the old `postgres:16-alpine` volume untouched.
5. Create a new production pgvector volume.
6. Start `central_postgres` with the pinned pgvector image and the new volume.
7. Restore the final backup.
8. Run:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

9. Verify:

```sql
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
SELECT count(*) FROM growth.prospects;
SELECT count(*) FROM voice.call_sessions;
SELECT count(*) FROM voice.call_transcripts;
```

10. Start app services.
11. Confirm app health and voice persistence.

## Phase 5: Rollback Plan

If production cutover fails:

1. Stop app services that write to DB.
2. Stop the new pgvector `central_postgres`.
3. Point Compose/Ansible back to:

```text
postgres:16-alpine
old production volume
```

4. Start old DB.
5. Verify:

```bash
docker exec central_postgres pg_isready -U "$POSTGRES_USER"
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -c "SELECT now();"
```

6. Restart app services.

Important caveat:

- Writes made after cutover to the new DB may be lost on rollback unless manually replayed.
- Keep the cutover window short and avoid dual-write complexity for this first migration.

## Phase 6: Evidence To Send Back

Please report:

- final chosen image string including digest
- old image and old volume name
- new image and new volume name
- backup file path and size
- dry-run restore status
- production cutover status, if performed
- outputs proving `vector` is installed
- smoke query counts
- rollback commands tested or documented
- any blockers before app team runs `knowledge` migrations

## Do Not Do

- Do not install pgvector manually inside the running DB container.
- Do not mutate production before backup.
- Do not mount the existing Alpine-created production volume directly into the new Debian/Bookworm pgvector image without a tested restore plan.
- Do not run app-owned `knowledge` migrations until the app team provides reviewed SQL.
- Do not enable live-call RAG behavior yet.
