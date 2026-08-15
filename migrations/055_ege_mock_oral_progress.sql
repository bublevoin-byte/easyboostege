ALTER TABLE ege_mock_attempts
  ADD COLUMN IF NOT EXISTS oral_progress JSONB;

ALTER TABLE ege_mock_attempts
  ADD COLUMN IF NOT EXISTS speaking_assessment JSONB;

ALTER TABLE ege_mock_mutations
  DROP CONSTRAINT IF EXISTS ege_mock_mutations_operation_check;

ALTER TABLE ege_mock_mutations
  ADD CONSTRAINT ege_mock_mutations_operation_check CHECK (operation IN (
    'start', 'draft', 'written_submit', 'oral_start', 'oral_stage', 'oral_submit',
    'assessment_retry', 'assessment_run'
  ));

ALTER TABLE speaking_full_sessions
  DROP CONSTRAINT IF EXISTS speaking_full_sessions_selection_reason_check;

ALTER TABLE speaking_full_sessions
  ADD CONSTRAINT speaking_full_sessions_selection_reason_check CHECK (
    selection_reason IN ('unseen', 'old', 'ege_mock')
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ege_mock_oral_progress_shape_check'
  ) THEN
    ALTER TABLE ege_mock_attempts
      ADD CONSTRAINT ege_mock_oral_progress_shape_check CHECK (
        oral_progress IS NULL OR (
          jsonb_typeof(oral_progress) = 'object'
          AND oral_progress->>'schemaVersion' = 'ege-mock-oral-progress-v1'
          AND oral_progress->>'phase' IN ('ready', 'preparing', 'recording', 'ready_to_submit')
          AND jsonb_typeof(oral_progress->'recordings') = 'object'
          AND octet_length(oral_progress::text) <= 100000
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ege_mock_speaking_assessment_shape_check'
  ) THEN
    ALTER TABLE ege_mock_attempts
      ADD CONSTRAINT ege_mock_speaking_assessment_shape_check CHECK (
        speaking_assessment IS NULL OR (
          jsonb_typeof(speaking_assessment) = 'object'
          AND speaking_assessment->>'version' = 'ege-mock-speaking-assessment-v1'
          AND speaking_assessment->>'status' IN ('pending', 'in_progress', 'retryable', 'completed')
          AND jsonb_typeof(speaking_assessment->'items') = 'object'
          AND octet_length(speaking_assessment::text) <= 100000
        )
      );
  END IF;
END $$;
