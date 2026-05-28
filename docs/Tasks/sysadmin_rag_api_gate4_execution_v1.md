# Sysadmin Runbook: Gate 4 RAG API Execution v1

Date: 2026-05-22

## Scope

Gate 4 covers:

- deploy and run `technolohit-rag-api` as a separate service
- ingest only approved knowledge sources
- validate retrieval behavior and readiness

Gate 4 does **not** include:

- enabling `VOICE_RAG_ENABLED`
- making RAG API a hard production dependency for live calls
- enabling voice-bridge RAG lookup in runtime
- ingesting raw call transcripts

## Image

Pinned app image for this gate:

```text
thnhit/technhvoice:rag-api-gate4-hotfix-v2-20260522-012413
sha256:4a14a1977223fc1487b84459a4f414dae4aa9d84d4f0a14ba392d33bbbed60db
```

## Prerequisites (already green before Gate 4)

- Gate 2 green (pgvector production cutover complete)
- Gate 3 green (knowledge schema migration complete)
- `RAG_DB_USER=technolohit_rag_app` exists with least privilege
- `knowledge` schema objects exist

## 1) Deploy RAG API (production server)

Create or update env values in server runtime secrets (not in repo):

```env
RAG_DB_HOST=10.20.0.1
RAG_DB_PORT=5432
RAG_DB_NAME=technolohit_growth
RAG_DB_USER=technolohit_rag_app
RAG_DB_PASSWORD=<from-secret-manager>
RAG_DB_SSL=false
RAG_DB_STATEMENT_TIMEOUT_MS=500
OPENAI_API_KEY=<from-secret-manager>
RAG_EMBEDDING_MODEL=text-embedding-3-small
RAG_EMBEDDING_DIMENSIONS=1536
RAG_DEFAULT_TENANT_ID=technolohit
RAG_DEFAULT_LANGUAGE=de
RAG_DEFAULT_TOP_K=3
RAG_DEFAULT_MIN_SCORE=0.72
RAG_EXACT_PRODUCT_BOOST=0.03
RAG_LOG_QUERY_PREVIEW=false
```

Deploy command example:

```bash
docker pull thnhit/technhvoice:rag-api-gate4-hotfix-v2-20260522-012413
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d technolohit-rag-api
```

## 2) Readiness checks (production server)

Health:

```bash
curl -fsS http://127.0.0.1:8080/healthz
```

Readiness:

```bash
curl -fsS http://127.0.0.1:8080/readyz
```

Expected:

- `/healthz` returns service info and `ok=true`
- `/readyz` returns `ready=true` with `vector_version` and embedding column readiness

## 3) Ingest approved knowledge only (dev machine)

Dry-run first:

```bash
python rag-api/scripts/ingest_technolohit_knowledge.py --dry-run
```

Expected dry-run docs count: `11`.

Real ingest:

```bash
python rag-api/scripts/ingest_technolohit_knowledge.py --api-url http://<rag-api-host>:8080 --tenant-id technolohit
```

Approved sources only:

- `voice-bridge/knowledge/products.technolohit.json`
- `voice-bridge/knowledge/faqs.technolohit.json`
- `voice-bridge/knowledge/technolohit.md`

Do not ingest raw call transcripts.

## 4) Retrieval QA (production server)

Run semantic retrieval checks:

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/retrieve \
  -H 'content-type: application/json' \
  -d '{"tenant_id":"technolohit","query":"Was ist Botinteg?","language":"de","top_k":3,"min_score":0.72,"context":{"source":"gate4_qa"}}'

curl -sS -X POST http://127.0.0.1:8080/v1/retrieve \
  -H 'content-type: application/json' \
  -d '{"tenant_id":"technolohit","query":"Was ist LokalKI?","language":"de","top_k":3,"min_score":0.72,"context":{"source":"gate4_qa"}}'

curl -sS -X POST http://127.0.0.1:8080/v1/retrieve \
  -H 'content-type: application/json' \
  -d '{"tenant_id":"technolohit","query":"Was ist eine Smart Website?","language":"de","top_k":3,"min_score":0.72,"context":{"source":"gate4_qa"}}'
```

Expected:

- `hit=true` for the three approved product queries
- returned chunks reference approved sources
- no crash/timeouts under normal load

## 5) DB verification snapshot (production server)

```bash
docker exec central_postgres psql -U postgres -d technolohit_growth -P pager=off -c "
SELECT count(*) AS docs FROM knowledge.documents WHERE tenant_id='technolohit' AND is_active=true;
SELECT count(*) AS chunks FROM knowledge.chunks WHERE tenant_id='technolohit';
SELECT count(*) AS embeddings FROM knowledge.embeddings WHERE tenant_id='technolohit';
SELECT count(*) AS retrieval_logs FROM knowledge.retrieval_logs WHERE tenant_id='technolohit';
"
```

Schema reminder:

- `knowledge.retrieval_logs` does not have a `top_score` column.
- Use `min_score`, `hit_count`, and `selected_chunk_ids` for debug/reporting.

## 6) PASS/FAIL criteria

PASS if all are true:

- rag-api container is healthy/running
- `/readyz` reports `ready=true`
- ingest succeeds for approved sources
- retrieval QA queries return relevant hits
- DB counters increase as expected
- no raw transcript ingestion

FAIL if any:

- container crashloop or `/readyz` fails
- ingestion fails for approved sources
- retrieval misses clear product queries
- schema/permission errors in logs

## 7) Data collection before rollback

Collect and share:

- `docker logs technolohit-rag-api --since=30m`
- `/healthz` and `/readyz` outputs
- retrieval request/response samples
- DB verification SQL outputs

## 8) Rollback note

If Gate 4 fails, stop/remove only rag-api service/image.

Do **not** rollback Gate 2/Gate 3 DB state unless explicitly approved.

Keep:

- `VOICE_RAG_ENABLED=false`
- voice-bridge RAG lookup disabled

