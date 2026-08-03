CREATE TABLE IF NOT EXISTS adaptive_diagnostic_sessions (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  catalog_version VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('in_progress', 'ready', 'completed', 'expired')),
  current_item_id VARCHAR(100),
  answered_items SMALLINT NOT NULL DEFAULT 0 CHECK (answered_items BETWEEN 0 AND 12),
  correct_items SMALLINT NOT NULL DEFAULT 0 CHECK (correct_items BETWEEN 0 AND answered_items),
  stop_reason VARCHAR(40),
  idempotency_key VARCHAR(120) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  completion_idempotency_key VARCHAR(120),
  completion_request_hash CHAR(64),
  completion_response_snapshot JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (status <> 'completed' AND completion_idempotency_key IS NULL AND completion_request_hash IS NULL AND completion_response_snapshot IS NULL)
    OR
    (status = 'completed' AND completion_idempotency_key IS NOT NULL AND completion_request_hash IS NOT NULL AND completion_response_snapshot IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS adaptive_diagnostic_active_owner_idx
  ON adaptive_diagnostic_sessions (username)
  WHERE status IN ('in_progress', 'ready');

CREATE TABLE IF NOT EXISTS adaptive_diagnostic_start_claims (
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  idempotency_key VARCHAR(120) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  diagnostic_id UUID NOT NULL REFERENCES adaptive_diagnostic_sessions(id) ON DELETE CASCADE,
  catalog_version VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('in_progress', 'ready', 'completed', 'expired')),
  current_item_id VARCHAR(100),
  answered_items SMALLINT NOT NULL CHECK (answered_items BETWEEN 0 AND 12),
  correct_items SMALLINT NOT NULL CHECK (correct_items BETWEEN 0 AND answered_items),
  stop_reason VARCHAR(40),
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL,
  claim_expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (username, idempotency_key)
);

CREATE INDEX IF NOT EXISTS adaptive_diagnostic_start_claim_expiry_idx
  ON adaptive_diagnostic_start_claims (claim_expires_at);

CREATE TABLE IF NOT EXISTS adaptive_diagnostic_responses (
  id UUID PRIMARY KEY,
  diagnostic_id UUID NOT NULL REFERENCES adaptive_diagnostic_sessions(id) ON DELETE CASCADE,
  item_id VARCHAR(100) NOT NULL,
  skill_id VARCHAR(120) NOT NULL,
  module VARCHAR(24) NOT NULL CHECK (module IN ('grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking')),
  evidence_quality VARCHAR(20) NOT NULL CHECK (evidence_quality IN ('independent', 'assisted')),
  choice_id VARCHAR(20) NOT NULL,
  correct BOOLEAN NOT NULL,
  response_ms INTEGER CHECK (response_ms BETWEEN 0 AND 300000),
  idempotency_key VARCHAR(120) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  replay_catalog_version VARCHAR(40) NOT NULL,
  replay_status VARCHAR(20) NOT NULL CHECK (replay_status IN ('in_progress', 'ready', 'completed', 'expired')),
  replay_current_item_id VARCHAR(100),
  replay_answered_items SMALLINT NOT NULL CHECK (replay_answered_items BETWEEN 0 AND 12),
  replay_correct_items SMALLINT NOT NULL CHECK (replay_correct_items BETWEEN 0 AND replay_answered_items),
  replay_stop_reason VARCHAR(40),
  replay_started_at TIMESTAMPTZ NOT NULL,
  replay_expires_at TIMESTAMPTZ NOT NULL,
  replay_completed_at TIMESTAMPTZ,
  replay_updated_at TIMESTAMPTZ NOT NULL,
  answered_at TIMESTAMPTZ NOT NULL,
  UNIQUE (diagnostic_id, item_id),
  UNIQUE (diagnostic_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS adaptive_diagnostic_response_skill_idx
  ON adaptive_diagnostic_responses (skill_id, answered_at);
