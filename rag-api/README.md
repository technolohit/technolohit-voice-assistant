# TechnoloHit RAG API

FastAPI service for pgvector-backed TechnoloHit knowledge retrieval.

This service is intentionally separate from `voice-bridge`. Live calls must keep deterministic routing first and use RAG only as an optional, timeout-protected fallback after QA.

## Environment

```env
RAG_DB_HOST=10.20.0.1
RAG_DB_PORT=5432
RAG_DB_NAME=technolohit_growth
RAG_DB_USER=technolohit_rag_app
RAG_DB_PASSWORD=
RAG_DB_SSL=false
RAG_DB_STATEMENT_TIMEOUT_MS=500
OPENAI_API_KEY=
RAG_EMBEDDING_MODEL=text-embedding-3-small
RAG_EMBEDDING_DIMENSIONS=1536
RAG_DEFAULT_TENANT_ID=technolohit
RAG_DEFAULT_LANGUAGE=de
RAG_DEFAULT_TOP_K=3
RAG_DEFAULT_MIN_SCORE=0.72
RAG_EXACT_PRODUCT_BOOST=0.03
RAG_SEMANTIC_PRODUCT_BOOST=0.04
RAG_RETRIEVE_CANDIDATE_LIMIT=12
RAG_SEMANTIC_PRODUCT_ACCEPT_FLOOR=0.66
RAG_LOG_QUERY_PREVIEW=false
```

## Endpoints

```text
GET /healthz
GET /readyz
POST /v1/retrieve
POST /v1/ingest/document
POST /v1/ingest/reindex
```

`/readyz` returns `503` until the DB is configured, pgvector is installed, and the `knowledge.embeddings.embedding` vector column exists.

## Local Run

```bash
cd rag-api
python -m venv .venv
. .venv/Scripts/activate  # Windows PowerShell/Git Bash users may need the matching activation command
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8080
```

## Safety Defaults

- Retrieval logs store a query hash by default.
- Raw query previews are disabled unless `RAG_LOG_QUERY_PREVIEW=true`.
- The service does not run DB migrations.
- Production schema changes belong to `db/knowledge/migrations`.
- `voice-bridge` must keep `VOICE_RAG_ENABLED=false` until RAG QA passes.

## Ingest Approved TechnoloHit Knowledge

After pgvector production cutover is green, `RAG_DB_USER` exists, and `npm run db:migrate:knowledge` has been applied, ingest approved local knowledge:

```bash
cd rag-api
python scripts/ingest_technolohit_knowledge.py --dry-run
python scripts/ingest_technolohit_knowledge.py --api-url http://localhost:8080
```

The script sends:

- `voice-bridge/knowledge/products.technolohit.json`
- `voice-bridge/knowledge/faqs.technolohit.json`
- `voice-bridge/knowledge/technolohit.md`

Do not ingest raw call transcripts automatically.

## Contract Tests

Static contract tests are in `rag-api/tests/`. They verify required routes, privacy-safe preview defaults, and disabled-by-default voice RAG flags.
