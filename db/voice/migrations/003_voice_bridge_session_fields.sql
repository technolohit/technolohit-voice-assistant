-- Voice bridge runtime fields (schema voice only). Idempotent.

BEGIN;

ALTER TABLE voice.call_sessions
  ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT '';

ALTER TABLE voice.call_sessions
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER CHECK (
    duration_seconds IS NULL OR duration_seconds >= 0
  );

ALTER TABLE voice.call_sessions DROP CONSTRAINT IF EXISTS call_sessions_status_check;

ALTER TABLE voice.call_sessions ADD CONSTRAINT call_sessions_status_check CHECK (
  status IN (
    'initiated',
    'ringing',
    'in_progress',
    'active',
    'completed',
    'failed',
    'cancelled',
    'no_answer'
  )
);

COMMIT;
