CREATE TABLE IF NOT EXISTS subscriptions (
  username VARCHAR(64) PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL CHECK (status IN ('active', 'expired', 'cancelled')),
  source VARCHAR(20) NOT NULL CHECK (source IN ('trial', 'manual')),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_requests (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'approved', 'rejected', 'cancelled')),
  actor_telegram_id BIGINT,
  result VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_requests_one_new_per_user_idx
  ON payment_requests (username) WHERE status = 'new';
CREATE INDEX IF NOT EXISTS payment_requests_user_created_idx
  ON payment_requests (username, created_at DESC);

INSERT INTO subscriptions (username, status, source, starts_at, ends_at)
SELECT username,
       CASE WHEN subscription_until > NOW() THEN 'active' ELSE 'expired' END,
       CASE WHEN trial_used THEN 'trial' ELSE 'manual' END,
       created_at,
       subscription_until
FROM users
WHERE subscription_until IS NOT NULL
ON CONFLICT (username) DO NOTHING;
