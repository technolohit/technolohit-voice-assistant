-- Post-call transcription fields for voice.call_transcripts.
-- Voice schema only; no Growth/n8n schema changes.

BEGIN;

ALTER TABLE voice.call_transcripts
  ADD COLUMN IF NOT EXISTS sequence_number INTEGER NOT NULL DEFAULT 1 CHECK (sequence_number >= 1);

ALTER TABLE voice.call_transcripts
  ADD COLUMN IF NOT EXISTS text TEXT NOT NULL DEFAULT '';

ALTER TABLE voice.call_transcripts
  ADD COLUMN IF NOT EXISTS is_final BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE voice.call_transcripts
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE voice.call_transcripts
SET
  sequence_number = CASE WHEN segment_index >= 1 THEN segment_index ELSE 1 END,
  text = content
WHERE text = '';

CREATE INDEX IF NOT EXISTS idx_call_transcripts_created_at
  ON voice.call_transcripts (created_at DESC);

COMMIT;
