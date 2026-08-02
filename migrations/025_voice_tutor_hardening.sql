ALTER TABLE voice_tutor_sessions
  ADD COLUMN IF NOT EXISTS provider VARCHAR(120),
  ADD COLUMN IF NOT EXISTS model VARCHAR(120),
  ADD COLUMN IF NOT EXISTS prompt_version VARCHAR(120),
  ADD COLUMN IF NOT EXISTS voice_activated_at TIMESTAMPTZ;

ALTER TABLE voice_tutor_sessions DROP CONSTRAINT IF EXISTS voice_tutor_provider_metadata;
ALTER TABLE voice_tutor_sessions ADD CONSTRAINT voice_tutor_provider_metadata CHECK (
  (provider IS NULL OR provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$') AND
  (model IS NULL OR model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$') AND
  (prompt_version IS NULL OR prompt_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$')
);

ALTER TABLE voice_tutor_sessions DROP CONSTRAINT IF EXISTS voice_tutor_activation_window;
ALTER TABLE voice_tutor_sessions ADD CONSTRAINT voice_tutor_activation_window CHECK (
  voice_activated_at IS NULL OR (voice_activated_at >= started_at AND voice_activated_at < expires_at)
);

ALTER TABLE trusted_rule_cards DROP CONSTRAINT IF EXISTS trusted_rule_cards_created_for_username_fkey;
ALTER TABLE trusted_rule_cards
  ADD CONSTRAINT trusted_rule_cards_created_for_username_fkey
  FOREIGN KEY (created_for_username) REFERENCES users(username) ON DELETE SET NULL;
