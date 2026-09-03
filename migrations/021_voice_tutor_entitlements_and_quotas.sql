CREATE TABLE IF NOT EXISTS subscription_entitlements (
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  entitlement VARCHAR(64) NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (username, entitlement),
  CONSTRAINT subscription_entitlement_name CHECK (entitlement ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT subscription_entitlement_period CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS voice_tutor_sessions (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  idempotency_key VARCHAR(100) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('active', 'completed', 'expired')),
  reserved_seconds INTEGER NOT NULL CHECK (reserved_seconds BETWEEN 1 AND 86400),
  billable_seconds INTEGER CHECK (billable_seconds BETWEEN 0 AND reserved_seconds),
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  UNIQUE (username, idempotency_key),
  CONSTRAINT voice_tutor_session_period CHECK (expires_at > started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_tutor_one_active_session_per_user
  ON voice_tutor_sessions (username)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS voice_tutor_sessions_usage
  ON voice_tutor_sessions (username, started_at);
