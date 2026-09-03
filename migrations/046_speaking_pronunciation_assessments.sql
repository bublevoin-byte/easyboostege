CREATE TABLE IF NOT EXISTS speaking_pronunciation_assessments (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  idempotency_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status VARCHAR(16) NOT NULL CHECK (status IN ('reserved', 'dispatching', 'started', 'finalized', 'released')),
  locale VARCHAR(5) NOT NULL CHECK (locale IN ('en-GB', 'en-US')),
  period_start TIMESTAMPTZ NOT NULL,
  allowance_seconds INTEGER NOT NULL CHECK (allowance_seconds IN (3600, 14400)),
  reserved_seconds INTEGER NOT NULL CHECK (reserved_seconds BETWEEN 1 AND 180),
  billable_seconds INTEGER CHECK (billable_seconds BETWEEN 0 AND reserved_seconds),
  reserved_at TIMESTAMPTZ NOT NULL,
  dispatch_started_at TIMESTAMPTZ,
  provider_started_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  release_reason VARCHAR(64),
  result JSONB,
  UNIQUE (username, idempotency_key),
  CHECK (period_start = date_trunc('month', period_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  CHECK (
    (status = 'reserved' AND billable_seconds IS NULL AND dispatch_started_at IS NULL
      AND provider_started_at IS NULL
      AND finalized_at IS NULL AND released_at IS NULL AND release_reason IS NULL AND result IS NULL)
    OR (status = 'dispatching' AND billable_seconds IS NULL AND dispatch_started_at IS NOT NULL
      AND provider_started_at IS NULL
      AND finalized_at IS NULL AND released_at IS NULL AND release_reason IS NULL AND result IS NULL)
    OR (status = 'started' AND billable_seconds IS NULL AND dispatch_started_at IS NOT NULL
      AND provider_started_at IS NOT NULL
      AND finalized_at IS NULL AND released_at IS NULL AND release_reason IS NULL AND result IS NULL)
    OR (status = 'finalized' AND billable_seconds IS NOT NULL AND dispatch_started_at IS NOT NULL
      AND finalized_at IS NOT NULL AND released_at IS NULL AND release_reason IS NULL AND result IS NOT NULL
      AND jsonb_typeof(result) = 'object')
    OR (status = 'released' AND billable_seconds = 0 AND provider_started_at IS NULL
      AND finalized_at IS NULL AND released_at IS NOT NULL AND release_reason IS NOT NULL
      AND result IS NOT NULL AND jsonb_typeof(result) = 'object')
  )
);

CREATE INDEX IF NOT EXISTS speaking_pronunciation_assessments_usage_idx
  ON speaking_pronunciation_assessments (username, period_start, status);
