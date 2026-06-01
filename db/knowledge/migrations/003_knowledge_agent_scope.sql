-- v4 Phase 1: agent scope on knowledge documents and retrieval logs.
-- Replaces document uniqueness (tenant_id, source_uri, content_hash) with agent-aware key.
-- Existing rows receive default agent_id='main_voice_sales' for backward compatibility.

BEGIN;

ALTER TABLE knowledge.documents
  ADD COLUMN IF NOT EXISTS agent_id text NOT NULL DEFAULT 'main_voice_sales';

-- Drop legacy tenant-only unique constraint before adding agent-aware uniqueness.
ALTER TABLE knowledge.documents
  DROP CONSTRAINT IF EXISTS documents_tenant_id_source_uri_content_hash_key;

DO $$
DECLARE
  legacy_constraint text;
BEGIN
  SELECT c.conname
    INTO legacy_constraint
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON t.relnamespace = n.oid
  WHERE n.nspname = 'knowledge'
    AND t.relname = 'documents'
    AND c.contype = 'u'
    AND pg_get_constraintdef(c.oid) LIKE '%UNIQUE (tenant_id, source_uri, content_hash)%';

  IF legacy_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE knowledge.documents DROP CONSTRAINT IF EXISTS %I',
      legacy_constraint
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'knowledge'
      AND t.relname = 'documents'
      AND c.conname = 'documents_tenant_agent_source_content_key'
  ) THEN
    ALTER TABLE knowledge.documents
      ADD CONSTRAINT documents_tenant_agent_source_content_key
      UNIQUE (tenant_id, agent_id, source_uri, content_hash);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS knowledge_documents_tenant_agent_active_idx
  ON knowledge.documents (tenant_id, agent_id, is_active);

ALTER TABLE knowledge.retrieval_logs
  ADD COLUMN IF NOT EXISTS agent_id text NOT NULL DEFAULT 'main_voice_sales';

CREATE INDEX IF NOT EXISTS knowledge_retrieval_logs_tenant_agent_created_idx
  ON knowledge.retrieval_logs (tenant_id, agent_id, created_at DESC);

COMMIT;
