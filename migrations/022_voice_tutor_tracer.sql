ALTER TABLE voice_tutor_sessions
  ADD COLUMN IF NOT EXISTS capsule_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS capsule JSONB,
  ADD COLUMN IF NOT EXISTS nonce_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS delivery_mode VARCHAR(16),
  ADD COLUMN IF NOT EXISTS pedagogical_state VARCHAR(20),
  ADD COLUMN IF NOT EXISTS micro_check_passed BOOLEAN,
  ADD COLUMN IF NOT EXISTS transfer_passed BOOLEAN,
  ADD COLUMN IF NOT EXISTS outcome VARCHAR(20),
  ADD COLUMN IF NOT EXISTS error_code VARCHAR(80),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE voice_tutor_sessions DROP CONSTRAINT IF EXISTS voice_tutor_delivery_mode;
ALTER TABLE voice_tutor_sessions ADD CONSTRAINT voice_tutor_delivery_mode
  CHECK (delivery_mode IS NULL OR delivery_mode IN ('voice', 'text', 'local'));

ALTER TABLE voice_tutor_sessions DROP CONSTRAINT IF EXISTS voice_tutor_pedagogical_state;
ALTER TABLE voice_tutor_sessions ADD CONSTRAINT voice_tutor_pedagogical_state
  CHECK (pedagogical_state IS NULL OR pedagogical_state IN ('diagnose', 'explain', 'micro_check', 'transfer_task', 'resolved', 'fallback', 'ended'));
