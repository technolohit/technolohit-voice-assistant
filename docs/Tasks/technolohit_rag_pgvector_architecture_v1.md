# TechnoloHit RAG / pgvector Architecture v1

Date: 2026-05-21

## Production Truth

Production verification showed that pgvector is not installed on `central_postgres`.

Facts:

- Current DB image: `postgres:16-alpine`
- `pg_available_extensions` has no `vector`
- `CREATE EXTENSION vector` fails because `vector.control` is not present
- No `vector` columns exist

Therefore:

- Phase 8 lightweight FAQ retrieval exists.
- Real pgvector-backed RAG is not implemented yet.
- Any previous wording that implied pgvector was installed/tested in production was incorrect.

## Dry-Run Restore Status

Dry-run restore completed successfully on 2026-05-21.

Evidence from Sysadmin:

- backup: `/srv/central-postgres/backups/pgvector-prep/pg_dumpall_before_pgvector_20260521T211547Z.sql`
- backup size: `2.3M`
- dry-run image: `pgvector/pgvector:0.8.2-pg16-bookworm@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc`
- dry-run container: `central_postgres_pgvector_dryrun_restore_20260521T211547Z`
- dry-run volume: `central_postgres_pgvector_dryrun_restore_20260521T211547Z`
- restored schemas: `growth`, `voice`
- installed extensions: `pgcrypto`, `plpgsql`, `vector`
- vector version: `0.8.2`
- smoke counts: `growth.prospects=40`, `voice.call_sessions=113`, `voice.call_transcripts=674`
- vector smoke test passed with a temporary `embedding vector(3)` table and `<=>` ordering

Production is still unchanged:

- image: `postgres:16-alpine`
- data bind mount: `/srv/central-postgres/data`

Production cutover runbook:

```text
docs/Tasks/sysadmin_pgvector_production_cutover_v1.md
```

Operational admin user clarification:

- `restore_admin` is only the temporary bootstrap user for first initialization of the new empty pgvector data path.
- After `pg_dumpall` restore, the restored `postgres` role should remain the normal admin/backup user.
- Shared server env and backup scripts should stay on `POSTGRES_USER=postgres` after cutover wherever possible.

## A. Recommended Architecture

Use a two-layer retrieval architecture:

1. Realtime voice path remains state-machine first.
   - deterministic product routing, callback/email choice, permission, caller ID, and closings stay inside `voice-bridge`
   - no external RAG call is allowed to block critical call control

2. Add a separate RAG service for semantic retrieval.
   - recommended service name: `technolohit-rag-api`
   - FastAPI is a good fit because embedding pipelines, ingestion jobs, and retrieval endpoints are natural in Python
   - `voice-bridge` calls it only as an optional fallback/support layer with a short timeout

Why not put RAG directly inside `voice-bridge`:

- voice-bridge is already responsible for live telephony, STT, TTS, state, persistence, and post-call processing
- semantic retrieval will grow into ingestion, chunking, re-indexing, evals, admin operations, and customer knowledge
- keeping RAG separate protects live calls from retrieval complexity and gives us a reusable product component

Recommended first production shape:

```text
voice-bridge
  -> deterministic intent/templates first
  -> local FAQ fallback
  -> optional RAG API lookup with 500-800 ms timeout
  -> safe LLM fallback / unknown fallback

technolohit-rag-api
  -> Postgres knowledge schema
  -> OpenAI embeddings
  -> pgvector search
  -> retrieval logs without raw sensitive caller transcript by default

central_postgres
  -> growth schema
  -> voice schema
  -> knowledge schema
  -> pgvector extension enabled in technolohit_growth
```

## B. Migration Plan

Recommendation: do not reuse the existing Alpine-created data volume blindly with a Debian pgvector image.

The pgvector official image line provides PostgreSQL 16 tags with pgvector preinstalled. The recommended image is:

```text
pgvector/pgvector:0.8.2-pg16-bookworm@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc
```

Use a versioned pgvector tag plus digest, not `pg16` alone.

Production-safe migration has two required stages: dry-run restore first, production cutover second.

### Mandatory Dry-Run Restore

Before production cutover, prove the backup/restore path on a temporary pgvector-enabled container or volume:

1. Create logical backup:

```bash
docker exec central_postgres pg_dumpall -U "$POSTGRES_USER" > /root/backup_pgvector_dry_run_$(date -u +%Y%m%dT%H%M%SZ).sql
test -s /root/backup_pgvector_dry_run_*.sql
```

2. Start a temporary pgvector-enabled PostgreSQL 16 container/volume using the pinned image.
3. Restore the backup into the temporary DB.
4. Verify:

```sql
SELECT datname FROM pg_database WHERE datname = 'technolohit_growth';
SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('growth', 'voice');
SELECT extname FROM pg_extension WHERE extname = 'pgcrypto';
SELECT count(*) FROM growth.prospects;
SELECT count(*) FROM voice.call_sessions;
SELECT count(*) FROM voice.call_transcripts;
CREATE EXTENSION IF NOT EXISTS vector;
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
```

