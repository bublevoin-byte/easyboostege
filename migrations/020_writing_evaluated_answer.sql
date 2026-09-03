ALTER TABLE writing_attempts
  ADD COLUMN IF NOT EXISTS evaluated_answer TEXT;

UPDATE writing_attempts
SET evaluated_answer = answer
WHERE evaluated_answer IS NULL;

ALTER TABLE writing_attempts
  ALTER COLUMN evaluated_answer SET NOT NULL;
