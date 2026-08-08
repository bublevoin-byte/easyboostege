ALTER TABLE adaptive_learning_plan_revisions
  ADD COLUMN IF NOT EXISTS profile_evidence_fingerprint CHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'adaptive_learning_plan_revisions_evidence_fingerprint_check'
      AND conrelid = 'adaptive_learning_plan_revisions'::regclass
  ) THEN
    ALTER TABLE adaptive_learning_plan_revisions
      ADD CONSTRAINT adaptive_learning_plan_revisions_evidence_fingerprint_check
      CHECK (
        profile_evidence_fingerprint IS NULL
        OR profile_evidence_fingerprint ~ '^[0-9a-f]{64}$'
      );
  END IF;
END $$;
