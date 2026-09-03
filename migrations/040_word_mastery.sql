ALTER TABLE word_progress
  ADD COLUMN IF NOT EXISTS mastery_version SMALLINT NOT NULL DEFAULT 0
    CHECK (mastery_version BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS dimensions JSONB,
  ADD COLUMN IF NOT EXISTS last_mode VARCHAR(40),
  ADD COLUMN IF NOT EXISTS last_outcome VARCHAR(24);

ALTER TABLE word_progress
  DROP CONSTRAINT IF EXISTS word_progress_mastery_shape_check;

ALTER TABLE word_progress
  DROP CONSTRAINT IF EXISTS word_progress_last_mode_check,
  DROP CONSTRAINT IF EXISTS word_progress_last_outcome_check;

ALTER TABLE word_progress
  ADD CONSTRAINT word_progress_mastery_shape_check CHECK (
    (mastery_version = 0 AND dimensions IS NULL)
    OR (mastery_version = 1 AND jsonb_typeof(dimensions) = 'object')
  ),
  ADD CONSTRAINT word_progress_last_mode_check CHECK (
    last_mode IS NULL OR last_mode IN (
      'receptive_meaning', 'russian_reveal', 'english_production',
      'contextual_production', 'listening'
    )
  ),
  ADD CONSTRAINT word_progress_last_outcome_check CHECK (
    last_outcome IS NULL OR last_outcome IN ('correct', 'knew', 'almost', 'incorrect', 'not_known')
  );

CREATE TEMPORARY TABLE word_progress_legacy_normalized ON COMMIT DROP AS
SELECT username,
       LOWER(REGEXP_REPLACE(REGEXP_REPLACE(BTRIM(word), '\s+', ' ', 'g'), '^to\s+', '', 'i')) AS word,
       MAX(stage) AS stage,
       MAX(error_count) AS error_count,
       MAX(review_count) AS review_count,
       MIN(due_at) FILTER (WHERE due_at IS NOT NULL) AS due_at,
       MAX(updated_at) AS updated_at
FROM word_progress
WHERE mastery_version = 0
GROUP BY 1, 2;

DELETE FROM word_progress WHERE mastery_version = 0;

INSERT INTO word_progress (username, word, stage, error_count, review_count, due_at, updated_at)
SELECT username, word, stage, error_count, review_count, due_at, updated_at
FROM word_progress_legacy_normalized;

UPDATE word_progress
SET mastery_version = 1,
    dimensions = jsonb_build_object(
      'meaning', jsonb_build_object(
        'score', (ARRAY[0, 15, 30, 45, 60, 70])[stage + 1],
        'attempts', review_count + error_count,
        'independentSuccesses', 0,
        'evidence', CASE WHEN stage > 0 OR review_count + error_count > 0 THEN 'preliminary' ELSE 'none' END,
        'lastPracticedAt', NULL
      ),
      'spelling', jsonb_build_object(
        'score', (ARRAY[0, 15, 30, 45, 60, 70])[stage + 1],
        'attempts', 0,
        'independentSuccesses', 0,
        'evidence', CASE WHEN stage > 0 THEN 'preliminary' ELSE 'none' END,
        'lastPracticedAt', NULL
      ),
      'context', jsonb_build_object(
        'score', (ARRAY[0, 15, 30, 45, 60, 70])[stage + 1],
        'attempts', 0,
        'independentSuccesses', 0,
        'evidence', CASE WHEN stage > 0 THEN 'preliminary' ELSE 'none' END,
        'lastPracticedAt', NULL
      ),
      'listening', jsonb_build_object(
        'score', (ARRAY[0, 15, 30, 45, 60, 70])[stage + 1],
        'attempts', 0,
        'independentSuccesses', 0,
        'evidence', CASE WHEN stage > 0 THEN 'preliminary' ELSE 'none' END,
        'lastPracticedAt', NULL
      )
    )
WHERE mastery_version = 0;
