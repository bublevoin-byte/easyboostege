CREATE TABLE IF NOT EXISTS module_attempts (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  module VARCHAR(30) NOT NULL CHECK (module IN ('grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking', 'exam')),
  activity VARCHAR(80) NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0),
  max_score INTEGER NOT NULL CHECK (max_score > 0 AND score <= max_score),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 14400000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS module_attempts_user_module_idx
  ON module_attempts (username, module, created_at DESC);
