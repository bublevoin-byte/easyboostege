CREATE TABLE IF NOT EXISTS progress_summary (
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  module VARCHAR(30) NOT NULL CHECK (module IN ('grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking', 'exam')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  best_score INTEGER NOT NULL DEFAULT 0 CHECK (best_score >= 0),
  best_max_score INTEGER NOT NULL DEFAULT 1 CHECK (best_max_score > 0),
  total_duration_ms BIGINT NOT NULL DEFAULT 0 CHECK (total_duration_ms >= 0),
  last_attempt_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (username, module)
);

CREATE INDEX IF NOT EXISTS progress_summary_updated_idx
  ON progress_summary (username, updated_at DESC);

WITH totals AS (
  SELECT username, module, COUNT(*)::integer AS attempt_count,
         COALESCE(SUM(duration_ms), 0)::bigint AS total_duration_ms,
         MAX(created_at) AS last_attempt_at
  FROM module_attempts
  GROUP BY username, module
),
best AS (
  SELECT DISTINCT ON (username, module)
         username, module, score AS best_score, max_score AS best_max_score
  FROM module_attempts
  ORDER BY username, module, score::numeric / max_score DESC, created_at DESC
)
INSERT INTO progress_summary
  (username, module, attempt_count, best_score, best_max_score, total_duration_ms, last_attempt_at)
SELECT totals.username, totals.module, totals.attempt_count, best.best_score,
       best.best_max_score, totals.total_duration_ms, totals.last_attempt_at
FROM totals
JOIN best USING (username, module)
ON CONFLICT (username, module) DO UPDATE SET
  attempt_count = EXCLUDED.attempt_count,
  best_score = EXCLUDED.best_score,
  best_max_score = EXCLUDED.best_max_score,
  total_duration_ms = EXCLUDED.total_duration_ms,
  last_attempt_at = EXCLUDED.last_attempt_at,
  updated_at = NOW();