5. Do not proceed to production cutover until every dry-run check is green.

### Production Cutover

1. Announce DB maintenance window.
2. Stop write-heavy app services if possible.
3. Create logical backup:

```bash
docker exec central_postgres pg_dumpall -U "$POSTGRES_USER" > /root/backup_before_pgvector_$(date -u +%Y%m%dT%H%M%SZ).sql
```

4. Also snapshot/copy the current Docker volume if infra allows it.
5. Create a new named Postgres volume for pgvector DB.
6. Start a new `central_postgres` container using the pinned pgvector image and the new volume.
7. Restore backup into the new DB.
8. Enable extension in `technolohit_growth`:

```bash
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

9. Run app smoke tests for growth, voice, and monitoring-related queries.
10. Only then apply app-owned `knowledge` schema migrations.

Why new volume + restore:

- it avoids Alpine-to-Debian libc/collation surprises on the same physical data files
- it preserves the old volume for rollback
- it proves the backup path works before we depend on new vector tables

## C. Rollback Plan

Keep the old container image and old volume untouched until verification passes.

Rollback steps:

1. Stop app services that write to DB.
2. Stop new `central_postgres`.
3. Restore compose image/volume reference to previous:

```text
postgres:16-alpine
old central_postgres volume
```

4. Start old DB container.
5. Verify:

```bash
docker exec central_postgres pg_isready -U "$POSTGRES_USER"
docker exec central_postgres psql -U "$POSTGRES_USER" -d technolohit_growth -c "SELECT now();"
```

6. Start app services again.

Rollback caveat:

- If writes happened on the new DB after cutover, rollback may lose those writes unless we replay them manually.
- Keep the maintenance window short and avoid dual-write complexity for this first migration.

## D. Docker Compose / Ansible Changes Needed

Infra-Ansible should own:

- DB image tag and digest
- DB volume names
- backup job and restore runbook
- container restart order
- health checks
- disk-space checks
- environment/secrets handling

Application repo should own:

- SQL migrations for `knowledge` schema
- RAG API app code
- ingestion scripts
- voice-bridge integration flags
- QA queries and runbooks

Compose change concept:

```yaml
services:
  central_postgres:
    image: pgvector/pgvector:0.8.2-pg16-bookworm@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc
    volumes:
      - central_postgres_pgvector_data:/var/lib/postgresql/data
```

Do not install packages into a running container.

## E. SQL Migration Outline

Create a new schema:

```sql
CREATE SCHEMA IF NOT EXISTS knowledge;
CREATE EXTENSION IF NOT EXISTS vector;
```

Initial tables:

```sql
CREATE TABLE knowledge.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'technolohit',
  source_type text NOT NULL,
  source_uri text NOT NULL,
  title text NOT NULL,
  language text NOT NULL DEFAULT 'de',
  content_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_uri, content_hash)
);

CREATE TABLE knowledge.chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES knowledge.documents(id) ON DELETE CASCADE,
  tenant_id text NOT NULL DEFAULT 'technolohit',
  chunk_index integer NOT NULL,
  content text NOT NULL,
  token_count integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE TABLE knowledge.embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id uuid NOT NULL REFERENCES knowledge.chunks(id) ON DELETE CASCADE,
  tenant_id text NOT NULL DEFAULT 'technolohit',
  model text NOT NULL,
  dimensions integer NOT NULL,
  embedding vector(1536) NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chunk_id, model, dimensions)
);

