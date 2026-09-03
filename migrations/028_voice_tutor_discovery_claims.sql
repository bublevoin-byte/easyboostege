ALTER TABLE voice_tutor_sessions
  ADD COLUMN IF NOT EXISTS discovery_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS discovery_claim_id UUID,
  ADD COLUMN IF NOT EXISTS discovery_error_code VARCHAR(80);

ALTER TABLE voice_tutor_sessions DROP CONSTRAINT IF EXISTS voice_tutor_discovery_status;
ALTER TABLE voice_tutor_sessions ADD CONSTRAINT voice_tutor_discovery_status CHECK (
  discovery_status IS NULL OR discovery_status IN ('in_progress', 'failed', 'completed')
);

-- Ticket 09 originally hashed the complete transient capsule. Remove those
-- learner-answer-derived fingerprints; canonical content is rebuilt by pointer.
UPDATE voice_tutor_sessions
SET capsule = capsule - 'content_hash'
WHERE capsule ? 'content_hash';

ALTER TABLE ai_requests
  ADD COLUMN IF NOT EXISTS claim_key UUID,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS ai_requests_claim_key_unique
  ON ai_requests (claim_key)
  WHERE claim_key IS NOT NULL;
