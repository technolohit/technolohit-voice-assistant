-- v4 Phase 1: tenant/agent/version fields on transcript/event/summary tables.

BEGIN;

ALTER TABLE voice.call_transcripts
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'technolohit';

ALTER TABLE voice.call_transcripts
  ADD COLUMN IF NOT EXISTS agent_id text NOT NULL DEFAULT 'main_voice_sales';

ALTER TABLE voice.call_transcripts
  ADD COLUMN IF NOT EXISTS agent_config_version text;

ALTER TABLE voice.call_transcripts
  ADD COLUMN IF NOT EXISTS prompt_playbook_version text;

ALTER TABLE voice.call_transcripts
  ADD COLUMN IF NOT EXISTS knowledge_version text;

ALTER TABLE voice.call_transcripts
  ADD COLUMN IF NOT EXISTS runtime_version text;

ALTER TABLE voice.call_events
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'technolohit';

ALTER TABLE voice.call_events
  ADD COLUMN IF NOT EXISTS agent_id text NOT NULL DEFAULT 'main_voice_sales';

ALTER TABLE voice.call_events
  ADD COLUMN IF NOT EXISTS agent_config_version text;

ALTER TABLE voice.call_events
  ADD COLUMN IF NOT EXISTS prompt_playbook_version text;

ALTER TABLE voice.call_events
  ADD COLUMN IF NOT EXISTS knowledge_version text;

ALTER TABLE voice.call_events
  ADD COLUMN IF NOT EXISTS runtime_version text;

ALTER TABLE voice.call_summaries
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'technolohit';

ALTER TABLE voice.call_summaries
  ADD COLUMN IF NOT EXISTS agent_id text NOT NULL DEFAULT 'main_voice_sales';

ALTER TABLE voice.call_summaries
  ADD COLUMN IF NOT EXISTS agent_config_version text;

ALTER TABLE voice.call_summaries
  ADD COLUMN IF NOT EXISTS prompt_playbook_version text;

ALTER TABLE voice.call_summaries
  ADD COLUMN IF NOT EXISTS knowledge_version text;

ALTER TABLE voice.call_summaries
  ADD COLUMN IF NOT EXISTS runtime_version text;

CREATE INDEX IF NOT EXISTS idx_call_transcripts_tenant_agent_created
  ON voice.call_transcripts (tenant_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_events_tenant_agent_occurred
  ON voice.call_events (tenant_id, agent_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_summaries_tenant_agent_created
  ON voice.call_summaries (tenant_id, agent_id, created_at DESC);

COMMIT;
