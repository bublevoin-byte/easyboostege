ALTER TABLE speaking_pronunciation_assessments
  ADD COLUMN IF NOT EXISTS audio_hash CHAR(64)
  CHECK (audio_hash IS NULL OR audio_hash ~ '^[a-f0-9]{64}$');

CREATE TABLE IF NOT EXISTS speaking_accent_profiles (
  username VARCHAR(64) PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
  locale VARCHAR(5) NOT NULL CHECK (locale IN ('en-GB', 'en-US')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  source VARCHAR(16) NOT NULL CHECK (source IN ('manual', 'calibration')),
  effective_at TIMESTAMPTZ NOT NULL,
  calibration_used BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS speaking_accent_profile_history (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  locale VARCHAR(5) NOT NULL CHECK (locale IN ('en-GB', 'en-US')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  source VARCHAR(16) NOT NULL CHECK (source IN ('manual', 'calibration')),
  effective_at TIMESTAMPTZ NOT NULL,
  UNIQUE (username, revision)
);

CREATE TABLE IF NOT EXISTS speaking_accent_calibrations (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE REFERENCES users(username) ON DELETE CASCADE,
  status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  locale VARCHAR(5) CHECK (locale IN ('en-GB', 'en-US')),
  confidence VARCHAR(8) CHECK (confidence IN ('clear', 'close')),
  evidence_keys UUID[],
  policy_version VARCHAR(80),
  CHECK (
    (status = 'pending' AND completed_at IS NULL AND locale IS NULL AND confidence IS NULL
      AND evidence_keys IS NULL AND policy_version IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND locale IS NOT NULL
      AND confidence IS NOT NULL AND cardinality(evidence_keys) = 2 AND policy_version IS NOT NULL)
    OR (status = 'cancelled' AND completed_at IS NOT NULL AND locale IS NULL AND confidence IS NULL
      AND evidence_keys IS NULL AND policy_version IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS speaking_calibration_consents (
  username VARCHAR(64) PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
  granted BOOLEAN NOT NULL,
  age_group VARCHAR(8) NOT NULL CHECK (age_group IN ('adult', 'minor')),
  guardian_confirmed BOOLEAN NOT NULL,
  policy_version VARCHAR(80) NOT NULL,
  granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK ((granted AND granted_at IS NOT NULL AND revoked_at IS NULL)
    OR (NOT granted AND granted_at IS NULL AND revoked_at IS NOT NULL)),
  CHECK (age_group = 'minor' OR guardian_confirmed = FALSE),
  CHECK (NOT granted OR age_group = 'adult' OR guardian_confirmed = TRUE)
);

CREATE TABLE IF NOT EXISTS speaking_calibration_samples (
  id UUID PRIMARY KEY,
  username VARCHAR(64) REFERENCES users(username) ON DELETE SET NULL,
  assessment_key UUID,
  task_type SMALLINT NOT NULL CHECK (task_type BETWEEN 1 AND 4),
  task_ref VARCHAR(300) NOT NULL CHECK (task_ref ~ '^[a-zA-Z0-9:@._-]+$'),
  locale VARCHAR(5) NOT NULL CHECK (locale IN ('en-GB', 'en-US')),
  maximum_score SMALLINT NOT NULL CHECK (
    (task_type = 1 AND maximum_score = 1)
    OR (task_type = 2 AND maximum_score = 4)
    OR (task_type = 3 AND maximum_score = 5)
    OR (task_type = 4 AND maximum_score = 10)
  ),
  task_snapshot JSONB NOT NULL CHECK (
    jsonb_typeof(task_snapshot) = 'object' AND octet_length(task_snapshot::text) <= 32768
  ),
  rubric_snapshot JSONB NOT NULL CHECK (
    jsonb_typeof(rubric_snapshot) = 'object' AND octet_length(rubric_snapshot::text) <= 4096
  ),
  status VARCHAR(24) NOT NULL CHECK (status IN (
    'awaiting_reviews', 'adjudication_pending', 'completed', 'consent_revoked', 'expired'
  )),
  audio BYTEA,
  reviews JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reviews) = 'array'),
  access_audit JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(access_audit) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  raw_deleted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK (expires_at = created_at + INTERVAL '180 days'),
  CHECK ((audio IS NOT NULL AND raw_deleted_at IS NULL AND status IN ('awaiting_reviews', 'adjudication_pending'))
    OR (audio IS NULL AND raw_deleted_at IS NOT NULL AND status IN ('completed', 'consent_revoked', 'expired'))),
  CHECK (username IS NOT NULL OR (status = 'completed' AND audio IS NULL AND assessment_key IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS speaking_calibration_samples_owner_assessment_uidx
  ON speaking_calibration_samples (username, assessment_key)
  WHERE username IS NOT NULL AND assessment_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS speaking_calibration_samples_queue_idx
  ON speaking_calibration_samples (status, created_at)
  WHERE audio IS NOT NULL;

ALTER TABLE speaking_task1_sessions
  ADD COLUMN IF NOT EXISTS accent_locale VARCHAR(5),
  ADD COLUMN IF NOT EXISTS accent_profile_revision INTEGER,
  ADD COLUMN IF NOT EXISTS accent_effective_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS calibration_setup_id UUID REFERENCES speaking_accent_calibrations(id) ON DELETE SET NULL;
ALTER TABLE speaking_task2_sessions
  ADD COLUMN IF NOT EXISTS accent_locale VARCHAR(5),
  ADD COLUMN IF NOT EXISTS accent_profile_revision INTEGER,
  ADD COLUMN IF NOT EXISTS accent_effective_at TIMESTAMPTZ;
ALTER TABLE speaking_task3_sessions
  ADD COLUMN IF NOT EXISTS accent_locale VARCHAR(5),
  ADD COLUMN IF NOT EXISTS accent_profile_revision INTEGER,
  ADD COLUMN IF NOT EXISTS accent_effective_at TIMESTAMPTZ;
ALTER TABLE speaking_task4_sessions
  ADD COLUMN IF NOT EXISTS accent_locale VARCHAR(5),
  ADD COLUMN IF NOT EXISTS accent_profile_revision INTEGER,
  ADD COLUMN IF NOT EXISTS accent_effective_at TIMESTAMPTZ;
ALTER TABLE speaking_full_sessions
  ADD COLUMN IF NOT EXISTS accent_locale VARCHAR(5),
  ADD COLUMN IF NOT EXISTS accent_profile_revision INTEGER,
  ADD COLUMN IF NOT EXISTS accent_effective_at TIMESTAMPTZ;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'speaking_task1_sessions', 'speaking_task2_sessions', 'speaking_task3_sessions',
    'speaking_task4_sessions', 'speaking_full_sessions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', table_name, table_name || '_accent_snapshot_check');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK ((accent_locale IS NULL AND accent_profile_revision IS NULL AND accent_effective_at IS NULL) OR (accent_locale IN (''en-GB'', ''en-US'') AND accent_profile_revision >= 1 AND accent_effective_at IS NOT NULL))',
      table_name, table_name || '_accent_snapshot_check'
    );
  END LOOP;
END $$;

ALTER TABLE speaking_task1_sessions
  DROP CONSTRAINT IF EXISTS speaking_task1_sessions_calibration_setup_check;
ALTER TABLE speaking_task1_sessions
  ADD CONSTRAINT speaking_task1_sessions_calibration_setup_check CHECK (
    calibration_setup_id IS NULL OR (
      accent_locale IS NULL
      AND accent_profile_revision IS NULL
      AND accent_effective_at IS NULL
    )
  );
