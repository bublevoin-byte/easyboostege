CREATE TABLE IF NOT EXISTS generated_tasks (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  operation VARCHAR(60) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  request JSONB NOT NULL,
  result JSONB NOT NULL,
  provider VARCHAR(40) NOT NULL,
  prompt_version VARCHAR(40) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (username, request_hash)
);

CREATE INDEX IF NOT EXISTS generated_tasks_user_operation_idx
  ON generated_tasks (username, operation, created_at DESC);
