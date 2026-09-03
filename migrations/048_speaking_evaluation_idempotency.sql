ALTER TABLE speaking_attempts
  ADD COLUMN IF NOT EXISTS evaluation_fingerprint CHAR(64);

ALTER TABLE speaking_attempts
  ADD COLUMN IF NOT EXISTS evaluation_claimed_at TIMESTAMPTZ;

ALTER TABLE speaking_attempts
  ADD COLUMN IF NOT EXISTS evaluation_claim_generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE speaking_attempts
  DROP CONSTRAINT IF EXISTS speaking_attempts_evaluation_claim_generation_check;

ALTER TABLE speaking_attempts
  ADD CONSTRAINT speaking_attempts_evaluation_claim_generation_check
  CHECK (evaluation_claim_generation >= 0);

ALTER TABLE speaking_attempts
  DROP CONSTRAINT IF EXISTS speaking_attempts_evaluation_fingerprint_check;

ALTER TABLE speaking_attempts
  ADD CONSTRAINT speaking_attempts_evaluation_fingerprint_check
  CHECK (
    evaluation_fingerprint IS NULL
    OR evaluation_fingerprint ~ '^[a-f0-9]{64}$'
  );

CREATE UNIQUE INDEX IF NOT EXISTS speaking_attempts_owner_evaluation_fingerprint_uidx
  ON speaking_attempts (username, evaluation_fingerprint)
  WHERE evaluation_fingerprint IS NOT NULL;
