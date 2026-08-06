ALTER TABLE speaking_pronunciation_assessments
  ADD COLUMN IF NOT EXISTS context_id VARCHAR(300);

ALTER TABLE speaking_pronunciation_assessments
  DROP CONSTRAINT IF EXISTS speaking_pronunciation_assessments_context_id_check;

ALTER TABLE speaking_pronunciation_assessments
  ADD CONSTRAINT speaking_pronunciation_assessments_context_id_check
  CHECK (
    context_id IS NULL
    OR (
      char_length(context_id) BETWEEN 1 AND 300
      AND context_id ~ '^[a-zA-Z0-9:@._-]+$'
    )
  );
