ALTER TABLE writing_attempts
  ADD COLUMN IF NOT EXISTS idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64),
  ADD COLUMN IF NOT EXISTS response_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS provider_result_ambiguous_at TIMESTAMPTZ;

ALTER TABLE writing_attempts
  DROP CONSTRAINT IF EXISTS writing_attempts_idempotency_pair_check;

ALTER TABLE writing_attempts
  ADD CONSTRAINT writing_attempts_idempotency_pair_check CHECK (
    (idempotency_key IS NULL AND request_fingerprint IS NULL)
    OR (idempotency_key IS NOT NULL AND request_fingerprint IS NOT NULL
      AND request_fingerprint ~ '^[a-f0-9]{64}$')
  );

CREATE UNIQUE INDEX IF NOT EXISTS writing_attempts_owner_idempotency_idx
  ON writing_attempts (username, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP INDEX IF EXISTS writing_attempts_owner_active_fingerprint_idx;

CREATE UNIQUE INDEX writing_attempts_owner_pending_fingerprint_idx
  ON writing_attempts (username, request_fingerprint)
  WHERE idempotency_key IS NOT NULL AND status = 'pending';

CREATE UNIQUE INDEX writing_attempts_owner_completed_fingerprint_idx
  ON writing_attempts (username, request_fingerprint, prompt_version)
  WHERE idempotency_key IS NOT NULL AND status = 'completed';
