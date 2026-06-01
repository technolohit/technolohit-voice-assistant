-- v4 Phase 1: usage/quality events for latency and runtime analytics.

BEGIN;

CREATE TABLE IF NOT EXISTS voice.call_quality_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'technolohit',
  agent_id text NOT NULL DEFAULT 'main_voice_sales',
  call_session_id uuid REFERENCES voice.call_sessions (id) ON DELETE CASCADE,
  event_type text NOT NULL,
  event_stage text,
  metric_name text,
  metric_value double precision,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_quality_events_event_type_nonempty CHECK (btrim(event_type) <> '')
);

CREATE INDEX IF NOT EXISTS idx_call_quality_events_tenant_agent_created
  ON voice.call_quality_events (tenant_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_quality_events_session_created
  ON voice.call_quality_events (call_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_quality_events_type_created
  ON voice.call_quality_events (event_type, created_at DESC);

COMMIT;
