CREATE TABLE IF NOT EXISTS ege_mock_attempts (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  owner_generation VARCHAR(80) NOT NULL,
  policy_id VARCHAR(40) NOT NULL CHECK (policy_id = 'ege-mock-attempt-policy-v1'),
  form_id VARCHAR(80) NOT NULL,
  form_revision INTEGER NOT NULL CHECK (form_revision > 0),
  exam_year INTEGER NOT NULL CHECK (exam_year BETWEEN 2026 AND 2100),
  catalog_fingerprint VARCHAR(71) NOT NULL CHECK (catalog_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  mode VARCHAR(20) NOT NULL CHECK (mode IN ('diagnostic', 'training')),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  state VARCHAR(30) NOT NULL CHECK (state IN (
    'created', 'written_in_progress', 'written_submitted', 'oral_ready',
    'oral_in_progress', 'assessment_pending', 'completed', 'expired'
  )),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  draft JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(draft) = 'object' AND octet_length(draft::text) <= 101000
  ),
  written_started_at TIMESTAMPTZ NOT NULL,
  written_deadline_at TIMESTAMPTZ NOT NULL,
  written_submitted_at TIMESTAMPTZ,
  written_receipt JSONB,
  oral_available_until TIMESTAMPTZ,
  oral_started_at TIMESTAMPTZ,
  oral_deadline_at TIMESTAMPTZ,
  oral_submitted_at TIMESTAMPTZ,
  oral_recordings JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(oral_recordings) = 'object'),
  oral_receipt JSONB,
  assessment_status VARCHAR(30) NOT NULL DEFAULT 'not_started' CHECK (
    assessment_status IN ('not_started', 'pending', 'retryable', 'completed')
  ),
  assessment_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (assessment_retry_count BETWEEN 0 AND 3),
  assessment_error_code VARCHAR(64),
  result JSONB,
  start_idempotency_key UUID NOT NULL,
  start_request_hash CHAR(64) NOT NULL CHECK (start_request_hash ~ '^[0-9a-f]{64}$'),
  start_response_attempt JSONB NOT NULL CHECK (jsonb_typeof(start_response_attempt) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (username, start_idempotency_key),
  UNIQUE (username, form_id, form_revision, attempt_number),
  CHECK (written_deadline_at = written_started_at + INTERVAL '190 minutes'),
  CHECK (oral_available_until IS NULL
    OR oral_available_until = written_submitted_at + INTERVAL '30 days'),
  CHECK (oral_deadline_at IS NULL OR oral_deadline_at = oral_started_at + INTERVAL '17 minutes')
);

CREATE UNIQUE INDEX IF NOT EXISTS ege_mock_one_active_form_idx
  ON ege_mock_attempts (username, form_id, form_revision)
  WHERE state NOT IN ('assessment_pending', 'completed', 'expired');

CREATE INDEX IF NOT EXISTS ege_mock_attempts_owner_created_idx
  ON ege_mock_attempts (username, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ege_mock_mutations (
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  idempotency_key UUID NOT NULL,
  operation VARCHAR(30) NOT NULL CHECK (operation IN (
    'start', 'draft', 'written_submit', 'oral_start', 'oral_submit', 'assessment_retry'
  )),
  attempt_id UUID NOT NULL REFERENCES ege_mock_attempts(id) ON DELETE CASCADE,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_snapshot JSONB NOT NULL CHECK (jsonb_typeof(response_snapshot) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (username, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ege_mock_mutations_attempt_idx
  ON ege_mock_mutations (attempt_id, created_at);
