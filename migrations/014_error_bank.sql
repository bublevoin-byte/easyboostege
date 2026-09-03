CREATE TABLE IF NOT EXISTS error_bank (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  module VARCHAR(30) NOT NULL CHECK (module IN ('grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking', 'exam')),
  item_key VARCHAR(160) NOT NULL,
  error_type VARCHAR(60) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (username, module, item_key, error_type)
);

CREATE INDEX IF NOT EXISTS error_bank_user_active_idx
  ON error_bank (username, last_seen_at DESC) WHERE resolved_at IS NULL;