CREATE TABLE knowledge.retrieval_logs (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL DEFAULT 'technolohit',
  query_hash text NOT NULL,
  query_preview text,
  top_k integer NOT NULL,
  min_score numeric,
  latency_ms integer,
  hit_count integer NOT NULL DEFAULT 0,
  selected_chunk_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  caller_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Indexes:

```sql
CREATE INDEX knowledge_documents_tenant_active_idx
  ON knowledge.documents (tenant_id, is_active);

CREATE INDEX knowledge_chunks_tenant_document_idx
  ON knowledge.chunks (tenant_id, document_id, chunk_index);

CREATE INDEX knowledge_embeddings_tenant_model_idx
  ON knowledge.embeddings (tenant_id, model, dimensions);

CREATE INDEX knowledge_embeddings_hnsw_idx
  ON knowledge.embeddings
  USING hnsw (embedding vector_cosine_ops);
```

Use HNSW first for simplicity and good query performance. IVFFlat can come later when data volume is large enough and we want different speed/recall tradeoffs.

## F. RAG API Design

Recommended service: `technolohit-rag-api`

Endpoints:

```text
GET /healthz
GET /readyz
POST /v1/retrieve
POST /v1/ingest/document
POST /v1/ingest/reindex
GET /v1/documents
GET /v1/documents/{id}
DELETE /v1/documents/{id}
```

Realtime endpoint:

```http
POST /v1/retrieve
```

Request:

```json
{
  "tenant_id": "technolohit",
  "query": "Was ist Botinteg?",
  "language": "de",
  "top_k": 3,
  "min_score": 0.72,
  "context": {
    "call_id": "bridge:...",
    "turn_index": 2,
    "detected_intent": "unknown"
  }
}
```

Response:

```json
{
  "hit": true,
  "answer_context": [
    {
      "chunk_id": "...",
      "title": "Botinteg",
      "content": "Botinteg ist ...",
      "score": 0.84,
      "source_uri": "voice-bridge/knowledge/products.technolohit.json"
    }
  ],
  "latency_ms": 132
}
```

Timeout policy for live calls:

- voice-bridge timeout: 500-800 ms
- RAG API DB statement timeout: 300-500 ms for retrieval
- if timeout/error: return no hit and continue existing fallback
- never break the live call because RAG is slow

## G. Test Plan

DB verification:

```sql
SELECT name, default_version, installed_version
FROM pg_available_extensions
WHERE name = 'vector';

SELECT extname, extversion
FROM pg_extension
WHERE extname = 'vector';

SELECT table_schema, table_name, column_name, udt_name
FROM information_schema.columns
WHERE udt_name = 'vector';
```

Migration smoke:

```sql
SELECT count(*) FROM voice.call_sessions;
SELECT count(*) FROM voice.call_transcripts;
SELECT count(*) FROM growth.prospects;
```

Vector smoke:

```sql
CREATE TEMP TABLE vector_smoke (id bigserial PRIMARY KEY, embedding vector(3));
INSERT INTO vector_smoke (embedding) VALUES ('[1,2,3]'), ('[1,1,1]');
SELECT id FROM vector_smoke ORDER BY embedding <=> '[1,2,2]' LIMIT 1;
```

RAG API tests:

- health check returns OK
- ingest one TechnoloHit product document
- retrieve `Was ist Botinteg?` returns Botinteg chunk
- retrieve `Was ist LokalKI?` returns LokalKI chunk
- unknown nonsense returns `hit=false`
- query logs do not contain raw full transcript by default

Voice tests:

- deterministic product routing still wins over RAG
- `Ruckruf bitte`, `per Anruf`, `telefonisch` never go to RAG
- `Nummer drei` after product overview remains product router, not semantic search
- RAG API stopped/unavailable does not break calls

## H. Risks And Tradeoffs

Risks:

- DB image migration is the riskiest part; use backup and new volume restore.
- RAG can make bad calls sound more confident if not gated.
- Embedding model/dimension changes require re-indexing.
- Raw transcript logging can create privacy risk.
- Central Postgres becomes more important; bad vector queries must not harm voice/growth workloads.

Tradeoffs:

- Central pgvector is simpler than adding a separate vector database now.
- Separate RAG API adds one service but protects voice-bridge from retrieval complexity.
- HNSW uses more memory than exact search but is a good default once data grows.
- For the first few dozen docs, exact search is enough; the schema can still include HNSW for future scale.

## I. Concrete Next Implementation Steps

1. Sysadmin validates backup/restore plan with a mandatory dry-run restore into a temporary pgvector-enabled container/volume.
2. Infra-Ansible pins `pgvector/pgvector:0.8.2-pg16-bookworm@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc`.
3. Production migration window:
   - backup
   - new volume
   - restore
   - enable vector extension
   - smoke test
4. App repo adds `db/knowledge/migrations/001_knowledge_schema.sql`.
5. Build `technolohit-rag-api` as a separate service.
6. Add ingestion for:
   - TechnoloHit product catalog
   - FAQ catalog
   - approved knowledge markdown
7. Add voice-bridge optional integration:
   - `VOICE_RAG_ENABLED=false` by default until QA passes
   - `VOICE_RAG_API_URL`
   - `VOICE_RAG_TIMEOUT_MS=700`
   - `VOICE_RAG_MIN_SCORE=0.72`
8. Keep deterministic routing before RAG.
9. Add RAG QA SQL and live-call scenarios to docs.

## App Repo Implementation Started

Initial application-side work now exists behind disabled runtime flags:

- `db/knowledge/migrations/001_knowledge_schema.sql`
- `db/knowledge/migrations/002_knowledge_grants.sql`
- `scripts/db-migrate-knowledge-postgres.js`
- `rag-api/` FastAPI service skeleton
- `VOICE_RAG_ENABLED=false` voice-bridge config flag

These files do not change production by themselves. The knowledge migration command refuses to run if pgvector is not available in the target database, and the live-call RAG integration remains disabled by default.

## Direct Answer To Sysadmin

I agree with the direction to enable pgvector, but I would not treat it as a small in-place package install. The safest product-grade architecture is:

- pgvector in central Postgres, pinned image, backup/restore into a new volume
- separate RAG API service
- voice-bridge uses RAG only as optional fallback/support with strict timeout
- deterministic phone flows stay local and state-machine-first

This gives us future-ready semantic retrieval without making live calls fragile.
