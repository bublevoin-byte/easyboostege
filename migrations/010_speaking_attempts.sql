CREATE TABLE IF NOT EXISTS speaking_attempts (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  task_type SMALLINT NOT NULL CHECK (task_type BETWEEN 1 AND 4),
  assignment JSONB NOT NULL,
  transcript TEXT NOT NULL,
  review JSONB,
  provider VARCHAR(40),
  prompt_version VARCHAR(40) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  error_code VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evaluated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS speaking_attempts_user_created_idx
  ON speaking_attempts (username, created_at DESC);
CREATE INDEX IF NOT EXISTS speaking_attempts_user_type_idx
  ON speaking_attempts (username, task_type, created_at DESC);
