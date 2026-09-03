CREATE TABLE IF NOT EXISTS telegram_auth_codes (
  code_hash CHAR(64) PRIMARY KEY,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready')),
  telegram_id BIGINT,
  display_name VARCHAR(160),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  CONSTRAINT telegram_auth_ready_check CHECK (
    status = 'pending' OR (telegram_id IS NOT NULL AND confirmed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS telegram_auth_codes_expires_idx
  ON telegram_auth_codes (expires_at);

