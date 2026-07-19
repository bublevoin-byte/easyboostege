ALTER TABLE writing_attempts
  ADD COLUMN IF NOT EXISTS error_code VARCHAR(80);

