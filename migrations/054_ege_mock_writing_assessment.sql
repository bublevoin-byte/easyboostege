ALTER TABLE ege_mock_attempts
  ADD COLUMN IF NOT EXISTS writing_assessment JSONB;

ALTER TABLE ai_requests
  ADD COLUMN IF NOT EXISTS context_fingerprint TEXT;

ALTER TABLE ege_mock_mutations
  DROP CONSTRAINT IF EXISTS ege_mock_mutations_operation_check;

ALTER TABLE ege_mock_mutations
  ADD CONSTRAINT ege_mock_mutations_operation_check CHECK (operation IN (
    'start', 'draft', 'written_submit', 'oral_start', 'oral_submit',
    'assessment_retry', 'assessment_run'
  ));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_requests_context_fingerprint_check'
  ) THEN
    ALTER TABLE ai_requests
      ADD CONSTRAINT ai_requests_context_fingerprint_check CHECK (
        context_fingerprint IS NULL OR context_fingerprint ~ '^sha256:[a-f0-9]{64}$'
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ege_mock_writing_assessment_shape_check'
  ) THEN
    ALTER TABLE ege_mock_attempts
      ADD CONSTRAINT ege_mock_writing_assessment_shape_check CHECK (
        writing_assessment IS NULL OR (
          jsonb_typeof(writing_assessment) = 'object'
          AND writing_assessment->>'version' = 'ege-mock-writing-assessment-v1'
          AND writing_assessment->>'score_kind' = 'provisional'
          AND writing_assessment->>'status' IN ('pending', 'in_progress', 'retryable', 'ambiguous', 'completed')
          AND jsonb_typeof(writing_assessment->'assessment_revision') = 'number'
          AND writing_assessment->>'assessment_revision' ~ '^(0|[1-9][0-9]{0,15})$'
          AND (writing_assessment->>'assessment_revision')::numeric <= 9007199254740991
          AND octet_length(writing_assessment::text) <= 300000
        )
      );
  END IF;
END $$;
