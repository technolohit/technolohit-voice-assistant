-- TechnoloHit knowledge/RAG schema.
-- Apply only after pgvector is available in technolohit_growth.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS knowledge;

CREATE TABLE IF NOT EXISTS knowledge.documents (
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

CREATE TABLE IF NOT EXISTS knowledge.chunks (
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

CREATE TABLE IF NOT EXISTS knowledge.embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id uuid NOT NULL REFERENCES knowledge.chunks(id) ON DELETE CASCADE,
  tenant_id text NOT NULL DEFAULT 'technolohit',
  model text NOT NULL,
  dimensions integer NOT NULL DEFAULT 1536,
  embedding vector(1536) NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chunk_id, model, dimensions)
);

CREATE TABLE IF NOT EXISTS knowledge.retrieval_logs (
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

CREATE INDEX IF NOT EXISTS knowledge_documents_tenant_active_idx
  ON knowledge.documents (tenant_id, is_active);

CREATE INDEX IF NOT EXISTS knowledge_chunks_tenant_document_idx
  ON knowledge.chunks (tenant_id, document_id, chunk_index);

CREATE INDEX IF NOT EXISTS knowledge_embeddings_tenant_model_idx
  ON knowledge.embeddings (tenant_id, model, dimensions);

CREATE INDEX IF NOT EXISTS knowledge_embeddings_hnsw_idx
  ON knowledge.embeddings
  USING hnsw (embedding vector_cosine_ops);

COMMIT;
