-- TechnoloHit Voice Assistant — schema voice (technolohit_growth database)
-- Apply as PostgreSQL admin. Idempotent where practical (IF NOT EXISTS).
-- Does not modify schema growth.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS voice;

-- ---------------------------------------------------------------------------
-- updated_at helper (voice schema only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION voice.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- call_sessions — one row per telephony / voice session
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice.call_sessions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_call_id        TEXT NOT NULL,
  provider                TEXT NOT NULL DEFAULT '',
  direction               TEXT NOT NULL DEFAULT 'inbound' CHECK (
    direction IN ('inbound', 'outbound', 'unknown')
  ),
  status                  TEXT NOT NULL DEFAULT 'initiated' CHECK (
    status IN (
      'initiated',
      'ringing',
      'in_progress',
      'completed',
      'failed',
      'cancelled',
      'no_answer'
    )
  ),
  caller_phone_raw        TEXT NOT NULL DEFAULT '',
  caller_phone_normalized TEXT NOT NULL DEFAULT '',
  callee_phone_raw        TEXT NOT NULL DEFAULT '',
  callee_phone_normalized TEXT NOT NULL DEFAULT '',
  lead_id                 UUID,
  started_at              TIMESTAMPTZ,
  ended_at                TIMESTAMPTZ,
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT call_sessions_external_call_id_nonempty CHECK (btrim(external_call_id) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_call_sessions_external_call_id
  ON voice.call_sessions (external_call_id);

CREATE INDEX IF NOT EXISTS idx_call_sessions_status_started
  ON voice.call_sessions (status, started_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_call_sessions_caller_normalized
  ON voice.call_sessions (caller_phone_normalized)
  WHERE caller_phone_normalized <> '';

CREATE INDEX IF NOT EXISTS idx_call_sessions_lead_id
  ON voice.call_sessions (lead_id)
  WHERE lead_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- call_events — structured timeline for a session
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice.call_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_session_id   UUID NOT NULL REFERENCES voice.call_sessions (id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,
  event_source      TEXT NOT NULL DEFAULT '',
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT call_events_event_type_nonempty CHECK (btrim(event_type) <> '')
);

CREATE INDEX IF NOT EXISTS idx_call_events_session_occurred
  ON voice.call_events (call_session_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_call_events_type_occurred
  ON voice.call_events (event_type, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- call_transcripts — utterance / segment storage
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice.call_transcripts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_session_id   UUID NOT NULL REFERENCES voice.call_sessions (id) ON DELETE CASCADE,
  segment_index     INTEGER NOT NULL DEFAULT 0 CHECK (segment_index >= 0),
  speaker           TEXT NOT NULL DEFAULT 'unknown',
  content           TEXT NOT NULL DEFAULT '',
  language_code     TEXT NOT NULL DEFAULT '',
  confidence        NUMERIC(5, 4),
  recorded_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT call_transcripts_content_nonempty CHECK (btrim(content) <> '')
);

CREATE INDEX IF NOT EXISTS idx_call_transcripts_session_segment
  ON voice.call_transcripts (call_session_id, segment_index);

-- ---------------------------------------------------------------------------
-- leads — voice-captured leads; match keys for future growth.prospects / crm
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice.leads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_session_id       UUID REFERENCES voice.call_sessions (id) ON DELETE SET NULL,
  growth_prospect_id    TEXT,
  company_name          TEXT NOT NULL DEFAULT '',
  email                 TEXT NOT NULL DEFAULT '',
  normalized_phone      TEXT NOT NULL DEFAULT '',
  normalized_domain     TEXT NOT NULL DEFAULT '',
  city                  TEXT NOT NULL DEFAULT '',
  country               CHAR(2) CHECK (country IS NULL OR country IN ('DE', 'AT', 'CH')),
  status                TEXT NOT NULL DEFAULT 'new' CHECK (
    status IN ('new', 'qualified', 'not_relevant', 'merged', 'archived')
  ),
  source                TEXT NOT NULL DEFAULT 'voice',
  notes                 TEXT NOT NULL DEFAULT '',
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN voice.leads.growth_prospect_id IS
  'Optional link to growth.prospects.prospect_id when matched; no FK until explicitly required.';

COMMENT ON COLUMN voice.leads.normalized_domain IS
  'Hostname only, lowercase — align with growth.prospects.normalized_domain for dedupe.';

COMMENT ON COLUMN voice.leads.normalized_phone IS
  'Whitespace-stripped phone for matching growth.prospects.phone_normalized.';

CREATE INDEX IF NOT EXISTS idx_leads_match_domain
  ON voice.leads (normalized_domain)
  WHERE normalized_domain <> '';

CREATE INDEX IF NOT EXISTS idx_leads_match_phone
  ON voice.leads (normalized_phone)
  WHERE normalized_phone <> '';

CREATE INDEX IF NOT EXISTS idx_leads_match_email
  ON voice.leads (lower(trim(email)))
  WHERE email <> '';

CREATE INDEX IF NOT EXISTS idx_leads_match_company_city
  ON voice.leads (lower(trim(company_name)), lower(trim(city)))
  WHERE company_name <> '' AND city <> '';

CREATE INDEX IF NOT EXISTS idx_leads_growth_prospect_id
  ON voice.leads (growth_prospect_id)
  WHERE growth_prospect_id IS NOT NULL AND btrim(growth_prospect_id) <> '';

CREATE INDEX IF NOT EXISTS idx_leads_call_session_id
  ON voice.leads (call_session_id)
  WHERE call_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- call_summaries — post-call LLM / human summary
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice.call_summaries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_session_id   UUID NOT NULL REFERENCES voice.call_sessions (id) ON DELETE CASCADE,
  summary_text      TEXT NOT NULL DEFAULT '',
  summary_type      TEXT NOT NULL DEFAULT 'auto' CHECK (
    summary_type IN ('auto', 'human', 'mixed')
  ),
  model             TEXT NOT NULL DEFAULT '',
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT call_summaries_summary_text_nonempty CHECK (btrim(summary_text) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_call_summaries_session_type
  ON voice.call_summaries (call_session_id, summary_type);

-- ---------------------------------------------------------------------------
-- FK: call_sessions.lead_id → voice.leads (deferred add after leads exists)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'call_sessions_lead_id_fkey'
      AND conrelid = 'voice.call_sessions'::regclass
  ) THEN
    ALTER TABLE voice.call_sessions
      ADD CONSTRAINT call_sessions_lead_id_fkey
      FOREIGN KEY (lead_id) REFERENCES voice.leads (id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_call_sessions_updated_at ON voice.call_sessions;
CREATE TRIGGER trg_call_sessions_updated_at
  BEFORE UPDATE ON voice.call_sessions
  FOR EACH ROW
  EXECUTE PROCEDURE voice.set_updated_at();

DROP TRIGGER IF EXISTS trg_leads_updated_at ON voice.leads;
CREATE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON voice.leads
  FOR EACH ROW
  EXECUTE PROCEDURE voice.set_updated_at();

DROP TRIGGER IF EXISTS trg_call_summaries_updated_at ON voice.call_summaries;
CREATE TRIGGER trg_call_summaries_updated_at
  BEFORE UPDATE ON voice.call_summaries
  FOR EACH ROW
  EXECUTE PROCEDURE voice.set_updated_at();

COMMIT;
