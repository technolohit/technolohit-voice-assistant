-- Lead Dashboard support tables (schema voice only). Idempotent.
-- Stores follow-up workflow state and audit events for explicit phone reveal/status changes.

BEGIN;

CREATE TABLE IF NOT EXISTS voice.lead_access_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES voice.leads (id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('view_lead', 'reveal_phone', 'update_status')),
  old_value TEXT,
  new_value TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_access_audit_created
  ON voice.lead_access_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_access_audit_lead_created
  ON voice.lead_access_audit (lead_id, created_at DESC);

CREATE TABLE IF NOT EXISTS voice.lead_followup_status (
  lead_id UUID PRIMARY KEY REFERENCES voice.leads (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'new' CHECK (
    status IN ('new', 'contacted', 'not_reachable', 'done')
  ),
  notes TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
