CREATE TABLE IF NOT EXISTS privacy_consents (
  username VARCHAR(64) PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
  text_processing BOOLEAN NOT NULL DEFAULT FALSE,
  voice_processing BOOLEAN NOT NULL DEFAULT FALSE,
  policy_version VARCHAR(40) NOT NULL,
  text_consented_at TIMESTAMPTZ,
  voice_consented_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
