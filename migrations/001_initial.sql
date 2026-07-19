CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  username VARCHAR(64) PRIMARY KEY,
  password_hash TEXT,
  telegram_id BIGINT UNIQUE,
  trial_used BOOLEAN NOT NULL DEFAULT FALSE,
  subscription_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_identity_check CHECK (password_hash IS NOT NULL OR telegram_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS user_progress (
  username VARCHAR(64) PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscription_events (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  event_type VARCHAR(40) NOT NULL,
  days INTEGER,
  actor_telegram_id BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS writing_attempts (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  task_type VARCHAR(20) NOT NULL CHECK (task_type IN ('writing_37', 'writing_38')),
  assignment JSONB NOT NULL,
  answer TEXT NOT NULL,
  review JSONB,
  provider VARCHAR(40),
  prompt_version VARCHAR(40),
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evaluated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS writing_attempts_user_created_idx
  ON writing_attempts (username, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_requests (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(64) REFERENCES users(username) ON DELETE SET NULL,
  operation VARCHAR(60) NOT NULL,
  provider VARCHAR(40),
  model VARCHAR(100),
  prompt_version VARCHAR(40),
  status VARCHAR(30) NOT NULL,
  duration_ms INTEGER,
  error_code VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_requests_user_created_idx
  ON ai_requests (username, created_at DESC);

