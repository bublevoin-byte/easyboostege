ALTER TABLE speaking_attempts
  ADD COLUMN IF NOT EXISTS source_session_id UUID,
  ADD COLUMN IF NOT EXISTS source_task_ref VARCHAR(140),
  ADD COLUMN IF NOT EXISTS source_task_revision INTEGER,
  ADD COLUMN IF NOT EXISTS source_catalog_id VARCHAR(80),
  ADD COLUMN IF NOT EXISTS source_catalog_revision INTEGER,
  ADD COLUMN IF NOT EXISTS assistance_used BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS assistance_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accent_locale VARCHAR(5),
  ADD COLUMN IF NOT EXISTS targeted_practice JSONB;

UPDATE speaking_attempts attempt SET accent_locale = session.accent_locale
FROM speaking_task1_sessions session
WHERE attempt.task_type = 1 AND attempt.source_session_id = session.id AND attempt.username = session.username;
UPDATE speaking_attempts attempt SET accent_locale = session.accent_locale
FROM speaking_task2_sessions session
WHERE attempt.task_type = 2 AND attempt.source_session_id = session.id AND attempt.username = session.username;
UPDATE speaking_attempts attempt SET accent_locale = session.accent_locale
FROM speaking_task3_sessions session
WHERE attempt.task_type = 3 AND attempt.source_session_id = session.id AND attempt.username = session.username;
UPDATE speaking_attempts attempt SET accent_locale = session.accent_locale
FROM speaking_task4_sessions session
WHERE attempt.task_type = 4 AND attempt.source_session_id = session.id AND attempt.username = session.username;

ALTER TABLE speaking_attempts
  DROP CONSTRAINT IF EXISTS speaking_attempts_accent_locale_check;
ALTER TABLE speaking_attempts
  ADD CONSTRAINT speaking_attempts_accent_locale_check
  CHECK (accent_locale IS NULL OR accent_locale IN ('en-GB', 'en-US'));

ALTER TABLE speaking_attempts
  DROP CONSTRAINT IF EXISTS speaking_attempts_source_contract_check;

ALTER TABLE speaking_attempts
  ADD CONSTRAINT speaking_attempts_source_contract_check CHECK (
    (source_session_id IS NULL AND source_task_ref IS NULL AND source_task_revision IS NULL
      AND source_catalog_id IS NULL AND source_catalog_revision IS NULL AND targeted_practice IS NULL)
    OR
    (source_session_id IS NOT NULL AND source_task_ref IS NOT NULL AND source_task_revision > 0
      AND source_catalog_id IS NOT NULL AND source_catalog_revision > 0
      AND (targeted_practice IS NULL OR jsonb_typeof(targeted_practice) = 'object'))
  );

CREATE INDEX IF NOT EXISTS speaking_attempts_owner_source_idx
  ON speaking_attempts (username, source_session_id, created_at DESC)
  WHERE source_session_id IS NOT NULL;

ALTER TABLE speaking_task1_sessions ADD COLUMN IF NOT EXISTS assistance_used BOOLEAN;
ALTER TABLE speaking_task2_sessions ADD COLUMN IF NOT EXISTS assistance_used BOOLEAN;
ALTER TABLE speaking_task3_sessions ADD COLUMN IF NOT EXISTS assistance_used BOOLEAN;
ALTER TABLE speaking_task4_sessions ADD COLUMN IF NOT EXISTS assistance_used BOOLEAN;
ALTER TABLE speaking_task1_sessions ADD COLUMN IF NOT EXISTS targeted_practice JSONB;
ALTER TABLE speaking_task2_sessions ADD COLUMN IF NOT EXISTS targeted_practice JSONB;
ALTER TABLE speaking_task3_sessions ADD COLUMN IF NOT EXISTS targeted_practice JSONB;
ALTER TABLE speaking_task4_sessions ADD COLUMN IF NOT EXISTS targeted_practice JSONB;

ALTER TABLE speaking_task1_sessions
  DROP CONSTRAINT IF EXISTS speaking_task1_sessions_targeted_practice_check;
ALTER TABLE speaking_task2_sessions
  DROP CONSTRAINT IF EXISTS speaking_task2_sessions_targeted_practice_check;
ALTER TABLE speaking_task3_sessions
  DROP CONSTRAINT IF EXISTS speaking_task3_sessions_targeted_practice_check;
