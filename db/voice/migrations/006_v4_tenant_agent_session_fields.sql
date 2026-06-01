-- v4 Phase 1: tenant/agent/version fields on call_sessions (forward-only, v3-safe defaults).

BEGIN;

ALTER TABLE voice.call_sessions
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'technolohit';

ALTER TABLE voice.call_sessions
  ADD COLUMN IF NOT EXISTS agent_id text NOT NULL DEFAULT 'main_voice_sales';

ALTER TABLE voice.call_sessions
  ADD COLUMN IF NOT EXISTS agent_config_version text;

ALTER TABLE voice.call_sessions
  ADD COLUMN IF NOT EXISTS prompt_playbook_version text;

ALTER TABLE voice.call_sessions
  ADD COLUMN IF NOT EXISTS knowledge_version text;

ALTER TABLE voice.call_sessions
  ADD COLUMN IF NOT EXISTS runtime_version text;

CREATE INDEX IF NOT EXISTS idx_call_sessions_tenant_agent_started
  ON voice.call_sessions (tenant_id, agent_id, started_at DESC NULLS LAST);

COMMIT;
