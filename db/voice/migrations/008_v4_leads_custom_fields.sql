-- v4 Phase 1: tenant/agent scope and structured custom_fields on leads.

BEGIN;

ALTER TABLE voice.leads
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'technolohit';

ALTER TABLE voice.leads
  ADD COLUMN IF NOT EXISTS agent_id text NOT NULL DEFAULT 'main_voice_sales';

ALTER TABLE voice.leads
  ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_leads_tenant_agent_status_created
  ON voice.leads (tenant_id, agent_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_leads_tenant_agent_created
  ON voice.leads (tenant_id, agent_id, created_at DESC);

COMMIT;
