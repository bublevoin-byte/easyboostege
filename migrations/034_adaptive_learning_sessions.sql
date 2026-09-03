CREATE TABLE IF NOT EXISTS adaptive_learning_sessions (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  session_version VARCHAR(40) NOT NULL CHECK (session_version = 'adaptive-session-v1'),
  revision INTEGER NOT NULL CHECK (revision IN (1, 2)),
  plan_id UUID NOT NULL REFERENCES adaptive_learning_plan_revisions(id) ON DELETE CASCADE,
  plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
  preview_fingerprint CHAR(64) NOT NULL,
  composer_policy_version VARCHAR(40) NOT NULL CHECK (composer_policy_version = 'adaptive-composer-v1'),
  content_registry_version VARCHAR(40) NOT NULL CHECK (content_registry_version = 'adaptive-content-v1'),
  taxonomy_version VARCHAR(40) NOT NULL,
  week_start TIMESTAMPTZ NOT NULL,
  duration_minutes SMALLINT NOT NULL CHECK (duration_minutes BETWEEN 15 AND 120 AND duration_minutes % 5 = 0),
  learning_minutes SMALLINT NOT NULL CHECK (learning_minutes > 0),
  break_minutes SMALLINT NOT NULL CHECK (break_minutes IN (0, 10)),
  weekly_budget_snapshot JSONB NOT NULL,
  blocks JSONB NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('created', 'in_progress', 'completed', 'abandoned')),
  current_block_id VARCHAR(40) NOT NULL,
  completed_learning_minutes SMALLINT NOT NULL DEFAULT 0 CHECK (
    completed_learning_minutes BETWEEN 0 AND learning_minutes
  ),
  replacement JSONB,
  create_idempotency_key VARCHAR(120) NOT NULL,
  create_request_hash CHAR(64) NOT NULL,
  created_response_snapshot JSONB NOT NULL,
  replacement_idempotency_key VARCHAR(120),
  replacement_request_hash CHAR(64),
  replacement_response_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (duration_minutes = learning_minutes + break_minutes),
  CHECK ((duration_minutes > 60 AND break_minutes = 10) OR (duration_minutes <= 60 AND break_minutes = 0)),
  CHECK ((revision = 1 AND replacement IS NULL) OR (revision = 2 AND replacement IS NOT NULL)),
  CHECK (
    (replacement_idempotency_key IS NULL AND replacement_request_hash IS NULL AND replacement_response_snapshot IS NULL)
    OR
    (replacement_idempotency_key IS NOT NULL AND replacement_request_hash IS NOT NULL AND replacement_response_snapshot IS NOT NULL)
  ),
  UNIQUE (username, create_idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS adaptive_learning_sessions_replacement_key_idx
  ON adaptive_learning_sessions (username, replacement_idempotency_key)
  WHERE replacement_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS adaptive_learning_sessions_current_owner_idx
  ON adaptive_learning_sessions (username)
  WHERE status IN ('created', 'in_progress');

CREATE INDEX IF NOT EXISTS adaptive_learning_sessions_owner_week_idx
  ON adaptive_learning_sessions (username, week_start, created_at);