ALTER TABLE speaking_task4_sessions
  DROP CONSTRAINT IF EXISTS speaking_task4_sessions_targeted_practice_check;
ALTER TABLE speaking_task1_sessions
  ADD CONSTRAINT speaking_task1_sessions_targeted_practice_check
  CHECK (targeted_practice IS NULL OR jsonb_typeof(targeted_practice) = 'object');
ALTER TABLE speaking_task2_sessions
  ADD CONSTRAINT speaking_task2_sessions_targeted_practice_check
  CHECK (targeted_practice IS NULL OR jsonb_typeof(targeted_practice) = 'object');
ALTER TABLE speaking_task3_sessions
  ADD CONSTRAINT speaking_task3_sessions_targeted_practice_check
  CHECK (targeted_practice IS NULL OR jsonb_typeof(targeted_practice) = 'object');
ALTER TABLE speaking_task4_sessions
  ADD CONSTRAINT speaking_task4_sessions_targeted_practice_check
  CHECK (targeted_practice IS NULL OR jsonb_typeof(targeted_practice) = 'object');

ALTER TABLE speaking_task1_sessions ALTER COLUMN selection_reason TYPE VARCHAR(24);
ALTER TABLE speaking_task2_sessions ALTER COLUMN selection_reason TYPE VARCHAR(24);
ALTER TABLE speaking_task3_sessions ALTER COLUMN selection_reason TYPE VARCHAR(24);
ALTER TABLE speaking_task4_sessions ALTER COLUMN selection_reason TYPE VARCHAR(24);
ALTER TABLE speaking_task1_sessions DROP CONSTRAINT IF EXISTS speaking_task1_sessions_selection_reason_check;
ALTER TABLE speaking_task2_sessions DROP CONSTRAINT IF EXISTS speaking_task2_sessions_selection_reason_check;
ALTER TABLE speaking_task3_sessions DROP CONSTRAINT IF EXISTS speaking_task3_sessions_selection_reason_check;
ALTER TABLE speaking_task4_sessions DROP CONSTRAINT IF EXISTS speaking_task4_sessions_selection_reason_check;
ALTER TABLE speaking_task1_sessions ADD CONSTRAINT speaking_task1_sessions_selection_reason_check
  CHECK (selection_reason IN ('unseen', 'due', 'weak', 'old', 'targeted_focus'));
ALTER TABLE speaking_task2_sessions ADD CONSTRAINT speaking_task2_sessions_selection_reason_check
  CHECK (selection_reason IN ('unseen', 'due', 'weak', 'old', 'targeted_focus'));
ALTER TABLE speaking_task3_sessions ADD CONSTRAINT speaking_task3_sessions_selection_reason_check
  CHECK (selection_reason IN ('unseen', 'due', 'weak', 'old', 'targeted_focus'));
ALTER TABLE speaking_task4_sessions ADD CONSTRAINT speaking_task4_sessions_selection_reason_check
  CHECK (selection_reason IN ('unseen', 'due', 'weak', 'old', 'targeted_focus'));

UPDATE speaking_task1_sessions SET assistance_used = TRUE WHERE assistance_used IS NULL;
UPDATE speaking_task2_sessions SET assistance_used = TRUE WHERE assistance_used IS NULL;
UPDATE speaking_task3_sessions SET assistance_used = TRUE WHERE assistance_used IS NULL;
UPDATE speaking_task4_sessions SET assistance_used = TRUE WHERE assistance_used IS NULL;

ALTER TABLE speaking_task1_sessions ALTER COLUMN assistance_used SET DEFAULT FALSE;
ALTER TABLE speaking_task2_sessions ALTER COLUMN assistance_used SET DEFAULT FALSE;
ALTER TABLE speaking_task3_sessions ALTER COLUMN assistance_used SET DEFAULT FALSE;
ALTER TABLE speaking_task4_sessions ALTER COLUMN assistance_used SET DEFAULT FALSE;
ALTER TABLE speaking_task1_sessions ALTER COLUMN assistance_used SET NOT NULL;
ALTER TABLE speaking_task2_sessions ALTER COLUMN assistance_used SET NOT NULL;
ALTER TABLE speaking_task3_sessions ALTER COLUMN assistance_used SET NOT NULL;
ALTER TABLE speaking_task4_sessions ALTER COLUMN assistance_used SET NOT NULL;
