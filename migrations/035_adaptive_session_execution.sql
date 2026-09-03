ALTER TABLE adaptive_learning_sessions
  ALTER COLUMN current_block_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS execution_revision INTEGER NOT NULL DEFAULT 0 CHECK (execution_revision >= 0),
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completion_summary JSONB;

ALTER TABLE adaptive_learning_sessions
  ADD CONSTRAINT adaptive_learning_sessions_completed_position_check
  CHECK (status <> 'completed' OR current_block_id IS NULL);

CREATE TABLE IF NOT EXISTS adaptive_learning_execution_claims (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES adaptive_learning_sessions(id) ON DELETE CASCADE,
  block_id VARCHAR(40) NOT NULL,
  session_execution_revision INTEGER NOT NULL CHECK (session_execution_revision > 0),
  token_hash CHAR(64) NOT NULL UNIQUE,
  launch_fingerprint CHAR(64) NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  attempt_type VARCHAR(20) CHECK (attempt_type IN ('module', 'writing', 'speaking')),
  attempt_ref VARCHAR(100),
  CHECK (expires_at > issued_at),
  CHECK (NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL)),
  CHECK ((attempt_type IS NULL) = (attempt_ref IS NULL)),
  CHECK ((consumed_at IS NULL) = (attempt_type IS NULL))
);

CREATE INDEX IF NOT EXISTS adaptive_learning_execution_claims_owner_session_idx
  ON adaptive_learning_execution_claims (username, session_id, expires_at);

CREATE TABLE IF NOT EXISTS adaptive_learning_session_events (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES adaptive_learning_sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type VARCHAR(30) NOT NULL CHECK (event_type IN ('block_completed', 'session_finished')),
  block_id VARCHAR(40),
  block_kind VARCHAR(20),
  module VARCHAR(100),
  skill_id VARCHAR(100),
  activity_id VARCHAR(100),
  source_type VARCHAR(20) CHECK (source_type IN ('module', 'writing', 'speaking')),
  source_ref VARCHAR(100),
  evidence_quality VARCHAR(40),
  planned_minutes SMALLINT NOT NULL DEFAULT 0 CHECK (planned_minutes >= 0),
  actual_minutes SMALLINT CHECK (actual_minutes >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (event_type = 'block_completed' AND block_id IS NOT NULL AND block_kind IN ('learning', 'break'))
    OR (event_type = 'session_finished' AND block_id IS NULL AND block_kind IS NULL
      AND module IS NULL AND skill_id IS NULL AND activity_id IS NULL
      AND source_type IS NULL AND source_ref IS NULL AND evidence_quality IS NULL
      AND planned_minutes = 0 AND actual_minutes IS NULL)
  ),
  CHECK (
    block_kind IS DISTINCT FROM 'learning'
    OR (module IS NOT NULL AND skill_id IS NOT NULL AND activity_id IS NOT NULL
      AND source_type IS NOT NULL AND source_ref IS NOT NULL AND evidence_quality IS NOT NULL)
  ),
  CHECK (
    block_kind IS DISTINCT FROM 'break'
    OR (module IS NULL AND skill_id IS NULL AND activity_id IS NULL
      AND source_type IS NULL AND source_ref IS NULL AND evidence_quality IS NULL
      AND actual_minutes IS NULL)
  ),
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, block_id)
);

CREATE INDEX IF NOT EXISTS adaptive_learning_session_events_owner_created_idx
  ON adaptive_learning_session_events (username, created_at);

CREATE TABLE IF NOT EXISTS adaptive_learning_session_mutations (
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  idempotency_key VARCHAR(120) NOT NULL,
  operation VARCHAR(20) NOT NULL CHECK (operation IN ('start', 'advance', 'finish')),
  session_id UUID NOT NULL REFERENCES adaptive_learning_sessions(id) ON DELETE CASCADE,
  request_hash CHAR(64) NOT NULL,
  response_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (username, idempotency_key)
);
