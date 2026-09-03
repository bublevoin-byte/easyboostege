ALTER TABLE adaptive_learning_profiles
  ADD COLUMN IF NOT EXISTS evidence_fingerprint CHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'adaptive_learning_profiles_evidence_fingerprint_check'
      AND conrelid = 'adaptive_learning_profiles'::regclass
  ) THEN
    ALTER TABLE adaptive_learning_profiles
      ADD CONSTRAINT adaptive_learning_profiles_evidence_fingerprint_check
      CHECK (evidence_fingerprint IS NULL OR evidence_fingerprint ~ '^[0-9a-f]{64}$');
  END IF;
END $$;
