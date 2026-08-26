ALTER TABLE users
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS identity_managed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_identity_check;
ALTER TABLE users
  ADD CONSTRAINT users_identity_check CHECK (
    password_hash IS NOT NULL OR telegram_id IS NOT NULL OR identity_managed
  ),
  ADD CONSTRAINT users_managed_identity_shape CHECK (
    NOT identity_managed OR (password_hash IS NULL AND telegram_id IS NULL)
  );

CREATE TABLE IF NOT EXISTS learner_identities (
  provider VARCHAR(32) NOT NULL,
  subject VARCHAR(128) NOT NULL,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, subject),
  UNIQUE (username),
  CONSTRAINT learner_identities_provider_check CHECK (provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT learner_identities_subject_check CHECK (subject ~ '^[A-Za-z0-9._:-]{1,128}$')
);

CREATE TABLE IF NOT EXISTS oauth_auth_transactions (
  state_hash CHAR(64) PRIMARY KEY,
  provider VARCHAR(32) NOT NULL,
  verifier_sealed VARCHAR(1024),
  redirect_uri TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oauth_auth_transactions_state_check CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT oauth_auth_transactions_provider_check CHECK (provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT oauth_auth_transactions_verifier_lifecycle_check CHECK (
    (consumed_at IS NULL AND verifier_sealed IS NOT NULL)
    OR (consumed_at IS NOT NULL AND verifier_sealed IS NULL)
  ),
  CONSTRAINT oauth_auth_transactions_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS oauth_auth_transactions_expiry_idx
  ON oauth_auth_transactions (expires_at);
